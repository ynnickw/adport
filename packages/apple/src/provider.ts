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
import { AppleAdsClient } from './client.js';

/** Apple Money amounts are strings in whole currency units. */
export const UNITS_TO_MICROS = 1_000_000;

interface Money {
  amount: string;
  currency: string;
}

interface AppleCampaign {
  id: number;
  name: string;
  status: 'ENABLED' | 'PAUSED';
  servingStatus?: string;
  displayStatus?: string;
  dailyBudgetAmount?: Money;
  adamId?: number;
  countriesOrRegions?: string[];
  billingEvent?: string;
  supplySources?: string[];
}

interface SpendRow {
  impressions?: number;
  taps?: number;
  ttr?: number;
  totalInstalls?: number;
  localSpend?: Money;
  tapInstallCPI?: Money;
  tapInstallRate?: number;
}

interface ReportingRow {
  other?: boolean;
  total?: SpendRow;
  metadata?: { campaignId?: number; campaignName?: string; campaignStatus?: string };
}

interface WritePlan {
  summary: string;
  changes: string[];
  coercions: string[];
  budgetDeltas: WritePreview['budgetDeltas'];
  execute: () => Promise<string[]>;
}

const APPLE_READ_ROOTS = /^(?:acls|me|apps(?:\/.*)?|campaigns(?:\/.*)?|adgroups(?:\/.*)?|targetingkeywords(?:\/.*)?|negativekeywords(?:\/.*)?|ads(?:\/.*)?|creatives(?:\/.*)?|product-pages(?:\/.*)?|search(?:\/.*)?|geolocations(?:\/.*)?|budgetorders(?:\/.*)?|reports(?:\/.*)?|customreports(?:\/.*)?)(?:\?.*)?$/;
const APPLE_MUTATION_ROOTS = /^(?:campaigns|adgroups|targetingkeywords|negativekeywords|ads|creatives|budgetorders)(?:\/[^?#]+)*$/;

export class AppleAdsProvider implements AdProvider {
  readonly id = 'apple';

  constructor(private readonly client: AppleAdsClient) {}

  capabilities(): ProviderCapabilities {
    // No validate-only mode in the Campaign Management API — client-side previews.
    return { serverDryRun: false };
  }

  standardActions(): StandardActions {
    return {
      pauseCampaign: (accountId, campaignId) => ({
        tool: 'apple_set_campaign_status',
        input: { account_id: accountId, campaign_id: campaignId, status: 'PAUSED' },
      }),
    };
  }

  /** Apple "accounts" are organizations from the user ACL. */
  async listAccounts(): Promise<Account[]> {
    const envelope = await this.client.request<
      Array<{ orgId: number; orgName: string; currency?: string; roleNames?: string[]; timeZone?: string }>
    >('GET', 'acls');
    return (envelope.data ?? []).map((acl) => ({
      provider: this.id,
      id: String(acl.orgId),
      name: acl.orgName,
      currency: acl.currency,
      status: acl.roleNames?.join(',') || undefined,
    }));
  }

  async listCampaigns(orgId: string, limit = 100): Promise<AppleCampaign[]> {
    const envelope = await this.client.request<AppleCampaign[]>('GET', `campaigns?limit=${limit}&offset=0`, {
      orgId,
    });
    return envelope.data ?? [];
  }

  async getCampaign(orgId: string, campaignId: string): Promise<AppleCampaign> {
    const envelope = await this.client.request<AppleCampaign[]>('POST', 'campaigns/find', {
      orgId,
      body: {
        conditions: [{ field: 'id', operator: 'EQUALS', values: [String(campaignId)] }],
        pagination: { offset: 0, limit: 1 },
      },
    });
    const campaign = envelope.data?.[0];
    if (!campaign) {
      throw new AdportError('PROVIDER_ERROR', `apple: campaign ${campaignId} not found in org ${orgId}`);
    }
    return campaign;
  }

  /**
   * Safe low-level access to the documented read surface. Apple uses POST for
   * selectors and reports, so method alone cannot determine mutability.
   */
  async apiRead(input: {
    account_id?: string;
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
  }): Promise<unknown> {
    const path = normalizeApiPath(input.path);
    if (!APPLE_READ_ROOTS.test(path)) {
      throw new AdportError('INVALID_INPUT', `apple: unsupported read path "${path}"`);
    }
    if (
      input.method === 'POST' &&
      !path.includes('/find') &&
      !path.startsWith('reports/') &&
      !path.startsWith('customreports')
    ) {
      throw new AdportError(
        'INVALID_INPUT',
        'apple: POST is read-only here only for /find, reports/*, and customreports endpoints',
      );
    }
    const envelope = await this.client.request(input.method, path, {
      ...(input.account_id ? { orgId: input.account_id } : {}),
      ...(input.body ? { body: input.body } : {}),
    });
    return envelope;
  }

  async report(query: NormalizedQuery): Promise<Report> {
    if (query.level !== 'campaign' && query.level !== 'account') {
      throw new AdportError('INVALID_INPUT', 'apple: report supports campaign and account levels in v0');
    }
    const range = resolveDateRange(query.dateRange);
    const accountIds = query.accountIds ?? (await this.listAccounts()).map((a) => a.id);
    const rows: ReportRow[] = [];
    for (const orgId of accountIds) {
      const envelope = await this.client.request<{ reportingDataResponse?: { row?: ReportingRow[] } }>(
        'POST',
        'reports/campaigns',
        {
          orgId,
          body: {
            startTime: range.start,
            endTime: range.end,
            selector: {
              orderBy: [{ field: 'campaignId', sortOrder: 'ASCENDING' }],
              pagination: { offset: 0, limit: Math.min(query.limit ?? 200, 1000) },
            },
            timeZone: 'UTC',
            returnRowTotals: true,
            returnGrandTotals: true,
            returnRecordsWithNoMetrics: false,
          },
        },
      );
      const providerRows = (envelope.data?.reportingDataResponse?.row ?? []).map((row) =>
        this.toReportRow(row, orgId, query),
      );
      if (query.level === 'account') {
        if (providerRows.length > 0) rows.push(aggregateAccountRows(providerRows, this.id, orgId));
      } else {
        rows.push(...providerRows);
      }
    }
    return { rows };
  }

  private toReportRow(row: ReportingRow, orgId: string, query: NormalizedQuery): ReportRow {
    const total = row.total ?? {};
    const spend = Number(total.localSpend?.amount ?? 0);
    const impressions = total.impressions ?? 0;
    // Apple has taps, not clicks; installs are the conversion event. No revenue metric exists.
    const clicks = total.taps ?? 0;
    const conversions = total.totalInstalls ?? 0;
    const all: Record<MetricName, number> = {
      spend: round2(spend),
      impressions,
      clicks,
      conversions,
      conversion_value: 0,
      ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
      cpc: clicks > 0 ? round2(spend / clicks) : 0,
      cpm: impressions > 0 ? round2((spend / impressions) * 1000) : 0,
      cpa: conversions > 0 ? round2(spend / conversions) : 0,
      roas: 0,
    };
    return {
      provider: this.id,
      accountId: orgId,
      entity: {
        level: 'campaign',
        id: String(row.metadata?.campaignId ?? ''),
        name: row.metadata?.campaignName ?? '',
        status: row.metadata?.campaignStatus,
      },
      metrics: Object.fromEntries(query.metrics.map((m) => [m, all[m]])),
    };
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
    const resourceIds = await plan.execute();
    return { applied: true, resourceIds };
  }

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<WritePlan> {
    const payload = op.payload as never;
    switch (op.tool) {
      case 'apple_create_campaign':
        return this.planCreateCampaign(op.accountId, payload, guard);
      case 'apple_set_campaign_status':
        return this.planSetStatus(op.accountId, payload);
      case 'apple_set_budget':
        return this.planSetBudget(op.accountId, payload);
      case 'apple_api_create':
        return this.planApiCreate(op.accountId, payload, guard);
      case 'apple_api_update':
        return this.planApiUpdate(op.accountId, payload);
      case 'apple_api_delete':
        return this.planApiDelete(op.accountId, payload);
      default:
        throw new AdportError('PROVIDER_ERROR', `apple: unsupported write tool ${op.tool}`);
    }
  }

  private async planCreateCampaign(
    orgId: string,
    payload: {
      name: string;
      adam_id: number;
      countries_or_regions: string[];
      daily_budget: number;
      currency: string;
      status?: string;
    },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const coercions: string[] = [];
    let status = payload.status ?? 'ENABLED';
    if (guard.forcePausedCreation && status === 'ENABLED') {
      status = 'PAUSED';
      coercions.push('status coerced to PAUSED by policy (paused_creation)');
    }
    // budgetAmount (lifetime) was removed in v5.6 — dailyBudgetAmount only.
    const body = {
      orgId: Number(orgId),
      name: payload.name,
      adamId: payload.adam_id,
      countriesOrRegions: payload.countries_or_regions,
      dailyBudgetAmount: { amount: String(payload.daily_budget), currency: payload.currency },
      adChannelType: 'SEARCH',
      billingEvent: 'TAPS',
      supplySources: ['APPSTORE_SEARCH_RESULTS'],
      status,
    };
    return {
      summary: `Create Apple Ads campaign "${payload.name}" (${status}) — daily budget ${payload.daily_budget} ${payload.currency}`,
      changes: [
        `+ campaign "${payload.name}" app=${payload.adam_id} regions=[${payload.countries_or_regions.join(', ')}] status=${status}`,
      ],
      coercions,
      budgetDeltas: [
        { target: `new campaign "${payload.name}" daily budget`, toMicros: payload.daily_budget * UNITS_TO_MICROS },
      ],
      execute: async () => {
        const envelope = await this.client.request<AppleCampaign>('POST', 'campaigns', { orgId, body });
        return envelope.data?.id ? [String(envelope.data.id)] : [];
      },
    };
  }

  private async planSetStatus(
    orgId: string,
    payload: { campaign_id: string; status: 'ENABLED' | 'PAUSED' },
  ): Promise<WritePlan> {
    const current = await this.getCampaign(orgId, payload.campaign_id);
    return {
      summary: `Set Apple campaign "${current.name}" status ${current.status} → ${payload.status}`,
      changes: [`~ campaign ${payload.campaign_id} status ${current.status} → ${payload.status}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        await this.client.request('PUT', `campaigns/${payload.campaign_id}`, {
          orgId,
          body: { campaign: { status: payload.status } },
        });
        return [payload.campaign_id];
      },
    };
  }

  private async planSetBudget(
    orgId: string,
    payload: { campaign_id: string; daily_budget: number },
  ): Promise<WritePlan> {
    const current = await this.getCampaign(orgId, payload.campaign_id);
    const fromAmount = current.dailyBudgetAmount ? Number(current.dailyBudgetAmount.amount) : undefined;
    const currency = current.dailyBudgetAmount?.currency ?? 'USD';
    return {
      summary: `Change Apple campaign "${current.name}" daily budget ${fromAmount ?? '(unset)'} → ${payload.daily_budget} ${currency}`,
      changes: [`~ campaign ${payload.campaign_id} dailyBudgetAmount ${fromAmount ?? '(unset)'} → ${payload.daily_budget}`],
      coercions: [],
      budgetDeltas: [
        {
          target: `campaign "${current.name}" daily budget`,
          ...(fromAmount !== undefined ? { fromMicros: fromAmount * UNITS_TO_MICROS } : {}),
          toMicros: payload.daily_budget * UNITS_TO_MICROS,
        },
      ],
      execute: async () => {
        await this.client.request('PUT', `campaigns/${payload.campaign_id}`, {
          orgId,
          body: { campaign: { dailyBudgetAmount: { amount: String(payload.daily_budget), currency } } },
        });
        return [payload.campaign_id];
      },
    };
  }

  private async planApiCreate(
    orgId: string,
    payload: { path: string; body: Record<string, unknown> },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const path = validateMutationPath(payload.path);
    const body = structuredClone(payload.body);
    const coercions: string[] = [];
    if (guard.forcePausedCreation) coerceCreatedStatuses(body, coercions);
    const budgetDeltas = collectCreatedMoney(body);
    return {
      summary: `Create Apple Ads resource via POST /${path}`,
      changes: [`+ POST /${path} ${JSON.stringify(body)}`],
      coercions,
      budgetDeltas,
      execute: async () => {
        const envelope = await this.client.request<unknown>('POST', path, { orgId, body });
        return extractResourceIds(envelope.data);
      },
    };
  }

  private async planApiUpdate(
    orgId: string,
    payload: { path: string; body: Record<string, unknown> },
  ): Promise<WritePlan> {
    const path = validateMutationPath(payload.path);
    if (containsMoneyField(payload.body)) {
      throw new AdportError(
        'INVALID_INPUT',
        'apple: monetary updates require a typed budget or bid tool so current and proposed values can be policy-checked',
      );
    }
    return {
      summary: `Update Apple Ads resource via PUT /${path}`,
      changes: [`~ PUT /${path} ${JSON.stringify(payload.body)}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        const envelope = await this.client.request<unknown>('PUT', path, { orgId, body: payload.body });
        return extractResourceIds(envelope.data, path);
      },
    };
  }

  private async planApiDelete(orgId: string, payload: { path: string }): Promise<WritePlan> {
    const path = validateMutationPath(payload.path);
    return {
      summary: `Delete Apple Ads resource via DELETE /${path}`,
      changes: [`- DELETE /${path}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        await this.client.request('DELETE', path, { orgId });
        return [path.split('/').at(-1)!];
      },
    };
  }
}

function normalizeApiPath(path: string): string {
  const normalized = path.replace(/^\/+/, '').trim();
  if (!normalized || normalized.includes('://') || normalized.includes('..') || normalized.includes('#')) {
    throw new AdportError('INVALID_INPUT', 'apple: path must be a relative API path without traversal or fragments');
  }
  return normalized;
}

function validateMutationPath(path: string): string {
  const normalized = normalizeApiPath(path);
  if (!APPLE_MUTATION_ROOTS.test(normalized) || normalized.includes('/find') || normalized.startsWith('reports/')) {
    throw new AdportError('INVALID_INPUT', `apple: unsupported mutation path "${normalized}"`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceCreatedStatuses(value: unknown, coercions: string[], path = 'body'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => coerceCreatedStatuses(item, coercions, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'status' || key === 'campaignStatus' || key === 'adGroupStatus') && child === 'ENABLED') {
      value[key] = 'PAUSED';
      coercions.push(`${path}.${key} coerced to PAUSED by policy (paused_creation)`);
    } else {
      coerceCreatedStatuses(child, coercions, `${path}.${key}`);
    }
  }
}

function isMoneyKey(key: string): boolean {
  return /(budget|bidAmount|cpaGoal)/i.test(key);
}

function containsMoneyField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMoneyField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => isMoneyKey(key) || containsMoneyField(child));
}

function collectCreatedMoney(value: unknown, path = 'body'): WritePreview['budgetDeltas'] {
  const deltas: WritePreview['budgetDeltas'] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => deltas.push(...collectCreatedMoney(item, `${path}[${index}]`)));
    return deltas;
  }
  if (!isRecord(value)) return deltas;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isMoneyKey(key)) {
      const amount = isRecord(child) ? Number(child.amount) : Number(child);
      if (Number.isFinite(amount) && amount >= 0) {
        deltas.push({ target: childPath, toMicros: Math.round(amount * UNITS_TO_MICROS) });
      }
    }
    deltas.push(...collectCreatedMoney(child, childPath));
  }
  return deltas;
}

function extractResourceIds(value: unknown, fallback?: string): string[] {
  const ids: string[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!isRecord(item)) return;
    if (item.id !== undefined) ids.push(String(item.id));
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return ids.length > 0 ? [...new Set(ids)] : fallback ? [fallback.split('/').at(-1)!] : [];
}

function aggregateAccountRows(rows: ReportRow[], provider: string, accountId: string): ReportRow {
  const metrics = Object.fromEntries(
    Object.keys(rows[0]!.metrics).map((metric) => [
      metric,
      round2(rows.reduce((sum, row) => sum + (row.metrics[metric as MetricName] ?? 0), 0)),
    ]),
  ) as Partial<Record<MetricName, number>>;
  const spend = metrics.spend ?? 0;
  const impressions = metrics.impressions ?? 0;
  const clicks = metrics.clicks ?? 0;
  const conversions = metrics.conversions ?? 0;
  const conversionValue = metrics.conversion_value ?? 0;
  if ('ctr' in metrics) metrics.ctr = impressions > 0 ? round2((clicks / impressions) * 100) : 0;
  if ('cpc' in metrics) metrics.cpc = clicks > 0 ? round2(spend / clicks) : 0;
  if ('cpm' in metrics) metrics.cpm = impressions > 0 ? round2((spend / impressions) * 1000) : 0;
  if ('cpa' in metrics) metrics.cpa = conversions > 0 ? round2(spend / conversions) : 0;
  if ('roas' in metrics) metrics.roas = spend > 0 ? round2(conversionValue / spend) : 0;
  return { provider, accountId, entity: { level: 'account', id: accountId, name: accountId }, metrics };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
