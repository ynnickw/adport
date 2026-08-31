import { z } from 'zod';
import { AdportError, resolveDateRange, type Account, type AdProvider, type MetricName, type NormalizedQuery, type Report, type ReportRow, type StandardActions, type WriteGuard, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { LinkedInAdsClient, type RestliValue } from './client.js';
import { accountSchema, campaignSchema, createCampaignSchema, groupSchema, linkedinId, NON_DISCRIMINATION_NOTICE, NON_POLITICAL_CONSENT, reportRowSchema, setBudgetSchema, setStatusSchema } from './schemas.js';

interface Plan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<string[]> }
const FIELDS = { spend: 'costInLocalCurrency', impressions: 'impressions', clicks: 'clicks', conversions: 'externalWebsiteConversions', conversion_value: 'conversionValueInLocalCurrency' } as const;
const DERIVED = { ctr: ['clicks', 'impressions', 100], cpc: ['spend', 'clicks', 1], cpm: ['spend', 'impressions', 1000], cpa: ['spend', 'conversions', 1], roas: ['conversion_value', 'spend', 1] } as const;
const STATUS = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'COMPLETED', 'CANCELED', 'DRAFT', 'PENDING_DELETION', 'REMOVED'];
const ACCOUNT_URN = (id: string) => `urn:li:sponsoredAccount:${linkedinId.parse(id)}`;

export function decimalToMicros(amount: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new AdportError('PROVIDER_ERROR', 'linkedin: invalid money amount');
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.slice(6).replace(/0/g, '')) throw new AdportError('PROVIDER_ERROR', 'linkedin: budget precision exceeds integer micros');
  const value = BigInt(whole!) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AdportError('PROVIDER_ERROR', 'linkedin: budget exceeds safe integer micros');
  return Number(value);
}
export function microsToDecimal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new AdportError('INVALID_INPUT', 'linkedin: budget must be integer micros');
  const number = BigInt(value);
  return `${number / 1_000_000n}.${String(number % 1_000_000n).padStart(6, '0')}`;
}

export class LinkedInAdsProvider implements AdProvider {
  readonly id = 'linkedin';
  constructor(private readonly client: LinkedInAdsClient) {}
  capabilities() { return { serverDryRun: false }; }
  standardActions(): StandardActions { return { pauseCampaign: (accountId, campaignId) => ({ tool: 'linkedin_set_campaign_status', input: { account_id: accountId, campaign_id: campaignId, status: 'PAUSED' } }) }; }
  private async search<T extends { id: number }>(path: string, schema: z.ZodType<T>, search?: RestliValue): Promise<T[]> {
    const params: Record<string, RestliValue> = { q: 'search', pageSize: 100, ...(search ? { search } : {}) };
    const pageSchema = z.object({ elements: z.array(schema), metadata: z.object({ nextPageToken: z.string().optional() }).optional() });
    const rows: T[] = [], tokens = new Set<string>(), seen = new Set<number>();
    while (true) {
      const page = await this.client.get(path, pageSchema, params);
      for (const row of page.elements) {
        if (seen.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'linkedin: search repeated an entity');
        seen.add(row.id); rows.push(row);
      }
      const next = page.metadata?.nextPageToken;
      if (!next) return rows;
      if (tokens.has(next) || tokens.size >= 1000) throw new AdportError('PROVIDER_ERROR', 'linkedin: cursor pagination did not terminate');
      tokens.add(next); params.pageToken = next;
    }
  }
  async listAccounts(): Promise<Account[]> {
    return (await this.search('adAccounts', accountSchema)).map(a => ({ provider: this.id, id: String(a.id), name: a.name, currency: a.currency, status: a.status }));
  }
  async getAccount(accountId: string) {
    const data = await this.client.get(`adAccounts/${linkedinId.parse(accountId)}`, accountSchema);
    if (String(data.id) !== accountId) throw new AdportError('PROVIDER_ERROR', 'linkedin: account ID mismatch');
    return data;
  }
  async listCampaigns(accountId: string) {
    const rows = await this.search(`adAccounts/${linkedinId.parse(accountId)}/adCampaigns`, campaignSchema, { status: { values: STATUS } });
    if (rows.some(r => r.account !== ACCOUNT_URN(accountId))) throw new AdportError('PROVIDER_ERROR', 'linkedin: campaign account mismatch');
    return rows;
  }
  async listCampaignGroups(accountId: string) {
    const rows = await this.search(`adAccounts/${linkedinId.parse(accountId)}/adCampaignGroups`, groupSchema, { status: { values: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DRAFT', 'PENDING_DELETION', 'REMOVED'] } });
    if (rows.some(r => r.account !== ACCOUNT_URN(accountId))) throw new AdportError('PROVIDER_ERROR', 'linkedin: campaign group account mismatch');
    return rows;
  }
  async getCampaign(accountId: string, campaignId: string) {
    const data = await this.client.get(`adAccounts/${linkedinId.parse(accountId)}/adCampaigns/${linkedinId.parse(campaignId)}`, campaignSchema);
    if (String(data.id) !== campaignId || data.account !== ACCOUNT_URN(accountId)) throw new AdportError('PROVIDER_ERROR', 'linkedin: campaign account/ID mismatch');
    return data;
  }
  async report(query: NormalizedQuery): Promise<Report> {
    if (query.level === 'ad_group') throw new AdportError('INVALID_INPUT', 'linkedin: no native ad-group level; use campaign (LinkedIn campaign) or ad (creative). Campaign groups are listed separately.');
    const range = resolveDateRange(query.dateRange), start = z.iso.date().parse(range.start), end = z.iso.date().parse(range.end);
    if (end < start) throw new AdportError('INVALID_INPUT', 'linkedin: report end must be on/after start');
    const dateObject = (iso: string) => { const [year, month, day] = iso.split('-').map(Number); return { year: year!, month: month!, day: day! }; };
    const dateRange = { start: dateObject(start), end: dateObject(end) };
    const limit = query.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'linkedin: report limit must be a positive integer');
    const fields = new Set<string>(['pivotValues', 'dateRange']);
    for (const metric of query.metrics) {
      if (metric in FIELDS) fields.add(FIELDS[metric as keyof typeof FIELDS]);
      else if (metric in DERIVED) for (const dependency of DERIVED[metric as keyof typeof DERIVED].slice(0, 2)) fields.add(FIELDS[dependency as keyof typeof FIELDS]);
    }
    if (fields.size === 2) throw new AdportError('INVALID_INPUT', 'linkedin: at least one supported metric is required');
    const pivot = { account: 'ACCOUNT', campaign: 'CAMPAIGN', ad: 'CREATIVE' }[query.level];
    const urnType = { account: 'sponsoredAccount', campaign: 'sponsoredCampaign', ad: 'sponsoredCreative' }[query.level];
    const rows: ReportRow[] = []; let capped = false;
    for (const id of [...new Set(query.accountIds ?? (await this.listAccounts()).map(a => a.id))]) {
      const accountId = linkedinId.parse(id), account = await this.getAccount(accountId);
      const campaigns = query.level === 'campaign' ? new Map((await this.listCampaigns(accountId)).map(c => [String(c.id), c])) : undefined;
      const data = await this.client.get('adAnalytics', z.object({ elements: z.array(reportRowSchema), paging: z.object({ links: z.array(z.object({ rel: z.string() })).optional() }).optional() }), {
        q: 'analytics', pivot, timeGranularity: 'ALL', dateRange, accounts: [ACCOUNT_URN(accountId)], fields: [...fields].join(','),
      });
      if (data.paging?.links?.some(link => link.rel === 'next')) throw new AdportError('PROVIDER_ERROR', 'linkedin: unexpected analytics pagination; refusing incomplete data');
      capped ||= data.elements.length >= 15_000;
      const seen = new Set<string>();
      for (const row of data.elements) {
        const urn = row.pivotValues[0]!, match = urn.match(new RegExp(`^urn:li:${urnType}:([1-9]\\d*)$`));
        if (!match) throw new AdportError('PROVIDER_ERROR', 'linkedin: unexpected analytics pivot');
        const entityId = match[1]!;
        if (seen.has(entityId) || (query.level === 'account' && entityId !== accountId) || (campaigns && !campaigns.has(entityId))) throw new AdportError('PROVIDER_ERROR', 'linkedin: incorrectly scoped or duplicate analytics row');
        seen.add(entityId);
        // Older ALL queries can be rounded to full months. Never label those
        // expanded dates as the narrower period the caller requested.
        if (['start', 'end'].some(bound => ['year', 'month', 'day'].some(part => row.dateRange[bound as 'start' | 'end'][part as 'year' | 'month' | 'day'] !== dateRange[bound as 'start' | 'end'][part as 'year' | 'month' | 'day']))) {
          throw new AdportError('PROVIDER_ERROR', 'linkedin: provider changed the reporting date range (older queries may round to months); request the returned month boundaries explicitly');
        }
        const campaign = campaigns?.get(entityId);
        rows.push({ provider: this.id, accountId, entity: { level: query.level, id: entityId, name: query.level === 'account' ? account.name : campaign?.name ?? entityId, ...(query.level === 'account' ? { status: account.status } : campaign ? { status: campaign.status } : {}) }, metrics: normalize(row, query.metrics) });
        if (rows.length > limit) return { rows: rows.slice(0, limit), truncated: true };
      }
    }
    return { rows, ...(capped ? { truncated: true } : {}) };
  }
  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const { execute: _execute, ...preview } = await this.plan(op, guard); return { ...preview, serverValidated: false };
  }
  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> { return { applied: true, resourceIds: await (await this.plan(op, guard)).execute() }; }
  private async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const accountId = linkedinId.parse(op.accountId), base = `adAccounts/${accountId}/adCampaigns`;
    if (op.provider !== this.id) throw new AdportError('INVALID_INPUT', 'linkedin: provider mismatch');
    if (op.tool === 'linkedin_create_campaign' && op.kind === 'create') {
      const input = createCampaignSchema.parse(op.payload);
      if (!input.daily_budget_micros && !input.total_budget_micros) throw new AdportError('INVALID_INPUT', 'linkedin: a daily or total campaign budget is required');
      if (input.type === 'DYNAMIC' && (!input.daily_budget_micros || !input.total_budget_micros || !input.format)) throw new AdportError('INVALID_INPUT', 'linkedin: dynamic campaigns require daily and total budgets and a format');
      if ((input.type === 'SPONSORED_UPDATES' || input.type === 'DYNAMIC' || input.objective_type === 'LEAD_GENERATION') && !input.associated_entity) throw new AdportError('INVALID_INPUT', 'linkedin: sponsored content, dynamic and lead-generation campaigns require an associated entity');
      if (input.total_budget_micros && !input.end_time) throw new AdportError('INVALID_INPUT', 'linkedin: lifetime campaign budgets require an end time');
      if (input.end_time && (!input.start_time || input.end_time <= input.start_time)) throw new AdportError('INVALID_INPUT', 'linkedin: scheduled end requires an earlier start time');
      const keys = input.targeting_criteria.include.and.flatMap(clause => Object.keys(clause.or));
      if (input.targeting_criteria.include.and.some(clause => !Object.keys(clause.or).length)) throw new AdportError('INVALID_INPUT', 'linkedin: targeting include clauses cannot be empty');
      if (!keys.includes('urn:li:adTargetingFacet:locations') && !keys.includes('urn:li:adTargetingFacet:profileLocations')) throw new AdportError('INVALID_INPUT', 'linkedin: targeting must include modern geo locations');
      if (keys.includes('urn:li:adTargetingFacet:locations') && keys.includes('urn:li:adTargetingFacet:profileLocations')) throw new AdportError('INVALID_INPUT', 'linkedin: choose locations or profileLocations, not both');
      for (const clause of input.targeting_criteria.include.and) for (const [facet, values] of Object.entries(clause.or)) {
        if (['urn:li:adTargetingFacet:locations', 'urn:li:adTargetingFacet:profileLocations'].includes(facet) && values.some(value => !/^urn:li:geo:[1-9]\d*$/.test(value))) throw new AdportError('INVALID_INPUT', 'linkedin: use modern urn:li:geo location identifiers; legacy geo is no longer supported');
      }
      const account = await this.getAccount(accountId);
      const group = await this.client.get(`adAccounts/${accountId}/adCampaignGroups/${input.campaign_group_id}`, groupSchema);
      if (group.account !== ACCOUNT_URN(accountId) || String(group.id) !== input.campaign_group_id) throw new AdportError('PROVIDER_ERROR', 'linkedin: campaign group account/ID mismatch');
      if (group.budgetOptimization?.budgetOptimizationStrategy === 'DYNAMIC') throw new AdportError('INVALID_INPUT', 'linkedin: this group shares a dynamic budget; ordinary campaign budget creation is not supported for it');
      const status = guard.forcePausedCreation ? 'PAUSED' : input.status;
      const money = (amount: number) => ({ amount: microsToDecimal(amount), currencyCode: account.currency });
      const body = {
        account: ACCOUNT_URN(accountId), campaignGroup: `urn:li:sponsoredCampaignGroup:${input.campaign_group_id}`, name: input.name,
        type: input.type, objectiveType: input.objective_type, costType: input.cost_type, unitCost: money(input.unit_cost_micros), locale: input.locale,
        targetingCriteria: input.targeting_criteria, status, politicalIntent: 'NOT_POLITICAL', offsiteDeliveryEnabled: false, audienceExpansionEnabled: false,
        ...(input.associated_entity ? { associatedEntity: input.associated_entity } : {}), ...(input.format ? { format: input.format } : {}),
        ...(input.daily_budget_micros ? { dailyBudget: money(input.daily_budget_micros) } : {}),
        ...(input.total_budget_micros ? { totalBudget: money(input.total_budget_micros), pacingStrategy: 'LIFETIME' } : {}),
        ...(input.start_time ? { runSchedule: { start: input.start_time, ...(input.end_time ? { end: input.end_time } : {}) } } : {}),
      };
      return {
        summary: `Create LinkedIn campaign "${input.name}"`, changes: [NON_DISCRIMINATION_NOTICE, `Advertiser confirmation: ${NON_POLITICAL_CONSENT}`, `+ ${JSON.stringify(body)}`],
        coercions: input.status !== status ? ['status coerced to PAUSED by policy (paused_creation)'] : [],
        budgetDeltas: [ ...(input.daily_budget_micros ? [{ target: 'new campaign daily budget', toMicros: input.daily_budget_micros }] : []), ...(input.total_budget_micros ? [{ target: 'new campaign total budget', toMicros: input.total_budget_micros }] : []) ],
        execute: async () => [await this.client.create(base, body)],
      };
    }
    if (op.kind === 'update' && ['linkedin_set_campaign_status', 'linkedin_set_budget'].includes(op.tool)) {
      const input = op.tool === 'linkedin_set_budget' ? setBudgetSchema.parse(op.payload) : setStatusSchema.parse(op.payload);
      if ('status' in input && input.status === 'ACTIVE' && !input.non_political_consent) throw new AdportError('INVALID_INPUT', `linkedin: activation requires explicit advertiser consent: ${NON_POLITICAL_CONSENT}`);
      const current = await this.getCampaign(accountId, input.campaign_id);
      if ('budget_micros' in input) {
        const field = input.budget_type === 'DAILY' ? 'dailyBudget' : 'totalBudget', budget = current[field];
        if (!budget) throw new AdportError('INVALID_INPUT', `linkedin: campaign has no existing ${field}; this tool changes existing budget types only`);
        const fromMicros = decimalToMicros(budget.amount);
        return { summary: `Change LinkedIn campaign "${current.name}" budget`, changes: [`~ ${field}: ${budget.amount} → ${microsToDecimal(input.budget_micros)} ${budget.currencyCode}`], coercions: [],
          budgetDeltas: [{ target: `campaign ${current.id} ${field}`, fromMicros, toMicros: input.budget_micros }],
          execute: async () => { await this.client.update(`${base}/${current.id}`, { [field]: { amount: microsToDecimal(input.budget_micros), currencyCode: budget.currencyCode } }); return [String(current.id)]; },
        };
      }
      return { summary: `Change LinkedIn campaign "${current.name}" status`, changes: [`~ status: ${current.status} → ${input.status}`, ...(input.status === 'ACTIVE' ? [NON_DISCRIMINATION_NOTICE, `Advertiser confirmation: ${NON_POLITICAL_CONSENT}`] : [])], coercions: [], budgetDeltas: [],
        execute: async () => { await this.client.update(`${base}/${current.id}`, { status: input.status, ...(input.status === 'ACTIVE' ? { politicalIntent: 'NOT_POLITICAL' } : {}) }); return [String(current.id)]; },
      };
    }
    throw new AdportError('INVALID_INPUT', `linkedin: unsupported write ${op.tool}`);
  }
}

function normalize(row: z.infer<typeof reportRowSchema>, requested: MetricName[]) {
  const mapped: Partial<Record<MetricName, number>> = {};
  for (const [metric, field] of Object.entries(FIELDS)) {
    const value = row[field];
    if (value === undefined) continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new AdportError('PROVIDER_ERROR', `linkedin: invalid ${field} metric`);
    mapped[metric as MetricName] = number;
  }
  for (const [metric, [numerator, denominator, factor]] of Object.entries(DERIVED)) if (mapped[numerator] !== undefined && mapped[denominator] !== undefined) mapped[metric as MetricName] = mapped[denominator] ? mapped[numerator]! / mapped[denominator]! * factor : 0;
  return Object.fromEntries(requested.filter(metric => mapped[metric] !== undefined).map(metric => [metric, mapped[metric]]));
}
