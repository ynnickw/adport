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
import { TikTokClient } from './client.js';

/** TikTok budgets are floats in whole account-currency units. */
export const UNITS_TO_MICROS = 1_000_000;

const DATA_LEVEL = {
  account: 'AUCTION_ADVERTISER',
  campaign: 'AUCTION_CAMPAIGN',
  ad_group: 'AUCTION_ADGROUP',
  ad: 'AUCTION_AD',
} as const;

const ID_DIMENSION = {
  account: 'advertiser_id',
  campaign: 'campaign_id',
  ad_group: 'adgroup_id',
  ad: 'ad_id',
} as const;

interface TikTokCampaign {
  campaign_id: string;
  campaign_name: string;
  operation_status: 'ENABLE' | 'DISABLE';
  secondary_status?: string;
  budget: number;
  budget_mode: string;
  objective_type: string;
}

interface WritePlan {
  summary: string;
  changes: string[];
  coercions: string[];
  budgetDeltas: WritePreview['budgetDeltas'];
  execute: () => Promise<string[]>;
}

export class TikTokAdsProvider implements AdProvider {
  readonly id = 'tiktok';

  constructor(
    private readonly client: TikTokClient,
    private readonly app: { appId: string; secret: string },
  ) {}

  capabilities(): ProviderCapabilities {
    // No server-side dry run in the Marketing API — previews are client-side diffs.
    return { serverDryRun: false };
  }

  standardActions(): StandardActions {
    return {
      pauseCampaign: (accountId, campaignId) => ({
        tool: 'tiktok_set_campaign_status',
        input: { account_id: accountId, campaign_ids: [campaignId], operation_status: 'DISABLE' },
      }),
    };
  }

  async listAccounts(): Promise<Account[]> {
    const authorized = await this.client.get<{ list?: Array<{ advertiser_id: string; advertiser_name: string }> }>(
      'oauth2/advertiser/get',
      { app_id: this.appId(), secret: this.secret() },
    );
    const ids = (authorized.list ?? []).map((a) => a.advertiser_id);
    if (ids.length === 0) return [];
    const info = await this.client.get<{
      list?: Array<{ advertiser_id: string; name?: string; currency?: string; status?: string; timezone?: string }>;
    }>('advertiser/info', { advertiser_ids: ids.slice(0, 100), fields: ['name', 'currency', 'status', 'timezone'] });
    const byId = new Map((info.list ?? []).map((i) => [i.advertiser_id, i]));
    return ids.map((id) => {
      const details = byId.get(id);
      return {
        provider: this.id,
        id,
        name: details?.name ?? (authorized.list ?? []).find((a) => a.advertiser_id === id)?.advertiser_name ?? id,
        currency: details?.currency,
        status: details?.status?.replace('STATUS_', ''),
      };
    });
  }

  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const accountIds = query.accountIds ?? (await this.listAccounts()).map((a) => a.id);
    const level = DATA_LEVEL[query.level];
    const idDim = ID_DIMENSION[query.level];
    const nameMetric = { campaign: 'campaign_name', ad_group: 'adgroup_name', ad: 'ad_name' }[
      query.level as string
    ];

    const rows: ReportRow[] = [];
    for (const accountId of accountIds) {
      const data = await this.client.get<{
        list?: Array<{ dimensions: Record<string, string>; metrics: Record<string, string> }>;
        page_info?: { total_number?: number };
      }>('report/integrated/get', {
        advertiser_id: accountId,
        report_type: 'BASIC',
        data_level: level,
        dimensions: [idDim],
        metrics: [
          ...(nameMetric ? [nameMetric] : []),
          'spend',
          'impressions',
          'clicks',
          'conversion',
          'complete_payment_roas',
          'total_complete_payment_rate',
        ],
        start_date: range.start,
        end_date: range.end,
        page: 1,
        page_size: Math.min(query.limit ?? 200, 1000),
      });
      for (const row of data.list ?? []) {
        rows.push(this.toReportRow(row, accountId, query, idDim, nameMetric));
      }
    }
    return { rows };
  }

  private toReportRow(
    row: { dimensions: Record<string, string>; metrics: Record<string, string> },
    accountId: string,
    query: NormalizedQuery,
    idDim: string,
    nameMetric?: string,
  ): ReportRow {
    // All TikTok metric values are strings ("14.68"); spend is whole currency units.
    const num = (key: string) => Number(row.metrics[key] ?? 0);
    const spend = num('spend');
    const impressions = num('impressions');
    const clicks = num('clicks');
    const conversions = num('conversion');
    // total_complete_payment_rate is (despite the name) total purchase VALUE.
    const conversionValue = num('total_complete_payment_rate');
    const all: Record<MetricName, number> = {
      spend: round2(spend),
      impressions,
      clicks,
      conversions,
      conversion_value: round2(conversionValue),
      ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
      cpc: clicks > 0 ? round2(spend / clicks) : 0,
      cpm: impressions > 0 ? round2((spend / impressions) * 1000) : 0,
      cpa: conversions > 0 ? round2(spend / conversions) : 0,
      roas: spend > 0 ? round2(conversionValue / spend) : 0,
    };
    const entityId = row.dimensions[idDim] ?? '';
    return {
      provider: this.id,
      accountId,
      entity: {
        level: query.level,
        id: entityId,
        name: (nameMetric ? row.metrics[nameMetric] : undefined) ?? entityId,
      },
      metrics: Object.fromEntries(query.metrics.map((m) => [m, all[m]])),
    };
  }

  async rawReport(input: {
    account_id: string;
    data_level: string;
    dimensions: string[];
    metrics: string[];
    start_date: string;
    end_date: string;
    page_size?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const data = await this.client.get<{ list?: Array<Record<string, unknown>> }>('report/integrated/get', {
      advertiser_id: input.account_id,
      report_type: 'BASIC',
      data_level: input.data_level,
      dimensions: input.dimensions,
      metrics: input.metrics,
      start_date: input.start_date,
      end_date: input.end_date,
      page: 1,
      page_size: Math.min(input.page_size ?? 200, 1000),
    });
    return data.list ?? [];
  }

  async apiRead(input: {
    account_id: string;
    path: string;
    params?: Record<string, unknown>;
  }): Promise<unknown> {
    const path = validateTikTokPath(input.path);
    return this.client.get(path, { ...input.params, advertiser_id: input.account_id });
  }

  async listCampaigns(accountId: string, campaignIds?: string[]): Promise<TikTokCampaign[]> {
    const data = await this.client.get<{ list?: TikTokCampaign[] }>('campaign/get', {
      advertiser_id: accountId,
      ...(campaignIds ? { filtering: { campaign_ids: campaignIds } } : {}),
      page: 1,
      page_size: campaignIds ? campaignIds.length : 100,
    });
    return data.list ?? [];
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const plan = await this.plan(op, guard);
    // No validate_only equivalent — the preview is a client-side diff from live lookups.
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
      case 'tiktok_create_campaign':
        return this.planCreateCampaign(op.accountId, payload, guard);
      case 'tiktok_set_campaign_status':
        return this.planSetStatus(op.accountId, payload);
      case 'tiktok_set_budget':
        return this.planSetBudget(op.accountId, payload);
      case 'tiktok_api_create':
        return this.planApiCreate(op.accountId, payload, guard);
      case 'tiktok_api_update':
        return this.planApiUpdate(op.accountId, payload);
      case 'tiktok_api_delete':
        return this.planApiDelete(op.accountId, payload);
      default:
        throw new AdportError('PROVIDER_ERROR', `tiktok: unsupported write tool ${op.tool}`);
    }
  }

  private async planApiCreate(
    accountId: string,
    payload: { path: string; body: Record<string, unknown> },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const path = validateTikTokMutationPath(payload.path, 'create');
    const body = structuredClone(payload.body);
    body.advertiser_id = accountId;
    const coercions: string[] = [];
    if (guard.forcePausedCreation) {
      coerceTikTokCreatedStatuses(body, coercions);
      if (path === 'campaign/create' && body.operation_status !== 'DISABLE') {
        body.operation_status = 'DISABLE';
        coercions.push('operation_status set to DISABLE by policy (paused_creation)');
      }
    }
    return {
      summary: `Create TikTok resource via /${path}`,
      changes: [`+ POST /${path} ${JSON.stringify(body)}`],
      coercions,
      budgetDeltas: collectTikTokBudgets(body),
      execute: async () => extractTikTokIds(await this.client.post(path, body)),
    };
  }

  private async planApiUpdate(
    accountId: string,
    payload: { path: string; body: Record<string, unknown> },
  ): Promise<WritePlan> {
    const path = validateTikTokMutationPath(payload.path, 'update');
    if (containsTikTokBudget(payload.body)) {
      throw new AdportError('INVALID_INPUT', 'tiktok: budget updates require a typed budget tool for policy checks');
    }
    const body = { ...payload.body, advertiser_id: accountId };
    return {
      summary: `Update TikTok resource via /${path}`,
      changes: [`~ POST /${path} ${JSON.stringify(body)}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => extractTikTokIds(await this.client.post(path, body)),
    };
  }

  private async planApiDelete(
    accountId: string,
    payload: { path: string; body: Record<string, unknown> },
  ): Promise<WritePlan> {
    const path = validateTikTokMutationPath(payload.path, 'delete');
    const body = { ...payload.body, advertiser_id: accountId };
    return {
      summary: `Permanently delete TikTok resource via /${path}`,
      changes: [`- POST /${path} ${JSON.stringify(body)}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => extractTikTokIds(await this.client.post(path, body)),
    };
  }

  private async planCreateCampaign(
    accountId: string,
    payload: { campaign_name: string; objective_type: string; budget_mode: string; budget?: number; operation_status?: string },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const coercions: string[] = [];
    // TikTok creates campaigns ENABLED by default; DISABLE is its "paused".
    let operationStatus = payload.operation_status ?? 'ENABLE';
    if (guard.forcePausedCreation && operationStatus === 'ENABLE') {
      operationStatus = 'DISABLE';
      coercions.push('operation_status coerced to DISABLE (paused) by policy (paused_creation)');
    }
    if (payload.budget_mode !== 'BUDGET_MODE_INFINITE' && !payload.budget) {
      throw new AdportError('INVALID_INPUT', `tiktok: budget is required for ${payload.budget_mode}`);
    }
    const budgetDeltas: WritePreview['budgetDeltas'] = [];
    if (payload.budget) {
      budgetDeltas.push({
        target: `new campaign "${payload.campaign_name}" ${payload.budget_mode === 'BUDGET_MODE_DAY' ? 'daily' : 'total'} budget`,
        toMicros: payload.budget * UNITS_TO_MICROS,
      });
    }
    return {
      summary: `Create TikTok campaign "${payload.campaign_name}" (${payload.objective_type}, ${operationStatus === 'DISABLE' ? 'paused' : 'active'})`,
      changes: [
        `+ campaign "${payload.campaign_name}" objective=${payload.objective_type} ${payload.budget_mode}` +
          (payload.budget ? ` budget=${payload.budget}` : '') +
          ` operation_status=${operationStatus}`,
      ],
      coercions,
      budgetDeltas,
      execute: async () => {
        const data = await this.client.post<{ campaign_id?: string }>('campaign/create', {
          advertiser_id: accountId,
          campaign_name: payload.campaign_name,
          objective_type: payload.objective_type,
          budget_mode: payload.budget_mode,
          ...(payload.budget ? { budget: payload.budget } : {}),
          operation_status: operationStatus,
        });
        return data.campaign_id ? [data.campaign_id] : [];
      },
    };
  }

  private async planSetStatus(
    accountId: string,
    payload: { campaign_ids: string[]; operation_status: 'ENABLE' | 'DISABLE' },
  ): Promise<WritePlan> {
    const campaigns = await this.listCampaigns(accountId, payload.campaign_ids);
    const changes = payload.campaign_ids.map((id) => {
      const campaign = campaigns.find((c) => c.campaign_id === id);
      return `~ campaign ${id} ("${campaign?.campaign_name ?? '?'}") operation_status ${campaign?.operation_status ?? '?'} → ${payload.operation_status}`;
    });
    return {
      summary: `Set ${payload.campaign_ids.length} TikTok campaign(s) → ${payload.operation_status === 'DISABLE' ? 'paused' : 'active'}`,
      changes,
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        await this.client.post('campaign/status/update', {
          advertiser_id: accountId,
          campaign_ids: payload.campaign_ids,
          operation_status: payload.operation_status,
        });
        return payload.campaign_ids;
      },
    };
  }

  private async planSetBudget(
    accountId: string,
    payload: { campaign_id: string; budget: number },
  ): Promise<WritePlan> {
    const campaigns = await this.listCampaigns(accountId, [payload.campaign_id]);
    const campaign = campaigns[0];
    if (!campaign) {
      throw new AdportError('PROVIDER_ERROR', `tiktok: campaign ${payload.campaign_id} not found in advertiser ${accountId}`);
    }
    if (campaign.budget_mode === 'BUDGET_MODE_INFINITE') {
      throw new AdportError('PROVIDER_ERROR', `tiktok: campaign "${campaign.campaign_name}" has no budget (BUDGET_MODE_INFINITE)`);
    }
    return {
      summary: `Change TikTok campaign "${campaign.campaign_name}" budget ${campaign.budget} → ${payload.budget} (${campaign.budget_mode})`,
      changes: [
        `~ campaign ${payload.campaign_id} budget ${campaign.budget} → ${payload.budget}`,
        '! TikTok requires the new budget to be ≥105% of already-spent amount; the API rejects violations',
      ],
      coercions: [],
      budgetDeltas: [
        {
          target: `campaign "${campaign.campaign_name}" ${campaign.budget_mode === 'BUDGET_MODE_DAY' ? 'daily' : 'total'} budget`,
          fromMicros: campaign.budget * UNITS_TO_MICROS,
          toMicros: payload.budget * UNITS_TO_MICROS,
        },
      ],
      execute: async () => {
        await this.client.post('campaign/update', {
          advertiser_id: accountId,
          campaign_id: payload.campaign_id,
          budget: payload.budget,
        });
        return [payload.campaign_id];
      },
    };
  }

  private appId(): string {
    return this.app.appId;
  }

  private secret(): string {
    return this.app.secret;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function validateTikTokPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, '').trim();
  if (!/^[a-z0-9_/-]{3,160}$/.test(normalized) || normalized.includes('..') || normalized.includes('//')) {
    throw new AdportError('INVALID_INPUT', `tiktok: invalid Business API path "${path}"`);
  }
  return normalized;
}

function validateTikTokMutationPath(path: string, kind: 'create' | 'update' | 'delete'): string {
  const normalized = validateTikTokPath(path);
  if (!normalized.endsWith(`/${kind}`)) {
    throw new AdportError('INVALID_INPUT', `tiktok: ${kind} tool requires an endpoint ending in /${kind}`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceTikTokCreatedStatuses(value: unknown, coercions: string[], path = 'body'): void {
  if (Array.isArray(value)) return value.forEach((item, index) => coerceTikTokCreatedStatuses(item, coercions, `${path}[${index}]`));
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'operation_status' && child === 'ENABLE') {
      value[key] = 'DISABLE';
      coercions.push(`${path}.${key} coerced to DISABLE by policy (paused_creation)`);
    } else {
      coerceTikTokCreatedStatuses(child, coercions, `${path}.${key}`);
    }
  }
}

function containsTikTokBudget(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTikTokBudget);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => /budget/i.test(key) || containsTikTokBudget(child));
}

function collectTikTokBudgets(value: unknown, path = 'body'): WritePreview['budgetDeltas'] {
  const deltas: WritePreview['budgetDeltas'] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => deltas.push(...collectTikTokBudgets(item, `${path}[${index}]`)));
    return deltas;
  }
  if (!isRecord(value)) return deltas;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/budget/i.test(key)) {
      const amount = Number(child);
      if (Number.isFinite(amount) && amount > 0) {
        deltas.push({ target: childPath, toMicros: Math.round(amount * UNITS_TO_MICROS) });
      }
    }
    deltas.push(...collectTikTokBudgets(child, childPath));
  }
  return deltas;
}

function extractTikTokIds(value: unknown): string[] {
  const ids: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!isRecord(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (/(?:^|_)ids?$/.test(key)) {
        if (Array.isArray(child)) child.forEach((id) => ids.push(String(id)));
        else if (typeof child === 'string' || typeof child === 'number') ids.push(String(child));
      } else visit(child);
    }
  };
  visit(value);
  return [...new Set(ids)];
}
