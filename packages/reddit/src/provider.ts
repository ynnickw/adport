import {
  AdportError,
  resolveDateRange,
  type Account,
  type AdProvider,
  type MetricName,
  type NormalizedQuery,
  type ProviderCapabilities,
  type Report,
  type ReportRow,
  type StandardActions,
  type WriteGuard,
  type WriteOperation,
  type WritePreview,
  type WriteResult,
} from '@adport/core';
import { RedditAdsClient, type RedditEnvelope } from './client.js';
import { createCampaign, redditId, setCampaignBudget, setCampaignStatus } from './schemas.js';

/** Reddit budget, bid, spend, CPC, and CPM fields are integer micros. */
export const REDDIT_MICROS = 1_000_000;

interface RedditBusiness { id: string; name?: string }
interface RedditAdAccount {
  id: string;
  name?: string;
  currency?: string;
  admin_approval?: string;
  suspension_reason?: string;
}
export interface RedditCampaign {
  id: string;
  ad_account_id: string;
  name: string;
  configured_status: string;
  effective_status?: string;
  objective?: string;
  funding_instrument_id?: string;
  goal_type?: string;
  goal_value?: number;
  spend_cap?: number;
  is_campaign_budget_optimization?: boolean;
}

interface WritePlan {
  summary: string;
  changes: string[];
  coercions: string[];
  budgetDeltas: WritePreview['budgetDeltas'];
  execute: () => Promise<string[]>;
}

// Reddit v3 request enums are uppercase even though response object keys are lowercase.
const BREAKDOWN = { account: undefined, campaign: 'CAMPAIGN_ID', ad_group: 'AD_GROUP_ID', ad: 'AD_ID' } as const;

export class RedditAdsProvider implements AdProvider {
  readonly id = 'reddit';

  constructor(private readonly client: RedditAdsClient) {}

  capabilities(): ProviderCapabilities {
    return { serverDryRun: false };
  }

  standardActions(): StandardActions {
    return {
      pauseCampaign: (accountId, campaignId) => ({
        tool: 'reddit_set_campaign_status',
        input: { account_id: accountId, campaign_id: campaignId, configured_status: 'PAUSED' },
      }),
    };
  }

  async listAccounts(): Promise<Account[]> {
    const businesses = await this.client.getPaged<RedditBusiness>('me/businesses', { 'page.size': 100 }, 1000);
    const byId = new Map<string, RedditAdAccount>();
    for (const business of businesses) {
      const accounts = await this.client.getPaged<RedditAdAccount>(
        `businesses/${encodeURIComponent(business.id)}/ad_accounts`,
        { 'page.size': 100 },
        1000,
      );
      for (const account of accounts) byId.set(account.id, account);
    }
    return [...byId.values()].map((account) => ({
      provider: this.id,
      id: account.id,
      name: account.name ?? account.id,
      currency: account.currency,
      status: account.suspension_reason ? `SUSPENDED:${account.suspension_reason}` : account.admin_approval,
    }));
  }

  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const accountIds = query.accountIds ?? (await this.listAccounts()).map((account) => account.id);
    const rows: ReportRow[] = [];
    const limit = query.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'reddit: report limit must be a positive safe integer');
    let truncated = false;
    for (const accountId of accountIds) {
      if (rows.length >= limit) { truncated = true; break; }
      const breakdown = BREAKDOWN[query.level];
      const body = {
        data: {
          ...(breakdown ? { breakdowns: [breakdown] } : {}),
          fields: [
            'SPEND',
            'IMPRESSIONS',
            'CLICKS',
            'CONVERSION_PURCHASE_CLICKS',
            'CONVERSION_PURCHASE_VIEWS',
            'CONVERSION_PURCHASE_TOTAL_VALUE',
          ],
          starts_at: `${range.start}T00:00:00Z`,
          // The v3 schema accepts hourly granularity only. Midnight on the
          // following day keeps an inclusive Adport date range intact.
          ends_at: `${nextDay(range.end)}T00:00:00Z`,
          time_zone_id: 'UTC',
        },
      };
      const page = await this.fetchReportPages(accountId, body, limit - rows.length);
      for (const metric of page.metrics) rows.push(this.toReportRow(metric, accountId, query, breakdown?.toLowerCase()));
      truncated ||= page.truncated;
    }
    return { rows, ...(truncated ? { truncated: true } : {}) };
  }

  async rawReport(input: {
    account_id: string;
    breakdowns?: string[];
    fields: string[];
    starts_at: string;
    ends_at: string;
    time_zone_id?: string;
    filter?: string;
    page_size?: number;
  }): Promise<{ metrics: Array<Record<string, unknown>>; metrics_updated_at?: string; truncated: boolean }> {
    const body = {
      data: {
        ...(input.breakdowns?.length ? { breakdowns: input.breakdowns.map(value => value.toUpperCase()) } : {}),
        fields: input.fields.map(value => value.toUpperCase()),
        starts_at: input.starts_at,
        ends_at: input.ends_at,
        time_zone_id: input.time_zone_id ?? 'UTC',
        ...(input.filter ? { filter: input.filter } : {}),
      },
    };
    return this.fetchReportPages(input.account_id, body, input.page_size ?? 200);
  }

  async apiRead(input: {
    account_id: string;
    path: string;
    method?: 'GET' | 'POST';
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
    limit?: number;
  }): Promise<unknown> {
    const path = validateRedditPath(input.path);
    assertReadScoped(path, input.account_id);
    if (input.method === 'POST') {
      if (!/(?:\/reports|\/history|\/query|\/search)$/.test(path)) {
        throw new AdportError('INVALID_INPUT', 'reddit: read-only POST is limited to documented reports, history, query, and search endpoints');
      }
      return this.client.post(path, input.body ?? {});
    }
    if (!path.startsWith(`ad_accounts/${input.account_id}/`) && path !== `ad_accounts/${input.account_id}`) {
      // A global resource ID alone never proves account authorization.
      await this.assertOwnedResource(path, input.account_id);
    }
    if (input.limit) return this.client.getPaged(path, input.params, input.limit);
    return this.client.get(path, input.params);
  }

  async listCampaigns(accountId: string, ids?: string[]): Promise<RedditCampaign[]> {
    return this.client.getPaged<RedditCampaign>(
      `ad_accounts/${encodeURIComponent(accountId)}/campaigns`,
      { ...(ids?.length ? { id: ids } : {}), 'page.size': Math.min(ids?.length ?? 100, 100) },
      ids?.length ?? 1000,
    );
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const plan = await this.plan(op, guard);
    return {
      summary: plan.summary,
      changes: plan.changes,
      coercions: plan.coercions,
      budgetDeltas: plan.budgetDeltas,
      serverValidated: false,
    };
  }

  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    const plan = await this.plan(op, guard);
    return { applied: true, resourceIds: await plan.execute() };
  }

  private async fetchReportPages(
    accountId: string,
    body: Record<string, unknown>,
    limit: number,
  ): Promise<{ metrics: Array<Record<string, unknown>>; metrics_updated_at?: string; truncated: boolean }> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'reddit: report limit must be a positive safe integer');
    const path = `ad_accounts/${encodeURIComponent(accountId)}/reports?page.size=${Math.min(limit, 1000)}`;
    const rows: Array<Record<string, unknown>> = [], seen = new Set<string>();
    let url = this.client.nextUrl(path, path), updatedAt: string | undefined;
    while (true) {
      if (seen.has(url) || seen.size >= 1000) throw new AdportError('PROVIDER_ERROR', 'reddit: report pagination did not terminate');
      seen.add(url);
      // The current v3 report operation is POST-only, including next_url pages.
      const page = await this.client.post<{ metrics?: Array<Record<string, unknown>>; metrics_updated_at?: string }>(url, body);
      if (!isRecord(page.data) || !Array.isArray(page.data.metrics) || page.data.metrics.some(row => !isRecord(row))) throw new AdportError('PROVIDER_ERROR', 'reddit: malformed report metrics');
      rows.push(...page.data.metrics);
      if (updatedAt === undefined && typeof page.data.metrics_updated_at === 'string') updatedAt = page.data.metrics_updated_at;
      const next = page.pagination?.next_url;
      if (rows.length >= limit || !next) return { metrics: rows.slice(0, limit), truncated: rows.length > limit || Boolean(next), ...(updatedAt ? { metrics_updated_at: updatedAt } : {}) };
      url = this.client.nextUrl(next, path);
    }
  }

  private toReportRow(
    raw: Record<string, unknown>,
    accountId: string,
    query: NormalizedQuery,
    breakdown?: string,
  ): ReportRow {
    const value = (key: string) => { const v = raw[key]; if (v === null || v === undefined || v === '' || !['number', 'string'].includes(typeof v)) return undefined; const number = Number(v); if (!Number.isFinite(number)) throw new AdportError('PROVIDER_ERROR', `reddit: invalid numeric report field ${key}`); return number; };
    const all: Partial<Record<MetricName, number>> = {};
    for (const [metric, field, divisor] of [['spend', 'spend', REDDIT_MICROS], ['impressions', 'impressions', 1], ['clicks', 'clicks', 1], ['conversion_value', 'conversion_purchase_total_value', 100]] as const) { const v = value(field); if (v !== undefined) all[metric] = v / divisor; }
    const clickConversions = value('conversion_purchase_clicks'), viewConversions = value('conversion_purchase_views');
    if (clickConversions !== undefined && viewConversions !== undefined) all.conversions = clickConversions + viewConversions;
    for (const [metric, numerator, denominator, factor] of [['ctr', 'clicks', 'impressions', 100], ['cpc', 'spend', 'clicks', 1], ['cpm', 'spend', 'impressions', 1000], ['cpa', 'spend', 'conversions', 1], ['roas', 'conversion_value', 'spend', 1]] as const) if (all[numerator] !== undefined && all[denominator] !== undefined) all[metric] = all[denominator] ? all[numerator]! / all[denominator]! * factor : 0;
    const entityId = breakdown ? String(raw[breakdown] ?? '') : accountId;
    if (!entityId) throw new AdportError('PROVIDER_ERROR', 'reddit: report row is missing its requested entity breakdown');
    return {
      provider: this.id,
      accountId,
      entity: { level: query.level, id: entityId, name: entityId },
      metrics: Object.fromEntries(query.metrics.filter(metric => all[metric] !== undefined).map(metric => [metric, all[metric]])),
    };
  }

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<WritePlan> {
    redditId.parse(op.accountId);
    const expectedKind = op.tool === 'reddit_api_delete' ? 'remove' : op.tool === 'reddit_create_campaign' || op.tool === 'reddit_api_create' ? 'create' : 'update';
    if (op.provider !== this.id || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'reddit: provider or operation kind mismatch');
    const payload = op.payload as never;
    switch (op.tool) {
      case 'reddit_create_campaign': return this.planCreateCampaign(op.accountId, createCampaign.parse(op.payload), guard);
      case 'reddit_set_campaign_status': return this.planSetStatus(op.accountId, setCampaignStatus.parse(op.payload));
      case 'reddit_set_budget': return this.planSetBudget(op.accountId, setCampaignBudget.parse(op.payload));
      case 'reddit_api_create': return this.planApiCreate(op.accountId, payload, guard);
      case 'reddit_api_update': return this.planApiUpdate(op.accountId, payload);
      case 'reddit_api_delete': return this.planApiDelete(op.accountId, payload);
      default: throw new AdportError('PROVIDER_ERROR', `reddit: unsupported write tool ${op.tool}`);
    }
  }

  private async planCreateCampaign(
    accountId: string,
    payload: {
      name: string;
      objective: string;
      funding_instrument_id: string;
      configured_status?: 'ACTIVE' | 'PAUSED';
      budget_micros?: number;
      budget_type?: 'DAILY_SPEND' | 'LIFETIME_SPEND';
      conversion_pixel_id?: string;
      spend_cap_micros?: number;
    },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    if (payload.budget_micros && !payload.conversion_pixel_id) {
      throw new AdportError('INVALID_INPUT', 'reddit: conversion_pixel_id is required for CBO campaigns (effective July 13, 2026)');
    }
    const requested = payload.configured_status ?? 'PAUSED';
    const status = guard.forcePausedCreation ? 'PAUSED' : requested;
    const coercions = requested !== status
      ? ['configured_status coerced to PAUSED by policy (paused_creation)']
      : [];
    const data: Record<string, unknown> = {
      name: payload.name,
      configured_status: status,
      objective: payload.objective,
      funding_instrument_id: payload.funding_instrument_id,
      is_campaign_budget_optimization: payload.budget_micros !== undefined,
      ...(payload.budget_micros ? {
        goal_type: payload.budget_type ?? 'DAILY_SPEND',
        goal_value: payload.budget_micros,
        conversion_pixel_id: payload.conversion_pixel_id,
      } : {}),
      ...(payload.spend_cap_micros ? { spend_cap: payload.spend_cap_micros } : {}),
    };
    const budgetDeltas: WritePreview['budgetDeltas'] = [];
    if (payload.budget_micros) budgetDeltas.push({ target: `new campaign "${payload.name}" budget`, toMicros: payload.budget_micros });
    if (payload.spend_cap_micros) budgetDeltas.push({ target: `new campaign "${payload.name}" spend cap`, toMicros: payload.spend_cap_micros });
    return {
      summary: `Create Reddit campaign "${payload.name}" (${payload.objective}, ${status.toLowerCase()})`,
      changes: [`+ POST /ad_accounts/${accountId}/campaigns ${JSON.stringify({ data })}`],
      coercions,
      budgetDeltas,
      execute: async () => verifyReceipt(await this.client.post<RedditCampaign>(`ad_accounts/${encodeURIComponent(accountId)}/campaigns`, { data }), accountId, data),
    };
  }

  private async planSetStatus(
    accountId: string,
    payload: { campaign_id: string; configured_status: 'ACTIVE' | 'PAUSED' },
  ): Promise<WritePlan> {
    const campaign = await this.getOwnedCampaign(accountId, payload.campaign_id);
    return {
      summary: `Set Reddit campaign "${campaign.name}" → ${payload.configured_status.toLowerCase()}`,
      changes: [`~ campaign ${campaign.id} configured_status ${campaign.configured_status} → ${payload.configured_status}`],
      coercions: [], budgetDeltas: [],
      execute: async () => verifyReceipt(await this.client.patch<RedditCampaign>(`campaigns/${encodeURIComponent(campaign.id)}`, {
        data: { configured_status: payload.configured_status },
      }), accountId, { id: campaign.id, configured_status: payload.configured_status }),
    };
  }

  private async planSetBudget(
    accountId: string,
    payload: { campaign_id: string; budget_micros: number; budget_type?: 'DAILY_SPEND' | 'LIFETIME_SPEND' },
  ): Promise<WritePlan> {
    const campaign = await this.getOwnedCampaign(accountId, payload.campaign_id);
    if (!campaign.is_campaign_budget_optimization) {
      throw new AdportError('INVALID_INPUT', `reddit: campaign "${campaign.name}" is not a CBO campaign; budget its ad groups instead`);
    }
    if (!['DAILY_SPEND', 'LIFETIME_SPEND'].includes(String(campaign.goal_type)) || !Number.isSafeInteger(campaign.goal_value) || Number(campaign.goal_value) < 0) throw new AdportError('INVALID_INPUT', 'reddit: current CBO budget/type is unavailable');
    if (payload.budget_type && payload.budget_type !== campaign.goal_type) throw new AdportError('INVALID_INPUT', 'reddit: campaign budget type is immutable; the existing type must be preserved');
    return {
      summary: `Change Reddit campaign "${campaign.name}" budget ${campaign.goal_value ?? '?'} → ${payload.budget_micros} micros`,
      changes: [`~ campaign ${campaign.id} ${campaign.goal_type ?? 'goal'} ${campaign.goal_value ?? '?'} → ${payload.budget_micros}`],
      coercions: [],
      budgetDeltas: [{ target: `campaign "${campaign.name}" budget`, fromMicros: campaign.goal_value, toMicros: payload.budget_micros }],
      execute: async () => verifyReceipt(await this.client.patch<RedditCampaign>(`campaigns/${encodeURIComponent(campaign.id)}`, {
        data: { goal_value: payload.budget_micros },
      }), accountId, { id: campaign.id, goal_value: payload.budget_micros }),
    };
  }

  private async planApiCreate(
    accountId: string,
    payload: { path: string; body: Record<string, unknown> },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const path = validateRedditPath(payload.path);
    if (!new Set(['campaigns', 'ad_groups', 'ads', 'custom_audiences', 'saved_audiences']).has(path.split('/')[2] ?? '') || path.split('/').length !== 3 || !path.startsWith(`ad_accounts/${accountId}/`)) {
      throw new AdportError('INVALID_INPUT', 'reddit: create path must be under the selected ad account');
    }
    const body = structuredClone(payload.body);
    if (!isRecord(body.data)) throw new AdportError('INVALID_INPUT', 'reddit: native create requires one data object');
    if (body.data.ad_account_id !== undefined && body.data.ad_account_id !== accountId) throw new AdportError('INVALID_INPUT', 'reddit: create body account differs from the selected account');
    if (path.endsWith('/ad_groups')) {
      if (typeof body.data.campaign_id !== 'string') throw new AdportError('INVALID_INPUT', 'reddit: ad-group creation requires campaign_id');
      await this.getOwnedCampaign(accountId, body.data.campaign_id);
    }
    if (path.endsWith('/ads')) {
      if (typeof body.data.ad_group_id !== 'string') throw new AdportError('INVALID_INPUT', 'reddit: ad creation requires ad_group_id');
      const group = (await this.client.get<Record<string, unknown>>(`ad_groups/${encodeURIComponent(body.data.ad_group_id)}`)).data;
      if (!isRecord(group) || group.id !== body.data.ad_group_id || group.ad_account_id !== accountId || typeof group.campaign_id !== 'string') throw new AdportError('INVALID_INPUT', 'reddit: ad-group parent ownership mismatch');
      await this.getOwnedCampaign(accountId, group.campaign_id);
    }
    const coercions: string[] = [];
    if (guard.forcePausedCreation) {
      coerceCreatedStatuses(body, coercions, /\/(?:campaigns|ad_groups|ads)$/.test(path));
    }
    return {
      summary: `Create Reddit resource via /${path}`,
      changes: [`+ POST /${path} ${JSON.stringify(body)}`],
      coercions,
      budgetDeltas: collectMicros(body),
      execute: async () => verifyReceipt(await this.client.post(path, body), accountId, body.data as Record<string, unknown>),
    };
  }

  private async planApiUpdate(
    accountId: string,
    payload: { path: string; body: Record<string, unknown> },
  ): Promise<WritePlan> {
    const path = validateRedditPath(payload.path);
    await this.assertOwnedResource(path, accountId);
    if (containsMoney(payload.body)) {
      throw new AdportError('INVALID_INPUT', 'reddit: budget, bid, goal, and spend-cap updates require a typed budget tool for policy checks');
    }
    if (!isRecord(payload.body.data)) throw new AdportError('INVALID_INPUT', 'reddit: native update requires one data object');
    return {
      summary: `Update Reddit resource via /${path}`,
      changes: [`~ PATCH /${path} ${JSON.stringify(payload.body)}`],
      coercions: [], budgetDeltas: [],
      execute: async () => verifyReceipt(await this.client.patch(path, payload.body), accountId, { ...payload.body.data as Record<string, unknown>, id: path.split('/').at(-1) }),
    };
  }

  private async planApiDelete(accountId: string, payload: { path: string }): Promise<WritePlan> {
    const path = validateRedditPath(payload.path);
    await this.assertOwnedResource(path, accountId);
    return {
      summary: `Permanently delete Reddit resource via /${path}`,
      changes: [`- DELETE /${path}`],
      coercions: [], budgetDeltas: [],
      execute: async () => {
        const result = await this.client.delete(path), ids = extractIds(result), expected = path.split('/').at(-1)!;
        if (ids.length && (ids.length !== 1 || ids[0] !== expected)) throw new AdportError('PROVIDER_ERROR', 'reddit: deletion receipt ID mismatch; reconcile before retrying', { resource_ids: ids });
        return [expected];
      },
    };
  }

  private async getOwnedCampaign(accountId: string, campaignId: string): Promise<RedditCampaign> {
    const campaign = (await this.client.get<RedditCampaign>(`campaigns/${encodeURIComponent(campaignId)}`)).data;
    if (!campaign || campaign.id !== campaignId || campaign.ad_account_id !== accountId) {
      throw new AdportError('INVALID_INPUT', `reddit: campaign ${campaignId} does not belong to selected account ${accountId}`);
    }
    return campaign;
  }

  private async assertOwnedResource(path: string, accountId: string): Promise<void> {
    const resource = (await this.client.get<Record<string, unknown>>(path)).data;
    if (String(resource.ad_account_id ?? '') !== accountId) {
      throw new AdportError('INVALID_INPUT', `reddit: /${path} does not prove ownership by selected account ${accountId}`);
    }
  }
}

function nextDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function validateRedditPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, '').trim();
  if (!/^[A-Za-z0-9_.~/-]{3,220}$/.test(normalized) || normalized.includes('..') || normalized.includes('//')) {
    throw new AdportError('INVALID_INPUT', `reddit: invalid Ads API v3 path "${path}"`);
  }
  return normalized;
}

function assertReadScoped(path: string, accountId: string): void {
  if (path === `ad_accounts/${accountId}` || path.startsWith(`ad_accounts/${accountId}/`)) return;
  if (/^(campaigns|ad_groups|ads|structured_posts)\/[^/]+$/.test(path)) return;
  throw new AdportError('INVALID_INPUT', 'reddit: read path must be selected-account scoped or a single campaign/ad-group/ad/post resource');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceCreatedStatuses(value: Record<string, unknown>, coercions: string[], statusBearingPath: boolean): void {
  const data = isRecord(value.data) ? value.data : value;
  const visit = (item: unknown, path = 'body'): void => {
    if (Array.isArray(item)) return item.forEach((child, index) => visit(child, `${path}[${index}]`));
    if (!isRecord(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (key === 'configured_status' && child !== 'PAUSED') {
        item[key] = 'PAUSED';
        coercions.push(`${path}.${key} coerced to PAUSED by policy (paused_creation)`);
      } else visit(child, `${path}.${key}`);
    }
  };
  visit(value);
  if (statusBearingPath && data.configured_status === undefined) {
    data.configured_status = 'PAUSED';
    coercions.push('body.data.configured_status set to PAUSED by policy (paused_creation)');
  }
}

const MONEY_KEY = /(?:goal_value|spend_cap|bid_value|budget(?:_micros)?|daily_budget|lifetime_budget)$/i;

function containsMoney(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMoney);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => MONEY_KEY.test(key) || containsMoney(child));
}

function collectMicros(value: unknown, path = 'body'): WritePreview['budgetDeltas'] {
  if (Array.isArray(value)) return value.flatMap((child, index) => collectMicros(child, `${path}[${index}]`));
  if (!isRecord(value)) return [];
  const deltas: WritePreview['budgetDeltas'] = [];
  for (const [key, child] of Object.entries(value)) {
    if (MONEY_KEY.test(key) && child !== null) {
      if (typeof child !== 'number' || !Number.isSafeInteger(child) || child < 0) throw new AdportError('INVALID_INPUT', 'reddit: native monetary create fields must be non-negative safe integer micros');
      deltas.push({ target: `${path}.${key}`, toMicros: Number(child) });
    }
    deltas.push(...collectMicros(child, `${path}.${key}`));
  }
  return deltas;
}

function extractIds(envelope: RedditEnvelope<unknown>): string[] {
  const rows = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
  return rows.filter(isRecord).flatMap(row => typeof row.id === 'string' ? [row.id] : []);
}
function verifyReceipt(envelope: RedditEnvelope<unknown>, account: string, expected: Record<string, unknown>): string[] {
  const ids = extractIds(envelope), row = envelope.data;
  const keys = ['id', 'name', 'configured_status', 'goal_value', 'goal_type', 'spend_cap', 'bid_value', 'campaign_id', 'ad_group_id', 'post_id', 'objective', 'is_campaign_budget_optimization'];
  if (!isRecord(row) || ids.length !== 1 || row.ad_account_id !== account || keys.some(key => expected[key] !== undefined && row[key] !== expected[key])) throw new AdportError('PROVIDER_ERROR', 'reddit: mutation receipt ID/account/status/money mismatch; reconcile before retrying', { resource_ids: ids });
  return ids;
}
