import { AdportError, type WriteGuard, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { LinkedInAdsClient } from './client.js';
import { groupCreate, isGeoFacet, targetingEntitiesInput, targetingUpdate, updateCampaign, updateGroup } from './management-tools.js';
import { decimalToMicros, microsToDecimal, type LinkedInAdsProvider } from './provider.js';
import { groupSchema, linkedinId as id, moneySchema, NON_DISCRIMINATION_NOTICE, NON_POLITICAL_CONSENT, targetingSchema } from './schemas.js';

type Row = Record<string, unknown>;
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<WriteResult> }
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const accountUrn = (account: string) => `urn:li:sponsoredAccount:${id.parse(account)}`;
const terminal = (status: unknown) => ['REMOVED', 'PENDING_DELETION', 'CANCELED', 'CANCELLED'].includes(String(status));
const schedule = z.object({ start: z.number().int().positive().safe(), end: z.number().int().positive().safe().optional() }).strict();

export class LinkedInManagementService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider) {}
  async group(account: string, resource: string) {
    const value = await this.client.get(`adAccounts/${id.parse(account)}/adCampaignGroups/${id.parse(resource)}`, groupSchema);
    if (String(value.id) !== resource || value.account !== accountUrn(account)) throw new AdportError('INVALID_INPUT', 'linkedin: campaign-group account/ID mismatch');
    return value;
  }
  async facets(account: string) {
    await this.provider.getAccount(account);
    return this.client.get('adTargetingFacets', z.object({ elements: z.array(z.record(z.string(), z.unknown())) }));
  }
  async entities(raw: z.input<typeof targetingEntitiesInput>) {
    const input = targetingEntitiesInput.parse(raw);
    await this.provider.getAccount(input.account_id);
    const value = await this.client.get('adTargetingEntities', z.looseObject({ elements: z.array(z.record(z.string(), z.unknown())), paging: z.looseObject({ start: z.number().int().nonnegative().safe(), count: z.number().int().nonnegative().safe(), total: z.number().int().nonnegative().safe().optional(), links: z.array(z.looseObject({ rel: z.string() })).optional() }).optional() }), { q: input.query ? 'typeahead' : 'adTargetingFacet', facet: input.facet, queryVersion: 'QUERY_USES_URNS', ...(input.query ? { query: input.query } : {}), ...(input.entity_type ? { entityType: input.entity_type } : {}), ...(input.use_case ? { useCase: input.use_case } : {}), ...(input.locale ? { locale: input.locale } : {}), start: input.start, count: input.count });
    if (value.paging && value.paging.start !== input.start) throw new AdportError('PROVIDER_ERROR', 'linkedin: targeting pagination changed its offset');
    if (value.elements.length > input.count || (value.paging && value.elements.length > value.paging.count)) throw new AdportError('PROVIDER_ERROR', 'linkedin: targeting response exceeds its page size');
    for (const entity of value.elements) {
      if (entity.facetUrn !== undefined && entity.facetUrn !== input.facet) throw new AdportError('PROVIDER_ERROR', 'linkedin: targeting entity belongs to a different facet');
      if (isGeoFacet(input.facet) && (typeof entity.urn !== 'string' || !/^urn:li:geo:\d+$/.test(entity.urn))) throw new AdportError('PROVIDER_ERROR', 'linkedin: location typeahead returned a missing or legacy geo URN');
    }
    const paging = value.paging, end = input.start + value.elements.length;
    const linkedNext = Boolean(paging?.links?.some(link => link.rel === 'next'));
    const contradictoryTotal = paging?.total !== undefined && (paging.total < end || (linkedNext && paging.total <= end));
    const notes: string[] = [];
    if (!paging) notes.push('Native paging is absent; completeness and continuation are unknown.');
    else if (paging.count !== input.count) notes.push('Native page size differs from the request; continuation is unknown.');
    if (contradictoryTotal) notes.push('Native total contradicts the returned records or next link; completeness is unknown.');
    // LinkedIn can return total:0 with nonempty results. Preserve the native value;
    // only advance a verified page by the requested count, never by its row count.
    const canAdvance = paging?.count === input.count;
    const more = canAdvance && (linkedNext || (!contradictoryTotal && paging?.total !== undefined ? end < paging.total : value.elements.length === input.count));
    const complete = !paging || !canAdvance || contradictoryTotal ? null : !more;
    return { ...value, complete, truncated: complete === null && !more ? null : more, ...(more ? { next_start: input.start + input.count } : {}), ...(notes.length ? { notes } : {}) };
  }
  private metadata(current: Row, input: { name?: string; start_time?: number; end_time?: number }): Row {
    const fields: Row = input.name !== undefined ? { name: input.name } : {};
    if (input.start_time !== undefined || input.end_time !== undefined) {
      const previous = current.runSchedule === undefined ? undefined : schedule.safeParse(current.runSchedule);
      if (previous && !previous.success) throw new AdportError('INVALID_INPUT', 'linkedin: unsupported current schedule; refusing a partial reset');
      const merged = { ...(previous?.data ?? {}), ...(input.start_time !== undefined ? { start: input.start_time } : {}), ...(input.end_time !== undefined ? { end: input.end_time } : {}) }, parsed = schedule.safeParse(merged);
      if (!parsed.success || (parsed.data.end !== undefined && parsed.data.end <= parsed.data.start)) throw new AdportError('INVALID_INPUT', 'linkedin: schedule needs start and an end later than start');
      fields.runSchedule = parsed.data;
    }
    return fields;
  }
  private async patch(account: string, entity: 'adCampaignGroups' | 'adCampaigns', resource: string, fields: Row, expected: Row): Promise<WriteResult> {
    await this.client.update(`adAccounts/${account}/${entity}/${resource}`, fields);
    try { const value = entity === 'adCampaignGroups' ? await this.group(account, resource) : await this.provider.getCampaign(account, resource); if (!matches(value, expected)) throw new Error('settings mismatch'); }
    catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: management update readback mismatch; reconcile before retrying', { resource_ids: [resource] }); }
    return { applied: true, resourceIds: [resource] };
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const account = id.parse(op.accountId), type = op.tool, p = op.payload, create = type === 'linkedin_create_campaign_group', remove = ['linkedin_delete_campaign', 'linkedin_delete_campaign_group'].includes(type);
    if (op.provider !== 'linkedin' || op.kind !== (create ? 'create' : remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'linkedin: provider or management operation kind mismatch');
    const plan = (summary: string, changes: string[], execute: () => Promise<WriteResult>, budgetDeltas: WritePreview['budgetDeltas'] = [], coercions: string[] = []): Plan => ({ summary, changes, execute, budgetDeltas, coercions });
    if (create) {
      const input = groupCreate.parse(p), owner = await this.provider.getAccount(account), status = guard.forcePausedCreation ? 'DRAFT' : input.status;
      if (status === 'ACTIVE' && !input.non_political_consent) throw new AdportError('INVALID_INPUT', `linkedin: active group creation requires explicit advertiser confirmation: ${NON_POLITICAL_CONSENT}`);
      const fields = { account: accountUrn(account), name: input.name, runSchedule: { start: input.start_time, ...(input.end_time ? { end: input.end_time } : {}) }, status, ...(input.total_budget_micros ? { totalBudget: { amount: microsToDecimal(input.total_budget_micros), currencyCode: owner.currency } } : {}) };
      return plan('Create LinkedIn campaign group', [...(status === 'ACTIVE' ? [NON_DISCRIMINATION_NOTICE, `Advertiser confirmation: ${NON_POLITICAL_CONSENT}`] : []), `Native initial status ${status}; paused_creation uses non-serving DRAFT. ${JSON.stringify(fields)}`], async () => { const resource = await this.client.create(`adAccounts/${account}/adCampaignGroups`, fields); try { if (!matches(await this.group(account, resource), fields)) throw new Error('settings mismatch'); } catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: created group readback mismatch; reconcile before retrying', { resource_ids: [resource] }); } return { applied: true, resourceIds: [resource] }; }, input.total_budget_micros ? [{ target: 'new campaign-group total cap', toMicros: input.total_budget_micros }] : [], input.status !== status ? ['status coerced to non-serving DRAFT by policy (paused_creation); native group creation does not accept PAUSED'] : []);
    }
    const isGroup = ['linkedin_update_campaign_group', 'linkedin_set_campaign_group_status', 'linkedin_set_campaign_group_budget', 'linkedin_delete_campaign_group'].includes(type), resource = id.parse(p[isGroup ? 'campaign_group_id' : 'campaign_id']), entity = isGroup ? 'adCampaignGroups' : 'adCampaigns';
    const current = isGroup ? await this.group(account, resource) : await this.provider.getCampaign(account, resource);
    if (terminal(current.status)) throw new AdportError('INVALID_INPUT', 'linkedin: resource is removed, canceled or pending deletion');
    if (remove) {
      if (isGroup) { const children = (await this.provider.listCampaigns(account)).filter(value => value.campaignGroup === `urn:li:sponsoredCampaignGroup:${resource}` && value.status !== 'REMOVED'); if (children.length) throw new AdportError('INVALID_INPUT', 'linkedin: remove contained campaigns before deleting their group'); }
      else {
        const children = await this.provider.creatives.list({ account_id: account, campaign_ids: [resource], statuses: ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED', 'CANCELED', 'PENDING_DELETION'], page_size: 1, include_media: false });
        if (children.items.length || children.truncated) throw new AdportError('INVALID_INPUT', 'linkedin: remove contained creatives before deleting their campaign');
      }
      const direct = current.status === 'DRAFT';
      return plan(`${direct ? 'Delete' : 'Request deletion of'} LinkedIn ${isGroup ? 'campaign group' : 'campaign'} ${resource}`, [direct ? 'Native DELETE for an empty draft.' : 'Set status PENDING_DELETION; this requests removal and does not prove completion.'], async () => { if (direct) { await this.client.remove(`adAccounts/${account}/${entity}/${resource}`); return { applied: true, resourceIds: [resource], details: { deletion: 'DELETED' } }; } const result = await this.patch(account, entity, resource, { status: 'PENDING_DELETION' }, { status: 'PENDING_DELETION' }); return { ...result, details: { deletion: 'PENDING_DELETION' } }; });
    }
    let fields: Row, money: WritePreview['budgetDeltas'] = [], notices: string[] = [];
    if (type === 'linkedin_update_campaign_group' || type === 'linkedin_update_campaign') fields = this.metadata(current, isGroup ? updateGroup.parse(p) : updateCampaign.parse(p));
    else if (type === 'linkedin_set_campaign_group_status') {
      const status = z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).parse(p.status);
      if (status === 'ACTIVE' && p.non_political_consent !== true) throw new AdportError('INVALID_INPUT', `linkedin: group activation requires explicit advertiser confirmation: ${NON_POLITICAL_CONSENT}`);
      fields = { status }; if (status === 'ACTIVE') notices = [NON_DISCRIMINATION_NOTICE, `Advertiser confirmation: ${NON_POLITICAL_CONSENT}`];
    } else if (type === 'linkedin_set_campaign_group_budget' || type === 'linkedin_set_bid') {
      if (isGroup && row(current.budgetOptimization).budgetOptimizationStrategy === 'DYNAMIC') throw new AdportError('INVALID_INPUT', 'linkedin: dynamic shared group budgets require a dedicated policy-aware workflow');
      const key = isGroup ? 'totalBudget' : 'unitCost', previous = moneySchema.safeParse(current[key]);
      if (!previous.success) throw new AdportError('INVALID_INPUT', 'linkedin: current native money value/currency is unavailable');
      if (previous.data.currencyCode !== (await this.provider.getAccount(account)).currency) throw new AdportError('INVALID_INPUT', 'linkedin: current money currency differs from the selected account');
      if (isGroup && !schedule.safeParse(current.runSchedule).data?.end) throw new AdportError('INVALID_INPUT', 'linkedin: group lifetime cap requires an existing end date');
      const target = z.number().int().positive().safe().parse(p[isGroup ? 'budget_micros' : 'bid_micros']);
      fields = { [key]: { amount: microsToDecimal(target), currencyCode: previous.data.currencyCode } }; money = [{ target: `${entity}/${resource} ${key}`, fromMicros: decimalToMicros(previous.data.amount), toMicros: target }];
      if (!isGroup && current.campaignGroup) { const group = await this.group(account, String(current.campaignGroup).split(':').at(-1)!); if (row(group.budgetOptimization).budgetOptimizationStrategy === 'DYNAMIC') throw new AdportError('INVALID_INPUT', 'linkedin: campaign bid is managed by its dynamic campaign group'); }
    } else if (type === 'linkedin_update_targeting') {
      const input = targetingUpdate.parse(p); fields = {};
      if (input.targeting_criteria) {
        for (const facets of [...input.targeting_criteria.include.and.map(clause => clause.or), input.targeting_criteria.exclude?.or ?? {}]) if (Object.keys(facets).some(key => ['urn:li:adTargetingFacet:audienceMatchingSegments', 'urn:li:adTargetingFacet:dynamicSegments'].includes(key))) throw new AdportError('INVALID_INPUT', 'linkedin: custom audience reference edits require a dedicated account-availability workflow');
        const previous = targetingSchema.safeParse(current.targetingCriteria);
        if (!previous.success) throw new AdportError('INVALID_INPUT', 'linkedin: current targeting is unsupported; refusing a partial reset');
        const merged = { ...previous.data, ...input.targeting_criteria }; validateTargeting(merged); fields.targetingCriteria = merged;
      }
      if (input.audience_expansion_enabled !== undefined) fields.audienceExpansionEnabled = input.audience_expansion_enabled;
      notices = [NON_DISCRIMINATION_NOTICE];
    } else throw new AdportError('INVALID_INPUT', `linkedin: unsupported management write ${type}`);
    const expected = { ...fields, ...(fields.status === undefined ? { status: current.status } : {}) };
    return plan(`Update LinkedIn ${isGroup ? 'campaign group' : 'campaign'} ${resource}`, [...notices, `${JSON.stringify(fields)}; omitted fields and current delivery status remain unchanged.`], () => this.patch(account, entity, resource, fields, expected), money);
  }
}

function validateTargeting(value: z.infer<typeof targetingSchema>) {
  const keys = value.include.and.flatMap(clause => Object.keys(clause.or)), modern = ['urn:li:adTargetingFacet:locations', 'urn:li:adTargetingFacet:profileLocations'];
  if (value.include.and.some(clause => !Object.keys(clause.or).length) || !modern.some(key => keys.includes(key)) || modern.every(key => keys.includes(key))) throw new AdportError('INVALID_INPUT', 'linkedin: targeting needs non-empty clauses and exactly one modern geo facet');
  for (const clause of value.include.and) for (const [facet, values] of Object.entries(clause.or)) if (modern.includes(facet) && values.some(value => !/^urn:li:geo:[1-9]\d*$/.test(value))) throw new AdportError('INVALID_INPUT', 'linkedin: targeting requires modern urn:li:geo identifiers');
}
function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every(value => actual.some(candidate => matches(candidate, value)));
  if (moneySchema.safeParse(expected).success) { const target = moneySchema.parse(expected), value = moneySchema.safeParse(actual); return value.success && target.currencyCode === value.data.currencyCode && decimalToMicros(target.amount) === decimalToMicros(value.data.amount); }
  if (expected && typeof expected === 'object') return actual !== null && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => matches((actual as Row)[key], value));
  return actual === expected;
}
