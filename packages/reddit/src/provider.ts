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

const BREAKDOWN = { account: undefined, campaign: 'campaign_id', ad_group: 'ad_group_id', ad: 'ad_id' } as const;

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
    for (const accountId of accountIds) {
      const breakdown = BREAKDOWN[query.level];
      const body = {
        data: {
          ...(breakdown ? { breakdowns: [breakdown] } : {}),
          fields: [
            'spend',
            'impressions',
            'clicks',
            'conversion_purchase_clicks',
            'conversion_purchase_views',
            'conversion_purchase_total_value',
          ],
          starts_at: `${range.start}T00:00:00Z`,
          ends_at: `${range.end}T23:59:59Z`,
          time_zone_id: 'UTC',
        },
      };
      const metrics = await this.fetchReportPages(accountId, body, query.limit ?? 1000);
      for (const metric of metrics) rows.push(this.toReportRow(metric, accountId, query, breakdown));
    }
    return { rows };
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
  }): Promise<{ metrics: Array<Record<string, unknown>>; metrics_updated_at?: string }> {
    const body = {
      data: {
        ...(input.breakdowns?.length ? { breakdowns: input.breakdowns } : {}),
        fields: input.fields,
        starts_at: input.starts_at,
        ends_at: input.ends_at,
        time_zone_id: input.time_zone_id ?? 'UTC',
        ...(input.filter ? { filter: input.filter } : {}),
      },
    };
    const first = await this.client.post<{ metrics?: Array<Record<string, unknown>>; metrics_updated_at?: string }>(
      `ad_accounts/${encodeURIComponent(input.account_id)}/reports?page.size=${Math.min(input.page_size ?? 200, 1000)}`,
      body,
    );
    const metrics = [...(first.data.metrics ?? [])];
    let next = first.pagination?.next_url;
    while (next && metrics.length < (input.page_size ?? 200)) {
      const page = await this.client.get<{ metrics?: Array<Record<string, unknown>> }>(next);
      metrics.push(...(page.data.metrics ?? []));
      next = page.pagination?.next_url;
    }
    return { metrics: metrics.slice(0, input.page_size ?? 200), metrics_updated_at: first.data.metrics_updated_at };
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
  ): Promise<Array<Record<string, unknown>>> {
    const first = await this.client.post<{ metrics?: Array<Record<string, unknown>> }>(
      `ad_accounts/${encodeURIComponent(accountId)}/reports?page.size=${Math.min(limit, 1000)}`,
      body,
    );
    const rows = [...(first.data.metrics ?? [])];
    let next = first.pagination?.next_url;
    while (next && rows.length < limit) {
      const page = await this.client.get<{ metrics?: Array<Record<string, unknown>> }>(next);
      rows.push(...(page.data.metrics ?? []));
      next = page.pagination?.next_url;
    }
    return rows.slice(0, limit);
  }

  private toReportRow(
    raw: Record<string, unknown>,
    accountId: string,
    query: NormalizedQuery,
    breakdown?: string,
  ): ReportRow {
    const value = (key: string) => Number(raw[key] ?? 0);
    const spend = value('spend') / REDDIT_MICROS;
    const impressions = value('impressions');
    const clicks = value('clicks');
    const conversions = value('conversion_purchase_clicks') + value('conversion_purchase_views');
    const conversionValue = value('conversion_purchase_total_value') / 100;
    const all: Record<MetricName, number> = {
      spend: round2(spend), impressions, clicks, conversions, conversion_value: round2(conversionValue),
      ctr: impressions ? round2((clicks / impressions) * 100) : 0,
      cpc: clicks ? round2(spend / clicks) : 0,
      cpm: impressions ? round2((spend / impressions) * 1000) : 0,
      cpa: conversions ? round2(spend / conversions) : 0,
      roas: spend ? round2(conversionValue / spend) : 0,
    };
    const entityId = breakdown ? String(raw[breakdown] ?? '') : accountId;
    return {
      provider: this.id,
      accountId,
      entity: { level: query.level, id: entityId, name: entityId },
      metrics: Object.fromEntries(query.metrics.map((metric) => [metric, all[metric]])),
    };
  }

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<WritePlan> {
    const payload = op.payload as never;
    switch (op.tool) {
      case 'reddit_create_campaign': return this.planCreateCampaign(op.accountId, payload, guard);
      case 'reddit_set_campaign_status': return this.planSetStatus(op.accountId, payload);
      case 'reddit_set_budget': return this.planSetBudget(op.accountId, payload);
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
      execute: async () => extractIds(await this.client.post<RedditCampaign>(`ad_accounts/${encodeURIComponent(accountId)}/campaigns`, { data })),
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
      execute: async () => extractIds(await this.client.patch<RedditCampaign>(`campaigns/${encodeURIComponent(campaign.id)}`, {
        data: { configured_status: payload.configured_status },
      })),
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
    return {
      summary: `Change Reddit campaign "${campaign.name}" budget ${campaign.goal_value ?? '?'} → ${payload.budget_micros} micros`,
      changes: [`~ campaign ${campaign.id} ${campaign.goal_type ?? 'goal'} ${campaign.goal_value ?? '?'} → ${payload.budget_micros}`],
      coercions: [],
      budgetDeltas: [{ target: `campaign "${campaign.name}" budget`, fromMicros: campaign.goal_value, toMicros: payload.budget_micros }],
      execute: async () => extractIds(await this.client.patch<RedditCampaign>(`campaigns/${encodeURIComponent(campaign.id)}`, {
        data: { goal_value: payload.budget_micros, ...(payload.budget_type ? { goal_type: payload.budget_type } : {}) },
      })),
    };
  }

  private async planApiCreate(
    accountId: string,
    payload: { path: string; body: Record<string, unknown> },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const path = validateRedditPath(payload.path);
    if (!path.startsWith(`ad_accounts/${accountId}/`)) {
      throw new AdportError('INVALID_INPUT', 'reddit: create path must be under the selected ad account');
    }
    const body = structuredClone(payload.body);
    const coercions: string[] = [];
    if (guard.forcePausedCreation) {
      coerceCreatedStatuses(body, coercions, /\/(?:campaigns|ad_groups|ads)$/.test(path));
    }
    return {
      summary: `Create Reddit resource via /${path}`,
      changes: [`+ POST /${path} ${JSON.stringify(body)}`],
      coercions,
      budgetDeltas: collectMicros(body),
      execute: async () => extractIds(await this.client.post(path, body)),
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
    return {
      summary: `Update Reddit resource via /${path}`,
      changes: [`~ PATCH /${path} ${JSON.stringify(payload.body)}`],
      coercions: [], budgetDeltas: [],
      execute: async () => extractIds(await this.client.patch(path, payload.body)),
    };
  }

  private async planApiDelete(accountId: string, payload: { path: string }): Promise<WritePlan> {
    const path = validateRedditPath(payload.path);
    await this.assertOwnedResource(path, accountId);
    return {
      summary: `Permanently delete Reddit resource via /${path}`,
      changes: [`- DELETE /${path}`],
      coercions: [], budgetDeltas: [],
      execute: async () => extractIds(await this.client.delete(path)),
    };
  }

  private async getOwnedCampaign(accountId: string, campaignId: string): Promise<RedditCampaign> {
    const campaign = (await this.client.get<RedditCampaign>(`campaigns/${encodeURIComponent(campaignId)}`)).data;
    if (campaign.ad_account_id !== accountId) {
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
    if (MONEY_KEY.test(key) && Number.isInteger(child) && Number(child) > 0) {
      deltas.push({ target: `${path}.${key}`, toMicros: Number(child) });
    }
    deltas.push(...collectMicros(child, `${path}.${key}`));
  }
  return deltas;
}

function extractIds(envelope: RedditEnvelope<unknown>): string[] {
  const ids: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isRecord(value)) return;
    if (typeof value.id === 'string' || typeof value.id === 'number') ids.push(String(value.id));
    for (const child of Object.values(value)) visit(child);
  };
  visit(envelope.data);
  return [...new Set(ids)];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
