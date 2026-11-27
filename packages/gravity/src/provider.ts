import { z } from 'zod';
import {
  AdportError, resolveDateRange, type Account, type AdProvider, type EntityLevel, type MetricName,
  type NormalizedQuery, type Report, type ReportRow, type StandardActions,
  type WriteGuard, type WriteOperation, type WritePreview, type WriteResult,
} from '@adport/core';
import type { GravityClient } from './client.js';
import {
  adGroupMetricsSchema, adGroupSchema, adSchema, adUnitMetricsSchema, advertiserSchema, campaignListSchema, campaignSchema,
  createAdGroupSchema, createAdSchema, createCampaignSchema, createPixelSchema, gravityId, metricsSchema, pixelSchema,
  setAdGroupStatusSchema, setAdStatusSchema, setBudgetSchema, setCampaignStatusSchema,
  type GravityAdvertiser, type GravityTotals,
} from './schemas.js';

/** Spend and budgets are dollars; Gravity documents no other account currency. */
const CURRENCY = 'USD';
/** Report days are cut in this IANA zone (the API default); `tz` is sent explicitly. */
const REPORT_TZ = 'UTC';
const STATUS_TOOLS = {
  gravity_set_campaign_status: { path: 'campaigns', label: 'campaign', schema: setCampaignStatusSchema, key: 'campaign_id', entity: campaignSchema, id: (value: { campaign_id: string }) => value.campaign_id },
  gravity_set_ad_group_status: { path: 'ad-groups', label: 'ad group', schema: setAdGroupStatusSchema, key: 'ad_group_id', entity: adGroupSchema, id: (value: { id: string }) => value.id },
  gravity_set_ad_status: { path: 'ads', label: 'ad', schema: setAdStatusSchema, key: 'ad_id', entity: adSchema, id: (value: { id: string }) => value.id },
} as const;

type Plan = Omit<WritePreview, 'serverValidated'> & { execute: () => Promise<WriteResult> };
type Named = { name?: string | null; status?: string | null; source?: string | null; headline?: string | null };

export class GravityProvider implements AdProvider {
  readonly id = 'gravity';
  private advertiser?: Promise<GravityAdvertiser>;
  constructor(private readonly client: GravityClient) {}
  /** API access for read tools; callers check the account first. */
  get api(): GravityClient { return this.client; }

  capabilities() { return { serverDryRun: false }; }
  standardActions(): StandardActions {
    return { pauseCampaign: (accountId, campaignId) => ({
      tool: 'gravity_set_campaign_status', input: { account_id: accountId, campaign_id: campaignId, status: 'paused' },
    }) };
  }

  /** The advertiser API key belongs to exactly one advertiser account. */
  private keyAccount(): Promise<GravityAdvertiser> {
    this.advertiser ??= this.client.get('info', advertiserSchema).catch(error => { this.advertiser = undefined; throw error; });
    return this.advertiser;
  }

  async assertAccount(accountId: string): Promise<GravityAdvertiser> {
    const advertiser = await this.keyAccount();
    if (gravityId.parse(accountId) !== advertiser.advertiser_id) throw new AdportError('INVALID_INPUT', 'gravity: account_id does not match the advertiser of the connected API key');
    return advertiser;
  }

  async listAccounts(): Promise<Account[]> {
    const advertiser = await this.keyAccount();
    // The profile also returns the login email; it is deliberately not surfaced.
    return [{ provider: this.id, id: advertiser.advertiser_id, name: advertiser.name || advertiser.advertiser_id, currency: CURRENCY, timezone: REPORT_TZ }];
  }

  async accountMetadata(accountId: string) {
    await this.assertAccount(accountId);
    return { currency: CURRENCY, timezone: REPORT_TZ };
  }

  async listCampaigns(accountId: string, status?: string) {
    await this.assertAccount(accountId);
    return { items: (await this.client.get('campaigns', campaignListSchema, { status })).campaigns };
  }
  async listAdGroups(accountId: string, campaignId?: string, includeArchived = false) {
    await this.assertAccount(accountId);
    return { items: await this.client.get('ad-groups', z.array(adGroupSchema), { campaign_id: campaignId, include_archived: includeArchived ? 'true' : undefined }) };
  }

  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const limit = query.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'gravity: report limit must be a positive integer');
    const advertiser = await this.keyAccount();
    for (const id of new Set(query.accountIds ?? [advertiser.advertiser_id])) await this.assertAccount(id);
    const window = { start_date: range.start, end_date: range.end, tz: REPORT_TZ };
    const row = (level: EntityLevel, id: string, name: string | null | undefined, status: string | null | undefined, totals: GravityTotals): ReportRow => ({
      provider: this.id, accountId: advertiser.advertiser_id, currency: CURRENCY,
      entity: { level, id, name: name || id, ...(status ? { status } : {}) },
      metrics: normalize(totals, query.metrics),
    });

    if (query.level === 'account') {
      const totals = await this.client.get('metrics', metricsSchema, window);
      return { rows: [row('account', advertiser.advertiser_id, advertiser.name, undefined, totals)] };
    }
    if (query.level === 'campaign') {
      // /metrics returns one campaign at a time; /campaigns only carries lifetime totals.
      const campaigns = (await this.client.get('campaigns', campaignListSchema)).campaigns;
      const selected = campaigns.slice(0, limit), rows: ReportRow[] = [];
      for (let i = 0; i < selected.length; i += 5) {
        const batch = await Promise.all(selected.slice(i, i + 5).map(async campaign =>
          row('campaign', campaign.campaign_id, campaign.name, campaign.status, await this.client.get('metrics', metricsSchema, { ...window, campaign_id: campaign.campaign_id }))));
        rows.push(...batch);
      }
      return { rows, ...(campaigns.length > limit ? { truncated: true } : {}) };
    }
    if (query.level === 'ad_group') return this.adGroupReport(window, limit, row);
    const { ad_units } = await this.client.get('ad-unit-metrics', adUnitMetricsSchema, window);
    const rows = ad_units.slice(0, limit).map(unit => {
      // Gravity reports campaign/unit links. The same unit can serve in multiple campaigns.
      const name = `${unit.name || unit.ad_unit_id} · ${unit.campaign_id}${unit.data_source === 'campaign_fallback' ? ' (campaign totals)' : ''}`;
      const totals = { total_impressions: unit.total_impressions, total_clicks: unit.total_clicks, total_spend: unit.total_spend };
      return row('ad', `${unit.campaign_id}/${unit.ad_unit_id}`, name, undefined, totals);
    });
    return { rows, ...(ad_units.length > limit ? { truncated: true } : {}) };
  }

  private async adGroupReport(window: Record<string, string>, limit: number,
    row: (level: EntityLevel, id: string, name: string | null | undefined, status: string | null | undefined, totals: GravityTotals) => ReportRow): Promise<Report> {
    const rows: ReportRow[] = [];
    const seen = new Set<string>();
    for (let offset = 0, pages = 0; ; pages++) {
      if (pages >= 100) throw new AdportError('PROVIDER_ERROR', 'gravity: pagination did not terminate; refusing incomplete results');
      const page = await this.client.get('ad-group-metrics', adGroupMetricsSchema, { ...window, offset: String(offset) });
      if (page.offset !== undefined && page.offset !== offset) throw new AdportError('PROVIDER_ERROR', 'gravity: ad group metrics returned the wrong page offset');
      for (const group of page.ad_groups) {
        if (seen.has(group.ad_group_id)) throw new AdportError('PROVIDER_ERROR', 'gravity: ad group metrics returned overlapping rows');
        seen.add(group.ad_group_id);
        rows.push(row('ad_group', group.ad_group_id, group.name, group.status, group));
      }
      if (rows.length > limit || (rows.length === limit && page.truncated)) return { rows: rows.slice(0, limit), truncated: true };
      if (!page.truncated) return { rows };
      if (!page.ad_groups.length) throw new AdportError('PROVIDER_ERROR', 'gravity: ad group metrics are truncated but the page is empty');
      offset += page.ad_groups.length;
    }
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const { execute: _execute, ...preview } = await this.plan(op, guard);
    return { ...preview, serverValidated: false };
  }
  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    return (await this.plan(op, guard)).execute();
  }

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    if (op.provider !== this.id) throw new AdportError('INVALID_INPUT', 'gravity: provider mismatch');
    await this.assertAccount(op.accountId);
    if (op.tool === 'gravity_create_campaign' && op.kind === 'create') return this.planCreate(op, guard);
    if (op.tool === 'gravity_create_ad_group' && op.kind === 'create') return this.planAdGroup(op, guard);
    if (op.tool === 'gravity_create_ad' && op.kind === 'create') return this.planAd(op, guard);
    if (op.tool === 'gravity_create_pixel' && op.kind === 'create') return this.planPixel(op);
    if (op.tool === 'gravity_set_budget' && op.kind === 'update') return this.planBudget(op);
    if (op.kind === 'update' && Object.hasOwn(STATUS_TOOLS, op.tool)) return this.planStatus(op);
    throw new AdportError('INVALID_INPUT', `gravity: unsupported write ${op.tool}`);
  }

  private planCreate(op: WriteOperation, guard: WriteGuard): Plan {
    const input = createCampaignSchema.parse(op.payload);
    // A draft never serves; only an active request is coerced.
    const status = guard.forcePausedCreation && input.status === 'active' ? 'paused' : input.status;
    const budget = input.daily_budget_micros !== undefined
      ? { budget_type: 'daily', daily_budget: dollars(input.daily_budget_micros) }
      : { budget_type: 'total', total_budget: dollars(input.total_budget_micros!) };
    const adGroup = {
      name: input.ad_group_name ?? `${input.name} (Generative)`, group_type: 'generative', context: input.context,
      ...(input.negative_context ? { negative_context: input.negative_context } : {}),
      ...(input.brand_name ? { brand_name: input.brand_name } : {}),
    };
    const body = {
      name: input.name, landing_page: input.landing_page, status, campaign_objective: input.campaign_objective, ...budget,
      ...(input.conversion_type ? { conversion_type: input.conversion_type } : {}),
      ...(input.start_time ? { start_time: input.start_time } : {}),
      ...(input.end_time ? { end_time: input.end_time } : {}),
      ...(input.allowed_countries ? { allowed_countries: input.allowed_countries } : {}),
      ...(input.allowed_devices ? { allowed_devices: input.allowed_devices } : {}),
      ...(input.english_only !== undefined ? { english_only: input.english_only } : {}),
      ad_groups: [adGroup],
    };
    const budgetField = input.daily_budget_micros !== undefined ? 'daily_budget' : 'total_budget';
    return {
      summary: `Create Gravity campaign "${input.name}" (${status})`,
      changes: [`+ ${JSON.stringify(body)}`],
      coercions: status !== input.status ? ['status coerced to paused by policy (paused_creation)'] : [],
      budgetDeltas: [{ target: `new campaign ${budgetField}`, toMicros: (input.daily_budget_micros ?? input.total_budget_micros)! }],
      execute: async () => {
        const created = await this.client.post('campaigns', campaignSchema.extend({ ad_groups: z.array(adGroupSchema).optional() }), body);
        const amount = created[budgetField];
        const [group] = created.ad_groups ?? [];
        if (created.name !== body.name || created.status !== status || typeof amount !== 'number' || micros(amount) !== (input.daily_budget_micros ?? input.total_budget_micros)
          || created.campaign_objective !== body.campaign_objective || created.ad_groups?.length !== 1
          || group?.campaign_id !== created.campaign_id || group.name !== adGroup.name || group.group_type !== 'generative') {
          throw new AdportError('PROVIDER_ERROR', 'gravity: campaign creation receipt mismatch; reconcile before retrying', { resource_ids: [created.campaign_id] });
        }
        return { applied: true, resourceIds: [created.campaign_id, group.id] };
      },
    };
  }

  private async planAdGroup(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const input = createAdGroupSchema.parse(op.payload);
    const campaign = await this.client.get(`campaigns/${input.campaign_id}`, campaignSchema);
    if (campaign.campaign_id !== input.campaign_id) throw new AdportError('PROVIDER_ERROR', 'gravity: campaign response does not match the parent campaign');
    return creativePlan(`ad group "${input.name}" in "${campaign.name}"`, input, guard, async body => {
      const group = await this.client.post('ad-groups', adGroupSchema, body);
      if (group.campaign_id !== campaign.campaign_id || group.name !== input.name || group.group_type !== input.group_type || group.status !== body.status) {
        throw new AdportError('PROVIDER_ERROR', 'gravity: ad group creation receipt mismatch; reconcile before retrying', { resource_ids: [group.id] });
      }
      return { applied: true, resourceIds: [group.id] };
    });
  }

  private async planAd(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const { ad_group_id, ...input } = createAdSchema.parse(op.payload);
    const group = await this.client.get(`ad-groups/${ad_group_id}`, adGroupSchema);
    if (group.id !== ad_group_id) throw new AdportError('PROVIDER_ERROR', 'gravity: ad group response does not match the parent ad group');
    if (group.group_type !== 'manual') throw new AdportError('INVALID_INPUT', 'gravity: authored ads require a manual ad group');
    return creativePlan(`ad "${input.headline}" in "${group.name}"`, input, guard, async body => {
      const ad = await this.client.post(`ad-groups/${group.id}/ads`, adSchema, body);
      if (ad.ad_group_id !== group.id || ad.campaign_id !== group.campaign_id || ad.source !== 'manual' || ad.status !== body.status
        || ad.headline !== body.headline || ad.copy !== body.copy || ad.cta !== body.cta || !sameWebUrl(ad.landing_page, body.landing_page)) {
        throw new AdportError('PROVIDER_ERROR', 'gravity: ad creation receipt mismatch; reconcile before retrying', { resource_ids: [ad.id] });
      }
      return { applied: true, resourceIds: [ad.id] };
    });
  }

  private planPixel(op: WriteOperation): Plan {
    const body = createPixelSchema.parse(op.payload);
    return {
      summary: `Register Gravity conversion pixel for ${body.url}`, changes: [`+ ${JSON.stringify(body)}`], coercions: [], budgetDeltas: [],
      execute: async () => {
        const pixel = await this.client.post('pixels', pixelSchema, body);
        if (!sameWebUrl(pixel.url, body.url) || (body.name !== undefined && pixel.name !== body.name)) {
          throw new AdportError('PROVIDER_ERROR', 'gravity: pixel creation receipt mismatch; reconcile before retrying', { resource_ids: [pixel.pixel_id] });
        }
        return { applied: true, resourceIds: [pixel.pixel_id] };
      },
    };
  }

  private async planBudget(op: WriteOperation): Promise<Plan> {
    const input = setBudgetSchema.parse(op.payload);
    const current = await this.client.get(`campaigns/${input.campaign_id}`, campaignSchema);
    if (current.campaign_id !== input.campaign_id) throw new AdportError('PROVIDER_ERROR', 'gravity: campaign response does not match the requested campaign');
    const available = (['daily', 'total'] as const).filter(type => typeof current[`${type}_budget`] === 'number');
    const uncappedDaily = current.bid_strategy === 'target_cpa' && current.daily_budget === null && current.total_budget == null;
    const type = current.budget_type ?? (available.length === 1 ? available[0] : uncappedDaily ? 'daily' : undefined);
    if (type !== 'daily' && type !== 'total') throw new AdportError('PROVIDER_ERROR', 'gravity: could not establish the current campaign budget type');
    if (`${type}_budget` !== input.field) throw new AdportError('INVALID_INPUT', `gravity: campaign uses a ${type} budget; update ${type}_budget instead (budget-type changes are not supported)`);
    const currentAmount = current[input.field];
    if (typeof currentAmount !== 'number' && !(type === 'daily' && uncappedDaily)) {
      throw new AdportError('PROVIDER_ERROR', 'gravity: could not establish the current campaign budget for policy checks');
    }
    const previous = typeof currentAmount === 'number' ? micros(currentAmount) : undefined;
    const amount = dollars(input.budget_micros);
    return {
      summary: `Change Gravity campaign "${current.name}" ${input.field}`,
      changes: [`~ ${current.campaign_id} ${input.field}: ${previous === undefined ? 'unset' : `$${previous / 1e6}`} → $${amount}`],
      fieldChanges: [{ field: input.field, before: previous === undefined ? 'unset' : String(previous), after: String(input.budget_micros) }],
      coercions: [],
      budgetDeltas: [{ target: `campaign ${current.campaign_id} ${input.field}`, ...(previous !== undefined ? { fromMicros: previous } : {}), toMicros: input.budget_micros }],
      execute: async () => {
        const updated = await this.client.patch(`campaigns/${current.campaign_id}`, campaignSchema, { [input.field]: amount });
        const value = updated[input.field];
        if (updated.campaign_id !== current.campaign_id || typeof value !== 'number' || micros(value) !== input.budget_micros) throw new AdportError('PROVIDER_ERROR', 'gravity: campaign budget receipt mismatch; reconcile before retrying', { resource_ids: [current.campaign_id] });
        return { applied: true, resourceIds: [current.campaign_id] };
      },
    };
  }

  private async planStatus(op: WriteOperation): Promise<Plan> {
    const spec = STATUS_TOOLS[op.tool as keyof typeof STATUS_TOOLS];
    const input = spec.schema.parse(op.payload) as Record<string, string>;
    const id = input[spec.key]!, status = input.status!;
    const entity = spec.entity as z.ZodType<Named & Record<string, unknown>>;
    const readId = spec.id as (value: unknown) => string;
    const current = await this.client.get(`${spec.path}/${id}`, entity);
    if (readId(current) !== id) throw new AdportError('PROVIDER_ERROR', `gravity: ${spec.label} response does not match the requested ${spec.label}`);
    if (op.tool === 'gravity_set_ad_status' && current.source !== 'manual') throw new AdportError('INVALID_INPUT', 'gravity: only manual ads can be changed; pause the generative ad group instead');
    const label = current.name || current.headline || id;
    return {
      summary: `${status === 'active' ? 'Activate' : 'Pause'} Gravity ${spec.label} "${label}"`,
      changes: [`~ ${id} status: ${current.status} → ${status}`],
      fieldChanges: [{ field: 'status', before: String(current.status), after: status }],
      ...(status === 'active' && op.tool === 'gravity_set_campaign_status' ? { notes: ['Gravity checks billing and the conversion event on activation, and may send the campaign to review again.'] } : {}),
      coercions: [], budgetDeltas: [],
      execute: async () => {
        const updated = await this.client.patch(`${spec.path}/${id}`, entity, { status });
        if (readId(updated) !== id || updated.status !== status) throw new AdportError('PROVIDER_ERROR', `gravity: ${spec.label} status receipt mismatch; reconcile before retrying`, { resource_ids: [id] });
        return { applied: true, resourceIds: [id] };
      },
    };
  }
}

function creativePlan<T extends { status: 'active' | 'paused' }>(label: string, input: T, guard: WriteGuard, submit: (body: T) => Promise<WriteResult>): Plan {
  const status = guard.forcePausedCreation ? 'paused' : input.status;
  const body = { ...input, status };
  return {
    summary: `Create Gravity ${label} (${status})`, changes: [`+ ${JSON.stringify(body)}`], budgetDeltas: [],
    coercions: status !== input.status ? ['status coerced to paused by policy (paused_creation)'] : [],
    execute: () => submit(body),
  };
}

function sameWebUrl(actual: string | null | undefined, expected: string) {
  return Boolean(actual && URL.canParse(actual) && new URL(actual).href === new URL(expected).href);
}

const dollars = (value: number) => value / 1_000_000;
const micros = (value: number) => Math.round(value * 1_000_000);

/** Spend and revenue are dollars; null means unavailable, never zero. */
function normalize(totals: GravityTotals, metrics: MetricName[]): Partial<Record<MetricName, number>> {
  const mapped: Partial<Record<MetricName, number>> = {};
  const fields = { spend: 'total_spend', impressions: 'total_impressions', clicks: 'total_clicks', conversions: 'total_conversions', conversion_value: 'total_revenue' } as const;
  for (const [metric, field] of Object.entries(fields)) {
    const value = totals[field];
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

