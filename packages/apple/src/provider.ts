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
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { AppleAdsClient } from './client.js';

/** Apple Money amounts are strings in whole currency units. */
export const UNITS_TO_MICROS = 1_000_000;

interface Money {
  amount: string;
  currency: string;
}

interface AppleCampaign {
  id: number;
  adAccountId?: number;
  name: string;
  status: 'ENABLED' | 'PAUSED';
  systemStatus?: string;
  displayStatus?: string;
  dailyBudget?: { value?: Money };
  promotedObjectId?: string;
  promotedObjectType?: string;
  billingEvent?: string;
  targeting?: Record<string, unknown>;
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
  totalMetrics?: SpendRow;
  metadata?: { id?: number; name?: string; status?: string };
}

interface WritePlan {
  summary: string;
  changes: string[];
  coercions: string[];
  budgetDeltas: WritePreview['budgetDeltas'];
  execute: () => Promise<string[]>;
}

interface AppleRecommendation {
  id?: string;
  campaignId?: number;
  campaignName?: string;
  dailyBudget?: Money;
  suggestedDailyBudgetAmount?: Money;
  bidStrategy?: { bidAmount?: Money };
  recommendedTargetCPA?: Money;
}

interface AppleBiddableResource {
  id?: number;
  name?: string;
  bid?: Money;
  bidStrategy?: { bidStrategyType?: string; bidStrategyGoal?: string; bid?: Money };
}

const APPLE_READ_GET_ROOTS = /^(?:acls|me|advertiser-resources|ad-accounts\/[^/?]+|adgroups\/[^/?]+|ads\/[^/?]+|apps\/[^/?]+|assets\/[^/?]+|business-brands\/[^/?]+|business-categories\/[^/?]+|campaigns\/[^/?]+(?:\/legacy-app-limited-status-reason-details)?|change-history\/[^/?]+|creatives\/[^/?]+|keywords\/[^/?]+|location-groups\/[^/?]+|locations\/[^/?]+|negative-keywords\/[^/?]+|orgs\/[^/?]+|product-pages\/[^/?]+|rejection-reasons\/apps\/[^/?]+|shared-budgets\/[^/?]+|search\/(?:apps|geo))(?:\?.*)?$/;
const APPLE_READ_POST_ROOTS = /^(?:(?:adgroups|ads|assets|business-brands|business-categories|campaigns|change-history|creatives|eligibilities\/apps|insights\/apps\/(?:impression-share|search-term-popularity)|keywords|location-groups|locations|metadata\/apps\/supported-languages|negative-keywords|product-pages(?:\/locale-details)?|recommendations\/(?:daily-budgets|target-cpas)|rejection-reasons\/(?:apps|business-brands)|reports\/(?:apps|business-brands)\/(?:adgroups|ads|campaigns|keywords|searchterms)|shared-budgets|suggestions\/(?:categories|keywords|phrases|target-cpas))\/query|apps\/[^/?]+\/locale-details\/query|search\/geo)$/;
const APPLE_CREATE_PATHS = /^(?:ad-accounts|adgroups|ads|campaigns|creatives|keywords|keywords\/bulk-create|location-groups|negative-keywords|negative-keywords\/bulk-create|shared-budgets)$/;
const APPLE_UPDATE_PATHS = /^(?:ad-accounts|adgroups|ads|campaigns|creatives|keywords|location-groups|negative-keywords|shared-budgets)\/[^/?]+$|^(?:keywords|negative-keywords)\/bulk-update$/;
const APPLE_DELETE_PATHS = /^(?:adgroups|ads|assets|campaigns|creatives|keywords|location-groups|negative-keywords|shared-budgets)\/[^/?]+$/;

export class AppleAdsProvider implements AdProvider {
  readonly id = 'apple';

  constructor(private readonly client: AppleAdsClient) {}

  capabilities(): ProviderCapabilities {
    // The Platform API has no validate-only mode — previews remain client-side.
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

  /** v1 exposes one ACL entry per ad account. */
  async listAccounts(): Promise<Account[]> {
    const envelope = await this.client.request<{
      acls?: Array<{ adAccount?: { id?: number; name?: string; orgId?: number }; roles?: string[] }>;
    }>('GET', 'acls');
    return (envelope.result?.acls ?? []).flatMap((acl) => (acl.adAccount?.id === undefined ? [] : [{
      provider: this.id,
      id: String(acl.adAccount.id),
      name: acl.adAccount.name ?? String(acl.adAccount.id),
      status: acl.roles?.join(',') || undefined,
    }]));
  }

  async listCampaigns(adAccountId: string, limit = 100): Promise<AppleCampaign[]> {
    const envelope = await this.client.request<AppleCampaign[]>('POST', 'campaigns/query', {
      adAccountId,
      body: { pagination: { offset: 0, pageSize: limit, fetchTotalCount: false } },
    });
    return envelope.result ?? [];
  }

  async getCampaign(adAccountId: string, campaignId: string): Promise<AppleCampaign> {
    const envelope = await this.client.request<AppleCampaign>('GET', `campaigns/${campaignId}`, { adAccountId });
    const campaign = envelope.result;
    if (!campaign) {
      throw new AdportError('PROVIDER_ERROR', `apple: campaign ${campaignId} not found in ad account ${adAccountId}`);
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
    const allowed = input.method === 'GET' ? APPLE_READ_GET_ROOTS.test(path) : APPLE_READ_POST_ROOTS.test(path);
    if (!allowed) {
      throw new AdportError('INVALID_INPUT', `apple: unsupported read path "${path}"`);
    }
    const envelope = await this.client.request(input.method, path, {
      ...(input.account_id ? { adAccountId: input.account_id } : {}),
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
    for (const adAccountId of accountIds) {
      const envelope = await this.client.request<{ rows?: ReportingRow[] }>(
        'POST',
        'reports/apps/campaigns/query',
        {
          adAccountId,
          body: {
            pagination: { offset: 0, pageSize: Math.min(query.limit ?? 200, 5000) },
            sorting: [{ field: 'id', order: 'ASC' }],
            timeRange: { start: range.start, end: range.end, timeZone: 'UTC' },
            options: { includeRows: ['GRAND_TOTAL'] },
          },
        },
      );
      const providerRows = (envelope.result?.rows ?? []).map((row) =>
        this.toReportRow(row, adAccountId, query),
      );
      if (query.level === 'account') {
        if (providerRows.length > 0) rows.push(aggregateAccountRows(providerRows, this.id, adAccountId));
      } else {
        rows.push(...providerRows);
      }
    }
    return { rows };
  }

  private toReportRow(row: ReportingRow, adAccountId: string, query: NormalizedQuery): ReportRow {
    const total = row.totalMetrics ?? {};
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
      accountId: adAccountId,
      entity: {
        level: 'campaign',
        id: String(row.metadata?.id ?? ''),
        name: row.metadata?.name ?? '',
        status: row.metadata?.status,
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
      case 'apple_create_ad_group':
        return this.planCreateAdGroup(op.accountId, payload, guard);
      case 'apple_create_keyword':
        return this.planCreateKeyword(op.accountId, payload, guard);
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
      case 'apple_upload_asset':
        return this.planUploadAsset(op.accountId, payload);
      case 'apple_apply_recommendations':
        return this.planApplyRecommendations(op.accountId, payload);
      case 'apple_dismiss_recommendations':
        return this.planDismissRecommendations(op.accountId, payload);
      case 'apple_set_bid':
        return this.planSetBid(op.accountId, payload);
      case 'apple_set_shared_budget':
        return this.planSetSharedBudget(op.accountId, payload);
      default:
        throw new AdportError('PROVIDER_ERROR', `apple: unsupported write tool ${op.tool}`);
    }
  }

  private async planCreateCampaign(
    adAccountId: string,
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
    const body = {
      adAccountId: Number(adAccountId),
      name: payload.name,
      promotedObjectType: 'APPSTORE_APP',
      promotedObjectId: String(payload.adam_id),
      dailyBudget: { value: { amount: String(payload.daily_budget), currency: payload.currency } },
      billingEvent: 'TAPS',
      bidStrategy: { bidStrategyType: 'MANUAL_CPT', bidStrategyGoal: 'TAP' },
      targeting: {
        countryOrRegion: { include: payload.countries_or_regions },
        supplyPlacement: { include: ['APPSTORE_SEARCH_RESULTS'] },
      },
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
        const envelope = await this.client.request<AppleCampaign>('POST', 'campaigns', { adAccountId, body });
        return envelope.result?.id ? [String(envelope.result.id)] : [];
      },
    };
  }

  private async planSetStatus(
    adAccountId: string,
    payload: { campaign_id: string; status: 'ENABLED' | 'PAUSED' },
  ): Promise<WritePlan> {
    const current = await this.getCampaign(adAccountId, payload.campaign_id);
    return {
      summary: `Set Apple campaign "${current.name}" status ${current.status} → ${payload.status}`,
      changes: [`~ campaign ${payload.campaign_id} status ${current.status} → ${payload.status}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        await this.client.request('PUT', `campaigns/${payload.campaign_id}`, {
          adAccountId,
          body: { status: payload.status },
        });
        return [payload.campaign_id];
      },
    };
  }

  private async planCreateAdGroup(
    adAccountId: string,
    payload: {
      campaign_id: string;
      name: string;
      bid: number;
      currency: string;
      status?: 'ENABLED' | 'PAUSED';
      device_classes?: Array<'IPHONE' | 'IPAD'>;
      automated_keywords_opt_in?: boolean;
      start_time?: string;
      end_time?: string;
    },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const coercions: string[] = [];
    let status = payload.status ?? 'ENABLED';
    if (guard.forcePausedCreation && status === 'ENABLED') {
      status = 'PAUSED';
      coercions.push('status coerced to PAUSED by policy (paused_creation)');
    }
    const body = {
      campaignId: Number(payload.campaign_id),
      name: payload.name,
      pricingModel: 'CPT',
      status,
      bidStrategy: {
        bidStrategyType: 'MANUAL_CPT',
        bidStrategyGoal: 'TAP',
        bid: { amount: String(payload.bid), currency: payload.currency },
      },
      ...(payload.device_classes?.length
        ? { targeting: { deviceClass: { include: payload.device_classes } } }
        : {}),
      ...(payload.automated_keywords_opt_in !== undefined
        ? { automatedKeywordsOptIn: payload.automated_keywords_opt_in }
        : {}),
      ...(payload.start_time ? { startTime: payload.start_time } : {}),
      ...(payload.end_time ? { endTime: payload.end_time } : {}),
    };
    return {
      summary: `Create Apple Ads ad group "${payload.name}" (${status}) — bid ${payload.bid} ${payload.currency}`,
      changes: [`+ ad group "${payload.name}" campaign=${payload.campaign_id} status=${status}`],
      coercions,
      budgetDeltas: [{
        target: `new ad group "${payload.name}" bid`,
        toMicros: payload.bid * UNITS_TO_MICROS,
      }],
      execute: async () => {
        const envelope = await this.client.request<{ id?: number }>('POST', 'adgroups', { adAccountId, body });
        return envelope.result?.id ? [String(envelope.result.id)] : [];
      },
    };
  }

  private async planCreateKeyword(
    adAccountId: string,
    payload: {
      ad_group_id: string;
      text: string;
      match_type: 'BROAD' | 'EXACT';
      bid?: number;
      currency?: string;
      status?: 'ENABLED' | 'PAUSED';
    },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const coercions: string[] = [];
    let status = payload.status ?? 'ENABLED';
    if (guard.forcePausedCreation && status === 'ENABLED') {
      status = 'PAUSED';
      coercions.push('status coerced to PAUSED by policy (paused_creation)');
    }
    if ((payload.bid === undefined) !== (payload.currency === undefined)) {
      throw new AdportError('INVALID_INPUT', 'apple: keyword bid and currency must be provided together');
    }
    const body = {
      adGroupId: Number(payload.ad_group_id),
      text: payload.text,
      matchType: payload.match_type,
      status,
      ...(payload.bid !== undefined && payload.currency
        ? { bid: { amount: String(payload.bid), currency: payload.currency } }
        : {}),
    };
    return {
      summary: `Create Apple Ads ${payload.match_type.toLowerCase()} keyword "${payload.text}" (${status})`,
      changes: [`+ keyword "${payload.text}" adGroup=${payload.ad_group_id} match=${payload.match_type} status=${status}`],
      coercions,
      budgetDeltas: payload.bid === undefined ? [] : [{
        target: `new keyword "${payload.text}" bid`,
        toMicros: payload.bid * UNITS_TO_MICROS,
      }],
      execute: async () => {
        const envelope = await this.client.request<{ id?: number }>('POST', 'keywords', { adAccountId, body });
        return envelope.result?.id ? [String(envelope.result.id)] : [];
      },
    };
  }

  private async planSetBudget(
    adAccountId: string,
    payload: { campaign_id: string; daily_budget: number },
  ): Promise<WritePlan> {
    const current = await this.getCampaign(adAccountId, payload.campaign_id);
    const fromAmount = current.dailyBudget?.value ? Number(current.dailyBudget.value.amount) : undefined;
    const currency = current.dailyBudget?.value?.currency ?? 'USD';
    return {
      summary: `Change Apple campaign "${current.name}" daily budget ${fromAmount ?? '(unset)'} → ${payload.daily_budget} ${currency}`,
      changes: [`~ campaign ${payload.campaign_id} dailyBudget.value ${fromAmount ?? '(unset)'} → ${payload.daily_budget}`],
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
          adAccountId,
          body: { dailyBudget: { value: { amount: String(payload.daily_budget), currency } } },
        });
        return [payload.campaign_id];
      },
    };
  }

  private async planApiCreate(
    adAccountId: string,
    payload: { path: string; body: Record<string, unknown> },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const path = validateMutationPath(payload.path, 'create');
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
        // Ad-account creation is org-scoped. Apple explicitly rejects the
        // account context used by every other create endpoint.
        const envelope = await this.client.request<unknown>('POST', path, {
          ...(path === 'ad-accounts' ? {} : { adAccountId }),
          body,
        });
        return extractResourceIds(envelope.result);
      },
    };
  }

  private async planApiUpdate(
    adAccountId: string,
    payload: { path: string; body: Record<string, unknown> },
  ): Promise<WritePlan> {
    const path = validateMutationPath(payload.path, 'update');
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
        const method = path.endsWith('/bulk-update') ? 'POST' : 'PUT';
        const envelope = await this.client.request<unknown>(method, path, { adAccountId, body: payload.body });
        return extractResourceIds(envelope.result, path);
      },
    };
  }

  private async planApiDelete(adAccountId: string, payload: { path: string }): Promise<WritePlan> {
    const path = validateMutationPath(payload.path, 'delete');
    return {
      summary: `Delete Apple Ads resource via DELETE /${path}`,
      changes: [`- DELETE /${path}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        await this.client.request('DELETE', path, { adAccountId });
        return [path.split('/').at(-1)!];
      },
    };
  }

  private async planUploadAsset(
    adAccountId: string,
    payload: {
      file_path: string;
      expected_sha256: string;
      promoted_object_id: string;
      promoted_object_type: 'BUSINESS_BRAND';
    },
  ): Promise<WritePlan> {
    const file = await readFile(payload.file_path);
    const actualSha256 = createHash('sha256').update(file).digest('hex');
    if (actualSha256 !== payload.expected_sha256.toLowerCase()) {
      throw new AdportError(
        'INVALID_INPUT',
        `apple: asset SHA-256 mismatch for ${payload.file_path}; expected ${payload.expected_sha256}, got ${actualSha256}`,
      );
    }
    const contentType = assetContentType(payload.file_path);
    return {
      summary: `Upload Apple Ads asset ${basename(payload.file_path)} (${file.byteLength} bytes)`,
      changes: [`+ asset sha256=${actualSha256} promotedObject=${payload.promoted_object_id}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        const form = new FormData();
        form.append('file', new Blob([file], { type: contentType }), basename(payload.file_path));
        form.append('promotedObjectId', payload.promoted_object_id);
        form.append('promotedObjectType', payload.promoted_object_type);
        const envelope = await this.client.request<unknown>('POST', 'assets/upload', { adAccountId, form });
        return extractResourceIds(envelope.result);
      },
    };
  }

  private async planApplyRecommendations(
    adAccountId: string,
    payload: {
      category: 'daily_budget' | 'target_cpa';
      promoted_object_id: string;
      promoted_object_type: 'APPSTORE_APP' | 'BUSINESS_BRAND';
      recommendations: Array<{ id: string; applied_amount?: number; currency?: string }>;
    },
  ): Promise<WritePlan> {
    const apiCategory = payload.category === 'daily_budget' ? 'daily-budgets' : 'target-cpas';
    const envelope = await this.client.request<AppleRecommendation[]>('POST', `recommendations/${apiCategory}/query`, {
      adAccountId,
      body: {
        filters: [
          { field: 'promotedObjectId', operator: 'EQUALS', value: [payload.promoted_object_id] },
          { field: 'promotedObjectType', operator: 'EQUALS', value: [payload.promoted_object_type] },
        ],
        pagination: { offset: 0, pageSize: 100 },
      },
    });
    const byId = new Map((envelope.result ?? []).map((recommendation) => [recommendation.id, recommendation]));
    const budgetDeltas: WritePreview['budgetDeltas'] = [];
    const requestBody = payload.recommendations.map((item) => {
      const recommendation = byId.get(item.id);
      if (!recommendation) {
        throw new AdportError('INVALID_INPUT', `apple: recommendation ${item.id} was not returned by the current v1 query`);
      }
      const current = payload.category === 'daily_budget'
        ? recommendation.dailyBudget
        : recommendation.bidStrategy?.bidAmount;
      const suggested = payload.category === 'daily_budget'
        ? recommendation.suggestedDailyBudgetAmount
        : recommendation.recommendedTargetCPA;
      const amount = item.applied_amount ?? Number(suggested?.amount);
      const currency = item.currency ?? suggested?.currency ?? current?.currency;
      if (!Number.isFinite(amount) || amount <= 0 || !currency) {
        throw new AdportError('INVALID_INPUT', `apple: recommendation ${item.id} has no usable proposed Money value`);
      }
      budgetDeltas.push({
        target: `${payload.category} recommendation ${item.id}${recommendation.campaignName ? ` (${recommendation.campaignName})` : ''}`,
        ...(current?.amount !== undefined ? { fromMicros: Number(current.amount) * UNITS_TO_MICROS } : {}),
        toMicros: amount * UNITS_TO_MICROS,
      });
      return {
        id: item.id,
        promotedObjectId: payload.promoted_object_id,
        promotedObjectType: payload.promoted_object_type,
        ...(payload.category === 'daily_budget'
          ? { appliedDailyBudget: { amount: String(amount), currency } }
          : { appliedTargetCPA: { amount: String(amount), currency } }),
      };
    });
    return {
      summary: `Apply ${requestBody.length} Apple Ads ${payload.category.replace('_', ' ')} recommendation(s)`,
      changes: requestBody.map((item) => `~ apply recommendation ${item.id}`),
      coercions: [],
      budgetDeltas,
      execute: async () => {
        const applied = await this.client.request<unknown[]>('POST', `recommendations/${apiCategory}/apply`, {
          adAccountId,
          body: requestBody,
        });
        return extractResourceIds(applied.result).length > 0
          ? extractResourceIds(applied.result)
          : requestBody.map((item) => item.id);
      },
    };
  }

  private async planDismissRecommendations(
    adAccountId: string,
    payload: {
      category: 'daily_budget' | 'target_cpa';
      promoted_object_id: string;
      promoted_object_type: 'APPSTORE_APP' | 'BUSINESS_BRAND';
      recommendation_ids: string[];
    },
  ): Promise<WritePlan> {
    const apiCategory = payload.category === 'daily_budget' ? 'daily-budgets' : 'target-cpas';
    const body = payload.recommendation_ids.map((id) => ({
      id,
      promotedObjectId: payload.promoted_object_id,
      promotedObjectType: payload.promoted_object_type,
    }));
    return {
      summary: `Dismiss ${body.length} Apple Ads ${payload.category.replace('_', ' ')} recommendation(s)`,
      changes: body.map((item) => `~ dismiss recommendation ${item.id}`),
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        await this.client.request('POST', `recommendations/${apiCategory}/dismiss`, { adAccountId, body });
        return payload.recommendation_ids;
      },
    };
  }

  private async planSetBid(
    adAccountId: string,
    payload: {
      resource_type: 'campaign' | 'ad_group' | 'keyword';
      resource_id: string;
      amount: number;
      currency?: string;
    },
  ): Promise<WritePlan> {
    const collection = payload.resource_type === 'ad_group' ? 'adgroups' : `${payload.resource_type}s`;
    const envelope = await this.client.request<AppleBiddableResource>('GET', `${collection}/${payload.resource_id}`, {
      adAccountId,
    });
    const current = envelope.result;
    if (!current) throw new AdportError('PROVIDER_ERROR', `apple: ${payload.resource_type} ${payload.resource_id} not found`);
    const currentMoney = payload.resource_type === 'keyword' ? current.bid : current.bidStrategy?.bid;
    const currency = payload.currency ?? currentMoney?.currency;
    if (!currency) {
      throw new AdportError('INVALID_INPUT', 'apple: currency is required when the resource has no existing bid');
    }
    const money = { amount: String(payload.amount), currency };
    const body = payload.resource_type === 'keyword'
      ? { bid: money }
      : { bidStrategy: { ...current.bidStrategy, bid: money } };
    return {
      summary: `Change Apple ${payload.resource_type.replace('_', ' ')} "${current.name ?? payload.resource_id}" bid ${currentMoney?.amount ?? '(unset)'} → ${payload.amount} ${currency}`,
      changes: [`~ ${collection}/${payload.resource_id} bid ${currentMoney?.amount ?? '(unset)'} → ${payload.amount}`],
      coercions: [],
      budgetDeltas: [{
        target: `${payload.resource_type} ${payload.resource_id} bid`,
        ...(currentMoney?.amount !== undefined ? { fromMicros: Number(currentMoney.amount) * UNITS_TO_MICROS } : {}),
        toMicros: payload.amount * UNITS_TO_MICROS,
      }],
      execute: async () => {
        await this.client.request('PUT', `${collection}/${payload.resource_id}`, { adAccountId, body });
        return [payload.resource_id];
      },
    };
  }

  private async planSetSharedBudget(
    adAccountId: string,
    payload: { shared_budget_id: string; amount: number; currency?: string },
  ): Promise<WritePlan> {
    const envelope = await this.client.request<{ id?: number; name?: string; value?: Money }>(
      'GET', `shared-budgets/${payload.shared_budget_id}`, { adAccountId },
    );
    const current = envelope.result;
    if (!current) throw new AdportError('PROVIDER_ERROR', `apple: shared budget ${payload.shared_budget_id} not found`);
    const currency = payload.currency ?? current.value?.currency;
    if (!currency) throw new AdportError('INVALID_INPUT', 'apple: currency is required when the shared budget has no existing value');
    return {
      summary: `Change Apple shared budget "${current.name ?? payload.shared_budget_id}" ${current.value?.amount ?? '(unset)'} → ${payload.amount} ${currency}`,
      changes: [`~ shared-budgets/${payload.shared_budget_id} value ${current.value?.amount ?? '(unset)'} → ${payload.amount}`],
      coercions: [],
      budgetDeltas: [{
        target: `shared budget ${payload.shared_budget_id}`,
        ...(current.value?.amount !== undefined ? { fromMicros: Number(current.value.amount) * UNITS_TO_MICROS } : {}),
        toMicros: payload.amount * UNITS_TO_MICROS,
      }],
      execute: async () => {
        await this.client.request('PUT', `shared-budgets/${payload.shared_budget_id}`, {
          adAccountId,
          body: { value: { amount: String(payload.amount), currency } },
        });
        return [payload.shared_budget_id];
      },
    };
  }
}

function assetContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.heic': return 'image/heic';
    default:
      throw new AdportError('INVALID_INPUT', 'apple: asset file must be PNG, JPG/JPEG, or HEIC');
  }
}

function normalizeApiPath(path: string): string {
  const normalized = path.replace(/^\/+/, '').trim();
  if (!normalized || normalized.includes('://') || normalized.includes('..') || normalized.includes('#')) {
    throw new AdportError('INVALID_INPUT', 'apple: path must be a relative API path without traversal or fragments');
  }
  return normalized;
}

function validateMutationPath(path: string, operation: 'create' | 'update' | 'delete'): string {
  const normalized = normalizeApiPath(path);
  const allowed = operation === 'create'
    ? APPLE_CREATE_PATHS.test(normalized)
    : operation === 'update'
      ? APPLE_UPDATE_PATHS.test(normalized)
      : APPLE_DELETE_PATHS.test(normalized);
  if (!allowed) {
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

function isMoneyRecord(value: unknown): value is Record<string, unknown> & { amount: string | number } {
  return isRecord(value) && (typeof value.amount === 'string' || typeof value.amount === 'number') &&
    (value.currency === undefined || typeof value.currency === 'string');
}

function containsMoneyField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMoneyField);
  if (!isRecord(value)) return false;
  if (isMoneyRecord(value)) return true;
  return Object.entries(value).some(([key, child]) => isMoneyKey(key) || containsMoneyField(child));
}

function collectCreatedMoney(value: unknown, path = 'body'): WritePreview['budgetDeltas'] {
  const deltas: WritePreview['budgetDeltas'] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => deltas.push(...collectCreatedMoney(item, `${path}[${index}]`)));
    return deltas;
  }
  if (!isRecord(value)) return deltas;
  if (isMoneyRecord(value)) {
    const amount = Number(value.amount);
    return Number.isFinite(amount) && amount >= 0
      ? [{ target: path, toMicros: Math.round(amount * UNITS_TO_MICROS) }]
      : [];
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isMoneyKey(key) && !isMoneyRecord(child)) {
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
