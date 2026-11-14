import {
  AdportError,
  LocalMediaResolver,
  type MediaResolver,
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
import { TikTokCreativeService } from './creatives.js';
import { TikTokAudienceService } from './audiences.js';
import { TikTokCustomAudiences } from './custom-audiences.js';
import { TikTokAudienceSources } from './audience-sources.js';
import { TikTokAudienceAuthoring } from './audience-authoring.js';
import { TikTokMeasurementService } from './measurement.js';
import { TikTokAutomatedRulesService } from './automated-rules.js';
import { TikTokCatalogService } from './catalogs.js';
import { TikTokAudienceSharing } from './audience-sharing.js';
import { audienceSharingWrites } from './audience-sharing-schemas.js';
import type { TikTokCatalogAccessStore } from './catalog-access.js';

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
  advertiser_id?: string;
  campaign_id: string;
  campaign_name: string;
  operation_status: 'ENABLE' | 'DISABLE';
  secondary_status?: string;
  budget: number;
  budget_mode: string;
  objective_type: string;
}

type WritePlan = Omit<WritePreview, 'serverValidated'> & { execute: () => Promise<string[] | WriteResult> };

export class TikTokAdsProvider implements AdProvider {
  readonly id = 'tiktok';
  readonly creatives: TikTokCreativeService;
  readonly audiences: TikTokAudienceService;
  readonly customAudiences: TikTokCustomAudiences;
  readonly audienceSources: TikTokAudienceSources;
  readonly audienceAuthoring: TikTokAudienceAuthoring;
  readonly audienceSharing: TikTokAudienceSharing;
  readonly measurement: TikTokMeasurementService;
  readonly automatedRules: TikTokAutomatedRulesService;
  readonly catalogs: TikTokCatalogService;

  constructor(
    private readonly client: TikTokClient,
    private readonly app: { appId: string; secret: string },
    media: MediaResolver = new LocalMediaResolver(),
    catalogAccess?: TikTokCatalogAccessStore,
  ) {
    const authorizeAccounts = async (ids: string[]) => {
      const authorized = await client.get<{ list?: Array<{ advertiser_id: string }> }>('oauth2/advertiser/get', { app_id: this.appId(), secret: this.secret() });
      if (!Array.isArray(authorized.list) || authorized.list.some(row => typeof row.advertiser_id !== 'string') || ids.some(id => !authorized.list!.some(row => row.advertiser_id === id))) throw new AdportError('POLICY_VIOLATION', 'Every selected advertiser must be in the current native authorization.');
    };
    this.creatives = new TikTokCreativeService(client, media);
    this.audiences = new TikTokAudienceService(client);
    this.customAudiences = new TikTokCustomAudiences(client, media);
    this.audienceSources = new TikTokAudienceSources(client, account => authorizeAccounts([account]));
    this.audienceAuthoring = new TikTokAudienceAuthoring(client, this.customAudiences, this.audienceSources);
    this.audienceSharing = new TikTokAudienceSharing(client, this.customAudiences, authorizeAccounts);
    this.measurement = new TikTokMeasurementService(client);
    this.automatedRules = new TikTokAutomatedRulesService(client);
    this.catalogs = new TikTokCatalogService(client, catalogAccess, media);
  }

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
    const { execute: _execute, ...preview } = plan;
    return { ...preview, serverValidated: false };
  }

  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    const plan = await this.plan(op, guard);
    const resourceIds = await plan.execute();
    if (!Array.isArray(resourceIds)) return resourceIds;
    if (op.tool === 'tiktok_create_catalog') return { applied: true, resourceIds, details: { configuration_readback: 'VERIFIED', project_catalog_access: 'write', products_created: false, ads_created: false } };
    if (op.tool === 'tiktok_delete_catalog') return { applied: true, resourceIds, details: { deletion_readback: 'ABSENT_FROM_FILTERED_CATALOG_VIEW', resource_grant_retained: true } };
    if (op.tool === 'tiktok_upload_catalog_videos') {
      const payload = op.payload as { bc_id: string; catalog_id: string; media_id: string; expected_sha256: string; sync_to_selected_account?: boolean };
      return { applied: true, resourceIds, details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, feed_log_id: resourceIds[0], source_media_id: payload.media_id, source_sha256: payload.expected_sha256, advertiser_sync_requested: payload.sync_to_selected_account === true, advertiser_sync_confirmed: false, next_tool: 'tiktok_catalog_video_log', next_arguments: { account_id: op.accountId, bc_id: payload.bc_id, catalog_id: payload.catalog_id, feed_log_id: resourceIds[0] } } };
    }
    if (op.tool === 'tiktok_delete_catalog_video') return { applied: true, resourceIds, details: { deletion_readback: 'ABSENT_FROM_FILTERED_CATALOG_VIEW', synced_copies_may_remain: true } };
    if (['tiktok_import_catalog_file', 'tiktok_upsert_catalog_products', 'tiktok_update_catalog_products', 'tiktok_delete_catalog_products'].includes(op.tool)) {
      const payload = op.payload as { bc_id: string; catalog_id: string; feed_id: string; media_id: string; expected_sha256: string; media_assets?: unknown[] };
      return { applied: true, resourceIds, details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, feed_log_id: resourceIds[0], feed_id: payload.feed_id,
        ...(op.tool === 'tiktok_import_catalog_file' ? { source_media_id: payload.media_id, source_sha256: payload.expected_sha256 } : payload.media_assets?.length ? { source_media_assets: payload.media_assets } : {}), next_tool: 'tiktok_catalog_product_log',
        next_arguments: { account_id: op.accountId, bc_id: payload.bc_id, catalog_id: payload.catalog_id, feed_id: payload.feed_id, feed_log_id: resourceIds[0] },
      } };
    }
    return { applied: true, resourceIds };
  }

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<WritePlan> {
    if (audienceSharingWrites.has(op.tool)) return this.audienceSharing.plan(op);
    if (['tiktok_create_rule_audience', 'tiktok_create_lookalike_audience', 'tiktok_refresh_lookalike_audiences'].includes(op.tool)) return this.audienceAuthoring.plan(op);
    if (['tiktok_upload_audience_file', 'tiktok_create_customer_audience', 'tiktok_update_customer_audience_users', 'tiktok_rename_custom_audience', 'tiktok_delete_custom_audiences'].includes(op.tool)) return this.customAudiences.plan(op);
    const payload = op.payload as never;
    switch (op.tool) {
      case 'tiktok_create_catalog':
      case 'tiktok_delete_catalog':
      case 'tiktok_bind_catalog_event_sources':
      case 'tiktok_unbind_catalog_event_sources':
      case 'tiktok_upload_catalog_videos':
      case 'tiktok_delete_catalog_video':
      case 'tiktok_upsert_catalog_products':
      case 'tiktok_update_catalog_products':
      case 'tiktok_delete_catalog_products':
      case 'tiktok_create_catalog_feed':
      case 'tiktok_import_catalog_file':
      case 'tiktok_update_catalog_feed':
      case 'tiktok_set_catalog_feed_schedule_status':
      case 'tiktok_delete_catalog_feed':
      case 'tiktok_rename_product_set':
      case 'tiktok_create_product_set':
      case 'tiktok_upload_product_set':
      case 'tiktok_update_product_set_conditions':
      case 'tiktok_delete_product_sets':
      case 'tiktok_update_catalog':
      case 'tiktok_set_catalog_access':
        return this.catalogs.plan(op);
      case 'tiktok_create_pixel':
      case 'tiktok_update_pixel':
        return this.measurement.plan(op);
      case 'tiktok_create_saved_audience':
      case 'tiktok_delete_saved_audiences':
        return this.audiences.plan(op);
      case 'tiktok_create_ad_group':
      case 'tiktok_create_ads':
      case 'tiktok_set_ad_group_status':
      case 'tiktok_set_ad_status':
      case 'tiktok_update_ad':
      case 'tiktok_update_targeting':
      case 'tiktok_set_ad_group_budget':
      case 'tiktok_set_ad_group_bidding':
      case 'tiktok_upload_image':
      case 'tiktok_upload_video':
        return this.creatives.plan(op, guard);
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
      if (['campaign/create', 'adgroup/create'].includes(path) && body.operation_status !== 'DISABLE') {
        body.operation_status = 'DISABLE';
        coercions.push('operation_status set to DISABLE by policy (paused_creation)');
      }
      if (path === 'ad/create' && Array.isArray(body.creatives)) {
        for (const [index, creative] of body.creatives.entries()) if (isRecord(creative) && creative.operation_status !== 'DISABLE') {
          creative.operation_status = 'DISABLE'; coercions.push(`creatives[${index}].operation_status set to DISABLE by policy (paused_creation)`);
        }
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
    if (payload.campaign_ids.some(id => !campaigns.some(campaign => campaign.campaign_id === id && (campaign.advertiser_id === undefined || campaign.advertiser_id === accountId)))) throw new AdportError('INVALID_INPUT', 'tiktok: campaign was not found in the selected advertiser');
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
    const campaign = campaigns.find(campaign => campaign.campaign_id === payload.campaign_id);
    if (!campaign || (campaign.advertiser_id !== undefined && campaign.advertiser_id !== accountId)) {
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
  if (normalized.startsWith('optimizer/rule/')) {
    throw new AdportError('INVALID_INPUT', 'tiktok: automated-rule mutations require a verified direct-advertiser workflow with scheduled-action budget and account checks; raw dispatch cannot enforce these limits');
  }
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
  return Object.entries(value).some(([key, child]) => /budget|^(?:bid_price|conversion_bid_price|deep_cpa_bid|roas_bid)$/i.test(key) || containsTikTokBudget(child));
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
    if (/budget|^(?:bid_price|conversion_bid_price|deep_cpa_bid)$/i.test(key)) {
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
