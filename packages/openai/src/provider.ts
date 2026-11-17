import { randomUUID } from 'node:crypto';
import {
  AdportError, resolveDateRange, type Account, type AdProvider, type EntityLevel, type MetricName,
  type NormalizedQuery, type Report, type ReportRow, type StandardActions,
  type WriteGuard, type WriteOperation, type WritePreview, type WriteResult,
} from '@adport/core';
import type { OpenAIAdsClient } from './client.js';
import {
  accountSchema, adGroupSchema, adSchema, campaignSchema, createCampaignSchema, insightRowSchema,
  openaiId, setAdGroupStatusSchema, setAdStatusSchema, setBudgetSchema, setCampaignStatusSchema,
  type OpenAIAccount, type OpenAIInsightRow,
} from './schemas.js';

const LEVEL = { account: 'ad_account', campaign: 'campaign', ad_group: 'ad_group', ad: 'ad' } as const;
// Canonical request names; responses use flat keys (campaign.id → campaign_id, campaign.spend → spend).
const LEVEL_METRICS = ['impressions', 'clicks', 'spend'] as const;
const ACCOUNT_METRICS = ['conversions', 'order_created_attributed_sales'] as const;
const STATUS_TOOLS = {
  openai_set_campaign_status: { path: 'campaigns', label: 'campaign', schema: setCampaignStatusSchema, key: 'campaign_id', entity: campaignSchema },
  openai_set_ad_group_status: { path: 'ad_groups', label: 'ad group', schema: setAdGroupStatusSchema, key: 'ad_group_id', entity: adGroupSchema },
  openai_set_ad_status: { path: 'ads', label: 'ad', schema: setAdStatusSchema, key: 'ad_id', entity: adSchema },
} as const;

type Plan = Omit<WritePreview, 'serverValidated'> & { execute: () => Promise<WriteResult> };

export class OpenAIAdsProvider implements AdProvider {
  readonly id = 'openai';
  private account?: Promise<OpenAIAccount>;
  constructor(private readonly client: OpenAIAdsClient) {}

  capabilities() { return { serverDryRun: false }; }
  standardActions(): StandardActions {
    return { pauseCampaign: (accountId, campaignId) => ({
      tool: 'openai_set_campaign_status', input: { account_id: accountId, campaign_id: campaignId, status: 'paused' },
    }) };
  }

  /** Advertiser API keys are bound to exactly one ad account. */
  private keyAccount(): Promise<OpenAIAccount> {
    this.account ??= this.client.get('ad_account', accountSchema).catch(error => { this.account = undefined; throw error; });
    return this.account;
  }

  private async assertAccount(accountId: string): Promise<OpenAIAccount> {
    const account = await this.keyAccount();
    if (openaiId.parse(accountId) !== account.id) throw new AdportError('INVALID_INPUT', 'openai: account_id does not match the ad account of the connected API key');
    return account;
  }

  async listAccounts(): Promise<Account[]> {
    const account = await this.keyAccount();
    return [{ provider: this.id, id: account.id, name: account.name, currency: account.currency_code, timezone: account.timezone, ...(account.status ? { status: account.status } : {}) }];
  }

  async accountMetadata(accountId: string) {
    const account = await this.assertAccount(accountId);
    return { currency: account.currency_code, timezone: account.timezone };
  }

  async listCampaigns(accountId: string) {
    await this.assertAccount(accountId);
    return this.client.list('campaigns', campaignSchema, { limit: '500' });
  }
  async listAdGroups(accountId: string, campaignId?: string) {
    await this.assertAccount(accountId);
    return this.client.list('ad_groups', adGroupSchema, { limit: '500', ...(campaignId ? { campaign_id: campaignId } : {}) });
  }
  async listAds(accountId: string, adGroupId?: string) {
    await this.assertAccount(accountId);
    return this.client.list('ads', adSchema, { limit: '500', ...(adGroupId ? { ad_group_id: adGroupId } : {}) });
  }

  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const limit = query.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'openai: report limit must be a positive integer');
    const account = await this.keyAccount();
    const accountIds = [...new Set(query.accountIds ?? [account.id])];
    const rows: ReportRow[] = [];
    let truncated = false;
    for (const id of accountIds) {
      await this.assertAccount(id);
      const level = LEVEL[query.level];
      const entityFields = query.level === 'account' ? ['ad_account.id', 'ad_account.name'] : [`${level}.id`, `${level}.name`, `${level}.status`];
      const { items, truncated: more } = await this.client.list('ad_account/insights', insightRowSchema, {
        aggregation_level: level, time_granularity: 'none', limit: '2000',
        // date_range is inclusive and defaults to the ad account's time zone.
        time_ranges: [JSON.stringify({ type: 'date_range', since: range.start, until: range.end })],
        fields: [...entityFields, ...LEVEL_METRICS.map(metric => `${level}.${metric}`), ...ACCOUNT_METRICS],
      }, limit + 1);
      truncated ||= more;
      for (const row of items) rows.push(this.row(row, query.level, account, query.metrics));
    }
    return { rows: rows.slice(0, limit), ...(truncated || rows.length > limit ? { truncated: true } : {}) };
  }

  private row(row: OpenAIInsightRow, level: EntityLevel, account: OpenAIAccount, metrics: MetricName[]): ReportRow {
    const prefix = LEVEL[level];
    const entityId = level === 'account' ? (row.ad_account_id ?? account.id) : row[`${prefix}_id` as keyof OpenAIInsightRow];
    if (typeof entityId !== 'string' || !entityId) throw new AdportError('PROVIDER_ERROR', `openai: insights row is missing ${prefix}_id`);
    const name = level === 'account' ? (row.ad_account_name ?? account.name) : row[`${prefix}_name` as keyof OpenAIInsightRow];
    const status = level === 'account' ? account.status : row[`${prefix}_status` as keyof OpenAIInsightRow];
    return {
      provider: this.id, accountId: account.id, currency: account.currency_code,
      entity: { level, id: entityId, name: typeof name === 'string' && name ? name : entityId, ...(typeof status === 'string' ? { status } : {}) },
      metrics: normalize(row, metrics),
    };
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const { execute: _execute, ...preview } = await this.plan(op, guard);
    return { ...preview, serverValidated: false };
  }
  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    return (await this.plan(op, guard)).execute();
  }

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    if (op.provider !== this.id) throw new AdportError('INVALID_INPUT', 'openai: provider mismatch');
    await this.assertAccount(op.accountId);
    if (op.tool === 'openai_create_campaign' && op.kind === 'create') return this.planCreate(op, guard);
    if (op.tool === 'openai_set_budget' && op.kind === 'update') return this.planBudget(op);
    if (op.kind === 'update' && Object.hasOwn(STATUS_TOOLS, op.tool)) return this.planStatus(op);
    throw new AdportError('INVALID_INPUT', `openai: unsupported write ${op.tool}`);
  }

  private planCreate(op: WriteOperation, guard: WriteGuard): Plan {
    const input = createCampaignSchema.parse(op.payload);
    const start = input.start_time ? Math.floor(Date.parse(input.start_time) / 1000) : undefined;
    const end = input.end_time ? Math.floor(Date.parse(input.end_time) / 1000) : undefined;
    if (start !== undefined && end !== undefined && end <= start) throw new AdportError('INVALID_INPUT', 'openai: end_time must be after start_time');
    const status = guard.forcePausedCreation ? 'paused' : input.status;
    const budget = {
      ...(input.lifetime_spend_limit_micros !== undefined ? { lifetime_spend_limit_micros: input.lifetime_spend_limit_micros } : {}),
      ...(input.daily_spend_limit_micros !== undefined ? { daily_spend_limit_micros: input.daily_spend_limit_micros } : {}),
    };
    const body = {
      name: input.name, status, budget,
      ...(input.description ? { description: input.description } : {}),
      ...(input.bidding_type ? { bidding_type: input.bidding_type } : {}),
      ...(input.objective ? { objective: input.objective } : {}),
      ...(start !== undefined ? { start_time: start } : {}),
      ...(end !== undefined ? { end_time: end } : {}),
      ...(input.target_countries ? { targeting: { locations: { countries: input.target_countries } } } : {}),
    };
    return {
      summary: `Create OpenAI Ads campaign "${input.name}"`,
      changes: [`+ ${JSON.stringify(body)}`],
      coercions: status !== input.status ? ['status coerced to paused by policy (paused_creation)'] : [],
      budgetDeltas: Object.entries(budget).map(([field, value]) => ({ target: `new campaign ${field}`, toMicros: value })),
      execute: async () => {
        const created = await this.client.post('campaigns', campaignSchema, body, randomUUID());
        const mismatch = created.name !== input.name || created.status !== status
          || Object.entries(budget).some(([field, value]) => created.budget[field as keyof typeof budget] !== value);
        if (mismatch) throw new AdportError('PROVIDER_ERROR', 'openai: campaign creation receipt mismatch; reconcile before retrying', { resource_ids: [created.id] });
        return { applied: true, resourceIds: [created.id] };
      },
    };
  }

  private async planBudget(op: WriteOperation): Promise<Plan> {
    const input = setBudgetSchema.parse(op.payload);
    const current = await this.client.get(`campaigns/${input.campaign_id}`, campaignSchema);
    if (current.id !== input.campaign_id) throw new AdportError('PROVIDER_ERROR', 'openai: campaign response does not match the requested campaign');
    const previous = current.budget[input.field];
    // Send the complete budget so the other spend limit is preserved.
    const budget = { ...pickBudget(current.budget), [input.field]: input.budget_micros };
    return {
      summary: `Change OpenAI Ads campaign "${current.name}" ${input.field}`,
      changes: [`~ ${current.id} ${input.field}: ${previous ?? 'unset'} → ${input.budget_micros}`],
      fieldChanges: [{ field: input.field, before: previous === undefined ? 'unset' : String(previous), after: String(input.budget_micros) }],
      coercions: [],
      budgetDeltas: [{ target: `campaign ${current.id} ${input.field}`, ...(previous !== undefined ? { fromMicros: previous } : {}), toMicros: input.budget_micros }],
      execute: async () => {
        const updated = await this.client.post(`campaigns/${current.id}`, campaignSchema, { budget });
        if (updated.id !== current.id || updated.budget[input.field] !== input.budget_micros) throw new AdportError('PROVIDER_ERROR', 'openai: campaign budget receipt mismatch; reconcile before retrying', { resource_ids: [current.id] });
        return { applied: true, resourceIds: [current.id] };
      },
    };
  }

  private async planStatus(op: WriteOperation): Promise<Plan> {
    const spec = STATUS_TOOLS[op.tool as keyof typeof STATUS_TOOLS];
    const input = spec.schema.parse(op.payload) as Record<string, string>;
    const id = input[spec.key]!, status = input.status!;
    const current = await this.client.get(`${spec.path}/${id}`, spec.entity);
    if (current.id !== id) throw new AdportError('PROVIDER_ERROR', `openai: ${spec.label} response does not match the requested ${spec.label}`);
    return {
      summary: `${status === 'active' ? 'Activate' : 'Pause'} OpenAI Ads ${spec.label} "${current.name}"`,
      changes: [`~ ${id} status: ${current.status} → ${status}`],
      fieldChanges: [{ field: 'status', before: current.status, after: status }],
      coercions: [], budgetDeltas: [],
      execute: async () => {
        const updated = await this.client.post(`${spec.path}/${id}/${status === 'active' ? 'activate' : 'pause'}`, spec.entity);
        if (updated.id !== id || updated.status !== status) throw new AdportError('PROVIDER_ERROR', `openai: ${spec.label} status receipt mismatch; reconcile before retrying`, { resource_ids: [id] });
        return { applied: true, resourceIds: [id] };
      },
    };
  }
}

function pickBudget(budget: { lifetime_spend_limit_micros?: number; daily_spend_limit_micros?: number }) {
  return {
    ...(budget.lifetime_spend_limit_micros !== undefined ? { lifetime_spend_limit_micros: budget.lifetime_spend_limit_micros } : {}),
    ...(budget.daily_spend_limit_micros !== undefined ? { daily_spend_limit_micros: budget.daily_spend_limit_micros } : {}),
  };
}

/** Insights spend and sales are major currency units; null means unavailable, never zero. */
function normalize(row: OpenAIInsightRow, metrics: MetricName[]): Partial<Record<MetricName, number>> {
  const mapped: Partial<Record<MetricName, number>> = {};
  const fields = { spend: 'spend', impressions: 'impressions', clicks: 'clicks', conversions: 'conversions', conversion_value: 'order_created_attributed_sales' } as const;
  for (const [metric, field] of Object.entries(fields)) {
    const value = row[field];
    if (typeof value === 'number') mapped[metric as MetricName] = value;
  }
  for (const [metric, numerator, denominator, factor] of [
    ['ctr', 'clicks', 'impressions', 100], ['cpc', 'spend', 'clicks', 1], ['cpm', 'spend', 'impressions', 1000],
    ['cpa', 'spend', 'conversions', 1], ['roas', 'conversion_value', 'spend', 1],
  ] as const) {
    // A zero denominator leaves the ratio absent rather than reporting a misleading 0.
    if (mapped[numerator] !== undefined && mapped[denominator]) mapped[metric] = mapped[numerator]! / mapped[denominator]! * factor;
  }
  return Object.fromEntries(metrics.filter(metric => mapped[metric] !== undefined).map(metric => [metric, mapped[metric]]));
}
