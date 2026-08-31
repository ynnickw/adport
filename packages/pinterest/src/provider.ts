import { z } from 'zod';
import {
  AdportError, resolveDateRange, type Account, type AdProvider, type MetricName,
  type NormalizedQuery, type Report, type ReportRow, type StandardActions,
  type WriteGuard, type WriteOperation, type WritePreview, type WriteResult,
} from '@adport/core';
import { PinterestAdsClient } from './client.js';
import { accountSchema, batchResponseSchema, campaignSchema, createCampaignSchema, entitySchema, entityStatus, pinterestId, setBudgetSchema, setStatusSchema } from './schemas.js';

interface Plan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<string[]> }
const LEVEL = {
  account: { path: '', id: 'AD_ACCOUNT_ID', filter: '' },
  campaign: { path: 'campaigns', id: 'CAMPAIGN_ID', filter: 'campaign_ids' },
  ad_group: { path: 'ad_groups', id: 'AD_GROUP_ID', filter: 'ad_group_ids' },
  ad: { path: 'ads', id: 'AD_ID', filter: 'ad_ids' },
} as const;
const FIELDS = { spend: 'SPEND_IN_MICRO_DOLLAR', impressions: 'PAID_IMPRESSION', clicks: 'OUTBOUND_CLICK_1', conversions: 'TOTAL_CHECKOUT', conversion_value: 'TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR' } as const;
const DERIVED = {
  ctr: ['clicks', 'impressions', 100], cpc: ['spend', 'clicks', 1], cpm: ['spend', 'impressions', 1000],
  cpa: ['spend', 'conversions', 1], roas: ['conversion_value', 'spend', 1],
} as const;

export class PinterestAdsProvider implements AdProvider {
  readonly id = 'pinterest';
  constructor(private readonly client: PinterestAdsClient) {}
  capabilities() { return { serverDryRun: false }; }
  standardActions(): StandardActions {
    return { pauseCampaign: (accountId, campaignId) => ({ tool: 'pinterest_set_campaign_status', input: { account_id: accountId, campaign_id: campaignId, status: 'PAUSED' } }) };
  }
  private async collect<T extends { id: string }>(path: string, schema: z.ZodType<T>, params = new URLSearchParams()): Promise<T[]> {
    const result: T[] = [], bookmarks = new Set<string>(), entities = new Set<string>();
    const query = new URLSearchParams(params);
    query.set('page_size', '250');
    const pageSchema = z.object({ items: z.array(schema), bookmark: z.string().nullable().optional() });
    while (true) {
      const page = await this.client.get(path, pageSchema, query);
      for (const item of page.items) {
        if (entities.has(item.id)) throw new AdportError('PROVIDER_ERROR', 'pinterest: pagination repeated an entity');
        entities.add(item.id); result.push(item);
      }
      if (!page.bookmark) return result;
      if (bookmarks.has(page.bookmark) || bookmarks.size >= 1000) throw new AdportError('PROVIDER_ERROR', 'pinterest: pagination did not terminate');
      bookmarks.add(page.bookmark); query.set('bookmark', page.bookmark);
    }
  }
  async listAccounts(): Promise<Account[]> {
    return (await this.collect('ad_accounts', accountSchema)).map(a => ({ provider: this.id, id: a.id, name: a.name ?? a.id, ...(a.currency ? { currency: a.currency } : {}) }));
  }
  async listCampaigns(accountId: string) {
    return this.listEntities(accountId, 'campaigns', campaignSchema);
  }
  private async listEntities<T extends z.infer<typeof entitySchema>>(accountId: string, collection: string, schema: z.ZodType<T>) {
    const params = new URLSearchParams();
    // Include archived entities so historical reporting isn't silently filtered
    // to the API's ACTIVE/PAUSED default. Arrays use OpenAPI form/explode.
    for (const status of entityStatus.options) params.append('entity_statuses', status);
    const rows = await this.collect(`ad_accounts/${pinterestId.parse(accountId)}/${collection}`, schema, params);
    if (rows.some(row => row.ad_account_id !== accountId)) throw new AdportError('PROVIDER_ERROR', 'pinterest: entity account mismatch');
    return rows;
  }
  async getCampaign(accountId: string, campaignId: string) {
    const result = await this.client.get(`ad_accounts/${pinterestId.parse(accountId)}/campaigns/${pinterestId.parse(campaignId)}`, campaignSchema);
    if (result.id !== campaignId || result.ad_account_id !== accountId) throw new AdportError('PROVIDER_ERROR', 'pinterest: campaign account/ID mismatch');
    return result;
  }
  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const start = z.iso.date().parse(range.start), end = z.iso.date().parse(range.end);
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (days < 0 || days > 90) throw new AdportError('INVALID_INPUT', 'pinterest: report end must be on/after start and within 90 days');
    const limit = query.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'pinterest: report limit must be a positive integer');
    const level = LEVEL[query.level], fields = new Set<string>();
    for (const metric of query.metrics) {
      if (metric in FIELDS) fields.add(FIELDS[metric as keyof typeof FIELDS]);
      else if (metric in DERIVED) for (const dependency of DERIVED[metric as keyof typeof DERIVED].slice(0, 2)) fields.add(FIELDS[dependency as keyof typeof FIELDS]);
    }
    if (!fields.size) throw new AdportError('INVALID_INPUT', 'pinterest: report requires at least one supported metric');
    const rows: ReportRow[] = [];
    for (const id of [...new Set(query.accountIds ?? (await this.listAccounts()).map(a => a.id))]) {
      const accountId = pinterestId.parse(id), base = `ad_accounts/${accountId}`;
      const entities = query.level === 'account'
        ? [await this.client.get(base, accountSchema)]
        : await this.listEntities(accountId, level.path, entitySchema);
      if (query.level === 'account' && entities.some(e => e.id !== accountId)) throw new AdportError('PROVIDER_ERROR', 'pinterest: account ID mismatch');
      const lookup = new Map(entities.map(e => [e.id, e]));
      const seen = new Set<string>();
      for (let offset = 0; offset < entities.length; offset += 250) {
        const batch = entities.slice(offset, offset + 250), allowed = new Set(batch.map(e => e.id));
        const params = new URLSearchParams({
          start_date: start, end_date: end, granularity: 'TOTAL', columns: [level.id, ...fields].join(','),
          click_window_days: '30', view_window_days: '1', conversion_report_time: 'TIME_OF_AD_ACTION',
        });
        if (level.filter) for (const entity of batch) params.append(level.filter, entity.id);
        const data = await this.client.get(`${base}/${level.path ? `${level.path}/` : ''}analytics`, z.array(z.record(z.string(), z.unknown())), params);
        for (const row of data) {
          const entityId = pinterestId.parse(row[level.id]);
          if (!allowed.has(entityId) || seen.has(entityId)) throw new AdportError('PROVIDER_ERROR', 'pinterest: incorrectly scoped or duplicate report row');
          seen.add(entityId);
          const entity = lookup.get(entityId)!;
          rows.push({ provider: this.id, accountId, entity: { level: query.level, id: entityId, name: entity.name ?? entityId, ...(typeof entity.status === 'string' ? { status: entity.status } : {}) }, metrics: normalize(row, query.metrics) });
          if (rows.length > limit) return { rows: rows.slice(0, limit), truncated: true };
        }
      }
    }
    return { rows };
  }
  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const { execute: _execute, ...preview } = await this.plan(op, guard);
    return { ...preview, serverValidated: false };
  }
  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    return { applied: true, resourceIds: await (await this.plan(op, guard)).execute() };
  }
  private async write(accountId: string, method: 'POST' | 'PATCH', body: Record<string, unknown>) {
    const result = await this.client.mutate(`ad_accounts/${accountId}/campaigns`, method, [body], batchResponseSchema);
    const item = result.items[0];
    if (result.items.length !== 1 || !item?.data || item.exceptions?.length) throw new AdportError('PROVIDER_ERROR', 'pinterest: campaign batch item failed; inspect account before retrying');
    const parsed = campaignSchema.safeParse(item.data);
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'pinterest: campaign batch returned incomplete data; inspect account before retrying');
    const data = parsed.data;
    if (data.ad_account_id !== accountId || (body.id && data.id !== body.id)
      || Object.entries(body).some(([key, value]) => ['status', 'daily_spend_cap', 'lifetime_spend_cap'].includes(key) && data[key] !== value)) {
      throw new AdportError('PROVIDER_ERROR', 'pinterest: campaign write response mismatch; inspect before retrying');
    }
    return [data.id];
  }
  private async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const accountId = pinterestId.parse(op.accountId);
    if (op.provider !== this.id) throw new AdportError('INVALID_INPUT', 'pinterest: provider mismatch');
    if (op.tool === 'pinterest_create_campaign' && op.kind === 'create') {
      const input = createCampaignSchema.parse(op.payload);
      const { budget_type, budget_micros, ...rest } = input;
      const status = guard.forcePausedCreation ? 'PAUSED' : input.status;
      const cap = budget_type === 'DAILY' ? 'daily_spend_cap' : 'lifetime_spend_cap';
      const body = { ...rest, status, [cap]: budget_micros, is_campaign_budget_optimization: true, is_flexible_daily_budgets: false };
      return {
        summary: `Create Pinterest campaign "${input.name}"`, changes: [`+ ${JSON.stringify(body)}`],
        coercions: status !== input.status ? ['status coerced to PAUSED by policy (paused_creation)'] : [],
        budgetDeltas: [{ target: `new campaign ${budget_type} budget`, toMicros: budget_micros }],
        execute: () => this.write(accountId, 'POST', body),
      };
    }
    if (op.kind === 'update' && ['pinterest_set_campaign_status', 'pinterest_set_budget'].includes(op.tool)) {
      const input = op.tool === 'pinterest_set_budget' ? setBudgetSchema.parse(op.payload) : setStatusSchema.parse(op.payload);
      const current = await this.getCampaign(accountId, input.campaign_id);
      if ('budget_micros' in input) {
        const daily = current.daily_spend_cap ?? 0, lifetime = current.lifetime_spend_cap ?? 0;
        if (!current.is_campaign_budget_optimization || (daily > 0) === (lifetime > 0)) throw new AdportError('INVALID_INPUT', 'pinterest: campaign budget update requires CBO with exactly one existing daily/lifetime cap');
        if (current.is_flexible_daily_budgets) throw new AdportError('INVALID_INPUT', 'pinterest: flexible daily budgets may exceed the daily amount; update this campaign in Ads Manager');
        const cap = daily > 0 ? 'daily_spend_cap' : 'lifetime_spend_cap', from = daily || lifetime;
        return {
          summary: `Change Pinterest campaign "${current.name ?? current.id}" budget`, changes: [`~ ${current.id} ${cap}: ${from} → ${input.budget_micros} micros`], coercions: [],
          budgetDeltas: [{ target: `campaign ${current.id} ${cap}`, fromMicros: from, toMicros: input.budget_micros }],
          execute: () => this.write(accountId, 'PATCH', { id: current.id, [cap]: input.budget_micros }),
        };
      }
      return {
        summary: `Change Pinterest campaign "${current.name ?? current.id}" status`, changes: [`~ ${current.id} status: ${current.status ?? 'unknown'} → ${input.status}`], coercions: [], budgetDeltas: [],
        execute: () => this.write(accountId, 'PATCH', { id: current.id, status: input.status }),
      };
    }
    throw new AdportError('INVALID_INPUT', `pinterest: unsupported write ${op.tool}`);
  }
}

function normalize(row: Record<string, unknown>, requested: MetricName[]) {
  const mapped: Partial<Record<MetricName, number>> = {};
  for (const [metric, field] of Object.entries(FIELDS)) {
    const value = row[field];
    if (value === null || value === undefined) continue;
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(number) || number < 0) throw new AdportError('PROVIDER_ERROR', `pinterest: malformed ${field} metric`);
    // MICRO_DOLLAR is Pinterest's historical field name; units are always
    // micros of the advertiser's account currency, not necessarily USD.
    mapped[metric as MetricName] = number / (metric === 'spend' || metric === 'conversion_value' ? 1_000_000 : 1);
  }
  for (const [metric, [numerator, denominator, factor]] of Object.entries(DERIVED)) {
    if (mapped[numerator] !== undefined && mapped[denominator] !== undefined) mapped[metric as MetricName] = mapped[denominator] ? mapped[numerator]! / mapped[denominator]! * factor : 0;
  }
  return Object.fromEntries(requested.filter(metric => mapped[metric] !== undefined).map(metric => [metric, mapped[metric]]));
}
