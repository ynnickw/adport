import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRow as row, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const audienceType = z.enum(['RemarketingList', 'Custom', 'InMarket', 'Product', 'SimilarRemarketingList', 'CombinedList', 'CustomerList', 'ImpressionBasedRemarketingList', 'CustomSegment']);
const standardTypes = audienceType.options.filter(value => value !== 'CustomSegment');
const name = z.string().min(1).max(128).refine(value => value.trim().length > 0, 'Name cannot be blank');
const description = z.string().max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stringOperator = z.enum(['Equals', 'Contains', 'BeginsWith', 'EndsWith', 'NotEquals', 'DoesNotContain', 'DoesNotBeginWith', 'DoesNotEndWith']);
const numberOperator = z.enum(['Equals', 'GreaterThan', 'LessThan', 'GreaterThanEqualTo', 'LessThanEqualTo', 'NotEquals']);
const groups = z.array(z.object({ items: z.array(z.object({ operand: z.enum(['Url', 'ReferrerUrl']), operator: stringOperator, value: z.string().min(1) })).min(1).max(100) })).min(1).max(100);
const eventExpression = z.object({ operator: stringOperator, text: z.string().min(1) });
const rule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PageVisitors'), normal_form: z.enum(['Conjunctive', 'Disjunctive']).default('Disjunctive'), groups }),
  z.object({ type: z.literal('PageVisitorsWhoVisitedAnotherPage'), groups, another_groups: groups }),
  z.object({ type: z.literal('PageVisitorsWhoDidNotVisitAnotherPage'), include_groups: groups, exclude_groups: groups }),
  z.object({ type: z.literal('CustomEvents'), action: eventExpression.optional(), category: eventExpression.optional(), label: eventExpression.optional(), value: z.object({ operator: numberOperator, amount: z.number().int().positive() }).optional() }).refine(value => Object.values(value).some(value => value !== undefined && value !== 'CustomEvents'), 'At least one complete event condition is required'),
]);
const create = z.object({ name, description: description.optional(), membership_duration_days: z.number().int().min(1).max(180).default(30), tag_id: id, rule });
const reference = z.object({ audience_id: id, expected_snapshot_hash: hash });
const update = reference.extend({ name: name.optional(), description: description.optional(), membership_duration_days: z.number().int().min(1).max(180).optional(), tag_id: id.optional(), rule: rule.optional() }).refine(value => Object.entries(value).some(([key, value]) => !['audience_id', 'expected_snapshot_hash'].includes(key) && value !== undefined), 'Supply an editable field');
const view = z.object({ account_id: id, audience: z.record(z.string(), z.unknown()), shared: z.boolean(), snapshot_hash: hash });
const notes = ['Remarketing lists have no independent pause state. Creation is account-scoped and unattached; it does not install UET, send events or upload customer records.', 'Omitted rules and tag settings are preserved. Supplying a rule replaces its entire condition set. Conjunctive means OR within each group, AND across groups; Disjunctive means AND within each group, OR across groups.', 'Audience changes can affect existing targeting and exclusions in the selected account. Configuration hashes detect drift before submission; Microsoft has no atomic compare-and-set. Customer scope and sharing changes are not exposed.'];
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value; }
function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => matches(actual[index], value));
  if (typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return false;
    if ((expected as Row).Type === 'CustomEvents') {
      for (const field of ['Action', 'Category', 'Label', 'Value']) if (!Object.hasOwn(expected, field) && ![undefined, null, 'None'].includes((actual as Row)[`${field}Operator`] as undefined | null | string)) return false;
    }
    return Object.entries(expected).every(([key, value]) => matches((actual as Row)[key], value));
  }
  return String(actual) === String(expected);
}
const nativeGroups = (value: z.infer<typeof groups>) => value.map(group => ({ Items: group.items.map(item => ({ Type: 'String', Operand: item.operand, Operator: item.operator, Value: item.value })) }));
function nativeRule(value: z.infer<typeof rule>): Row {
  if (value.type === 'PageVisitors') return { Type: value.type, NormalForm: value.normal_form, RuleItemGroups: nativeGroups(value.groups) };
  if (value.type === 'PageVisitorsWhoVisitedAnotherPage') return { Type: value.type, RuleItemGroups: nativeGroups(value.groups), AnotherRuleItemGroups: nativeGroups(value.another_groups) };
  if (value.type === 'PageVisitorsWhoDidNotVisitAnotherPage') return { Type: value.type, IncludeRuleItemGroups: nativeGroups(value.include_groups), ExcludeRuleItemGroups: nativeGroups(value.exclude_groups) };
  const result: Row = { Type: value.type };
  for (const [key, field] of [['action', 'Action'], ['category', 'Category'], ['label', 'Label'], ['value', 'Value']] as const) { const condition = value[key]; if (condition) { result[field] = 'text' in condition ? condition.text : condition.amount; result[`${field}Operator`] = condition.operator; } }
  return result;
}
export const MICROSOFT_AUDIENCE_WRITES = new Set(['microsoft_create_remarketing_list', 'microsoft_update_remarketing_list', 'microsoft_delete_remarketing_list']);

/** Campaign Management v13: explicit Account ownership, replacement-rule semantics and bounded deletion-use checks. */
export class MicrosoftAudienceService extends MicrosoftNativeService {
  constructor(...args: [...ConstructorParameters<typeof MicrosoftNativeService>, (account: string) => Promise<unknown[]>]) {
    const [client, scope, campaign, campaigns] = args; super(client, scope, campaign); this.campaigns = campaigns;
  }
  private readonly campaigns: (account: string) => Promise<unknown[]>;

  private async query(account: string, types: z.infer<typeof audienceType>[]): Promise<Row[]> {
    const result = await this.request(account, 'Audiences/QueryByIds', { AudienceIds: null, Type: types.join(', '), ReturnAdditionalFields: 'NormalForm, NumberRuleItem, ImpressionBasedRemarketingList, CampaignIdsAdGroupIds' });
    if (!Object.hasOwn(result, 'Audiences')) throw new AdportError('PROVIDER_ERROR', 'microsoft: native audience response envelope is missing');
    const values = rows(result.Audiences);
    if (new Set(values.map(value => nativeId(value.Id))).size !== values.length || values.some(value => !types.includes(audienceType.parse(value.Type)))) throw new AdportError('PROVIDER_ERROR', 'microsoft: native audience identities or types mismatch');
    return values;
  }

  private shared(value: Row): boolean {
    return value.CustomerShare !== null && value.CustomerShare !== undefined && rows(row(value.CustomerShare).CustomerAccountShares).length > 0;
  }

  private snapshot(account: string, value: Row) {
    const { SearchSize: _search, AudienceNetworkSize: _network, SupportedCampaignTypes: _supported, ...configuration } = value;
    const { CustomerShare: _sharing, ...audience } = value;
    return { account_id: account, audience, shared: this.shared(value), snapshot_hash: createHash('sha256').update(JSON.stringify(canonical({ account, configuration }))).digest('hex') };
  }

  async list(input: { account_id: string; audience_types: z.infer<typeof audienceType>[]; after_audience_id?: string; limit: number }) {
    const values = (await this.query(input.account_id, input.audience_types)).filter(value => !input.after_audience_id || BigInt(nativeId(value.Id)) > BigInt(input.after_audience_id)).sort((a, b) => BigInt(nativeId(a.Id)) < BigInt(nativeId(b.Id)) ? -1 : 1), page = values.slice(0, input.limit), truncated = values.length > page.length;
    return { rows: page.map(value => this.snapshot(input.account_id, value)), truncated, ...(truncated ? { next_cursor: nativeId(page.at(-1)!.Id) } : {}) };
  }

  private async find(account: string, audience: string, type: z.infer<typeof audienceType>): Promise<Row> {
    const found = (await this.query(account, [type])).find(value => nativeId(value.Id) === audience);
    if (!found) throw new AdportError('INVALID_INPUT', 'microsoft: audience was not found for the selected account/type');
    return found;
  }

  async get(account: string, audience: string, type: z.infer<typeof audienceType>) { id.parse(audience); return this.snapshot(account, await this.find(account, audience, type)); }

  private async owned(account: string, audience: string): Promise<Row> {
    await this.accountScope(account, true);
    const current = await this.find(account, audience, 'RemarketingList');
    if (current.Scope !== 'Account' || nativeId(current.ParentId) !== account || this.shared(current)) throw new AdportError('INVALID_INPUT', 'microsoft: remarketing mutations require an unshared Account-scoped list owned by the selected account');
    return current;
  }

  private async tag(account: string, tag: string) {
    const result = await this.request(account, 'UetTags/QueryByIds', { TagIds: [tag] }), values = rows(result.UetTags);
    if (values.length !== 1 || nativeId(values[0]!.Id) !== tag) throw new AdportError('INVALID_INPUT', 'microsoft: UET tag is unavailable in the selected customer/account context');
  }

  async usage(account: string, audience: string) {
    await this.owned(account, audience);
    const lists = await this.query(account, ['SimilarRemarketingList', 'CombinedList']), derived = lists.filter(value => value.Type === 'SimilarRemarketingList' && String(value.SourceId) === audience).map(value => nativeId(value.Id)), ids = [audience, ...derived];
    const combined = lists.filter(value => value.Type === 'CombinedList' && rows(value.CombinationRules).some(rule => Array.isArray(rule.AudienceIds) && rule.AudienceIds.some(value => ids.includes(nativeId(value))))).map(value => nativeId(value.Id));
    const groupsResult = await this.request(account, 'AudienceGroups/QueryByIds', { AudienceGroupIds: null });
    if (!Object.hasOwn(groupsResult, 'AudienceGroups')) throw new AdportError('PROVIDER_ERROR', 'microsoft: audience-signal inventory is unavailable; deletion use check is incomplete');
    const signals = rows(groupsResult.AudienceGroups);
    if (signals.length >= 100) throw new AdportError('PROVIDER_ERROR', 'microsoft: audience-signal inventory reached the documented result boundary; deletion use check is incomplete');
    const signalIds = signals.filter(value => rows(value.Dimensions).some(dimension => dimension.Type === 'Audience' && rows(dimension.Audiences).some(value => ids.includes(nativeId(value.Id))))).map(value => nativeId(value.Id));
    const campaigns = rows(await this.campaigns(account)), associations: Row[] = [];
    if (campaigns.length > 200) throw new AdportError('INVALID_INPUT', 'microsoft: audience use check exceeds 200 campaigns; no deletion was submitted');
    let groupCount = 0;
    for (const campaign of campaigns) {
      // Performance Max audience references are checked in the account's audience-signal library above.
      if (campaign.CampaignType === 'PerformanceMax') continue;
      if (!['Search', 'Audience', 'DynamicSearchAds', 'Shopping'].includes(String(campaign.CampaignType))) throw new AdportError('INVALID_INPUT', 'microsoft: audience use check encountered an unsupported campaign type; no deletion was submitted');
      const campaignId = nativeId(campaign.Id), groupsResult = await this.request(account, 'AdGroups/QueryByCampaignId', { CampaignId: campaignId });
      if (!Object.hasOwn(groupsResult, 'AdGroups')) throw new AdportError('PROVIDER_ERROR', 'microsoft: ad-group inventory is unavailable; audience use check is incomplete');
      const groups = rows(groupsResult.AdGroups); groupCount += groups.length;
      if (groupCount > 2000) throw new AdportError('INVALID_INPUT', 'microsoft: audience use check exceeds 2000 ad groups; no deletion was submitted');
      for (const type of ['RemarketingList', ...(derived.length ? ['SimilarRemarketingList'] : [])]) {
        for (const group of [undefined, ...groups]) {
          const prefix = group ? 'AdGroup' : 'Campaign', parentId = group ? nativeId(group.Id) : campaignId;
          const result = await this.request(account, `${prefix}Criterions/QueryByIds`, { [`${prefix}Id`]: parentId, [`${prefix}CriterionIds`]: null, CriterionType: type });
          if (!Object.hasOwn(result, `${prefix}Criterions`)) throw new AdportError('PROVIDER_ERROR', 'microsoft: audience association response is unavailable; use check is incomplete');
          for (const criterion of rows(result[`${prefix}Criterions`])) {
            // The REST JSON contract says AudienceCriterion; the inherited Type table says Audience.
            if (nativeId(criterion[`${prefix}Id`]) !== parentId || !['AudienceCriterion', 'Audience'].includes(String(row(criterion.Criterion).Type)) || row(criterion.Criterion).AudienceType !== type) throw new AdportError('PROVIDER_ERROR', 'microsoft: audience association ownership/type mismatch');
            if (ids.includes(nativeId(row(criterion.Criterion).AudienceId)) && criterion.Status !== 'Deleted') associations.push({ campaign_id: campaignId, ...(group ? { ad_group_id: parentId } : {}), criterion });
          }
        }
      }
    }
    return { audience_id: audience, derived_audience_ids: derived, associations, combined_list_ids: combined, audience_signal_ids: signalIds, campaigns_scanned: campaigns.length, ad_groups_scanned: groupCount, complete: true as const };
  }

  private async confirm(account: string, audience: string, expected: Row) {
    try { const actual = await this.owned(account, audience); if (!matches(actual, expected)) throw new Error('Audience readback mismatch'); }
    catch { throw new AdportError('PROVIDER_ERROR', 'microsoft: audience write was accepted but readback was not confirmed; reconcile before retrying', { resourceIds: [audience] }); }
    return [audience];
  }

  async plan(op: WriteOperation): Promise<MicrosoftPlan> {
    const expectedKind = op.tool === 'microsoft_create_remarketing_list' ? 'create' : op.tool === 'microsoft_delete_remarketing_list' ? 'remove' : 'update';
    if (op.provider !== 'microsoft' || !MICROSOFT_AUDIENCE_WRITES.has(op.tool) || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'microsoft: audience operation kind mismatch');
    const account = op.accountId;
    if (op.tool === 'microsoft_create_remarketing_list') {
      const input = create.parse(op.payload); await this.accountScope(account, true); await this.tag(account, input.tag_id);
      if ((await this.query(account, ['RemarketingList'])).some(value => String(value.Name).toLowerCase() === input.name.toLowerCase())) throw new AdportError('INVALID_INPUT', 'microsoft: a remarketing list with this name already exists');
      const fields = { Type: 'RemarketingList', Scope: 'Account', ParentId: account, Name: input.name, MembershipDuration: input.membership_duration_days, TagId: input.tag_id, Rule: nativeRule(input.rule), ...(input.description !== undefined ? { Description: input.description } : {}) };
      return { summary: `Create Microsoft remarketing list "${input.name}"`, changes: [`+ ${JSON.stringify(fields)}`], notes, coercions: [], budgetDeltas: [], fieldChanges: [{ field: 'Name', before: '(new)', after: input.name }, { field: 'Scope', before: '(new)', after: 'Account' }, { field: 'Rule', before: '(new)', after: JSON.stringify(fields.Rule) }], execute: async () => {
        const result = await this.request(account, 'Audiences', { Audiences: [fields] }), ids = Array.isArray(result.AudienceIds) ? result.AudienceIds.filter(value => value !== null).map(nativeId) : [];
        if (ids.length !== 1) throw new AdportError('PROVIDER_ERROR', 'microsoft: audience creation receipt mismatch; reconcile before retrying', { resourceIds: ids });
        return this.confirm(account, ids[0]!, fields);
      } };
    }
    const input = (op.kind === 'remove' ? reference : update).parse(op.payload), current = await this.owned(account, input.audience_id);
    if (this.snapshot(account, current).snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'microsoft: audience configuration snapshot changed; request a fresh preview');
    if (op.kind === 'remove') {
      const usage = await this.usage(account, input.audience_id);
      if (usage.associations.length || usage.combined_list_ids.length || usage.audience_signal_ids.length) throw new AdportError('INVALID_INPUT', 'microsoft: audience or derived similar audience is referenced; remove its targeting, combined-list and signal references before deleting');
      return { summary: `Delete Microsoft remarketing list ${input.audience_id}`, changes: [`- ${JSON.stringify(this.snapshot(account, current).audience)}`, `Also deletes derived similar lists: ${JSON.stringify(usage.derived_audience_ids)}. No campaign/ad-group, combined-list or audience-signal references were found in the bounded account scan.`], notes: ['Deletion is permanent. Use checks are repeated before submission; native concurrent association changes cannot be locked.'], coercions: [], budgetDeltas: [], execute: async () => {
        await this.request(account, 'Audiences', { AudienceIds: [input.audience_id] }, 'DELETE');
        try { const remaining = await this.query(account, ['RemarketingList', 'SimilarRemarketingList']); if (remaining.some(value => [input.audience_id, ...usage.derived_audience_ids].includes(nativeId(value.Id)))) throw new Error('Audience still present'); }
        catch { throw new AdportError('PROVIDER_ERROR', 'microsoft: audience deletion readback was not confirmed; reconcile before retrying', { resourceIds: [input.audience_id, ...usage.derived_audience_ids] }); }
        return [input.audience_id, ...usage.derived_audience_ids];
      } };
    }
    const value = update.parse(input), fields: Row = { Id: value.audience_id, Type: 'RemarketingList' };
    for (const [key, field] of [['name', 'Name'], ['description', 'Description'], ['membership_duration_days', 'MembershipDuration'], ['tag_id', 'TagId']] as const) if (value[key] !== undefined) fields[field] = value[key];
    if (value.tag_id) await this.tag(account, value.tag_id);
    if (value.rule) fields.Rule = nativeRule(value.rule);
    const expected = Object.fromEntries(Object.entries({ ...current, ...fields }).filter(([key]) => !['CustomerShare', 'SearchSize', 'AudienceNetworkSize', 'SupportedCampaignTypes'].includes(key)));
    return { summary: `Update Microsoft remarketing list ${value.audience_id}`, changes: [`~ ${JSON.stringify(fields)}`], fieldChanges: Object.entries(fields).filter(([key]) => !['Id', 'Type'].includes(key)).map(([field, value]) => ({ field, before: typeof current[field] === 'object' ? JSON.stringify(current[field]) : String(current[field] ?? '(unset)'), after: typeof value === 'object' ? JSON.stringify(value) : String(value) })), notes, coercions: [], budgetDeltas: [], execute: async () => { await this.request(account, 'Audiences', { Audiences: [fields] }, 'PUT'); return this.confirm(account, value.audience_id, expected); } };
  }
}

export function microsoftAudienceTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_audiences', namespace: 'microsoft', description: 'Read account-associated native audiences with configuration hashes. Preserves unavailable sizes. Sharing graphs are omitted; shared is reported. System-generated visitor/converter/Smart lists are not supported by this API. CustomSegment is opt-in; reserved AIPrompt is excluded. Continue next_cursor as after_audience_id.', input: z.object({ account_id: id, audience_types: z.array(audienceType).min(1).refine(value => new Set(value).size === value.length, 'Audience types must be unique').default(standardTypes), after_audience_id: id.optional(), limit: z.number().int().positive().max(1000).default(100) }), output: z.object({ rows: z.array(view), truncated: z.boolean(), next_cursor: id.optional() }), pagination: { cursorInput: 'after_audience_id' }, annotations: { readOnly: true }, handler: input => provider.audiences.list(input) }),
    defineTool({ name: 'microsoft_get_audience', namespace: 'microsoft', description: 'Read one account-associated native audience and snapshot_hash. Customer-scoped or shared lists are readable but cannot be changed by single-account remarketing tools. System-owned sizes are excluded from the hash.', input: z.object({ account_id: id, audience_id: id, audience_type: audienceType }), output: view, annotations: { readOnly: true }, handler: input => provider.audiences.get(input.account_id, input.audience_id, input.audience_type) }),
    defineTool({ name: 'microsoft_audience_usage', namespace: 'microsoft', description: 'Check an owned unshared Account remarketing list and its derived similar lists for campaign/ad-group criteria, combined-list and audience-signal references. Bounded to 200 campaigns, 2000 ad groups and fewer than 100 signals; incomplete/unsupported scans fail closed.', input: z.object({ account_id: id, audience_id: id }), annotations: { readOnly: true }, handler: input => provider.audiences.usage(input.account_id, input.audience_id) }),
    guardedWriteTool({ name: 'microsoft_create_remarketing_list', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Create one unattached Account-scoped remarketing list using an available UET tag and PageVisitors, visited-another-page, excluded-page or CustomEvents rule. No pause state, installation, event sending or customer-record upload. Membership is 1..180 days.', payload: create }),
    guardedWriteTool({ name: 'microsoft_update_remarketing_list', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Edit an owned unshared Account remarketing list with expected_snapshot_hash. Preserves omitted rule/tag/settings; supplying rule replaces its entire condition set. Scope/parent/sharing are immutable here. Existing audience targeting and exclusions can be affected.', payload: update }),
    guardedWriteTool({ name: 'microsoft_delete_remarketing_list', namespace: 'microsoft', provider: 'microsoft', kind: 'remove', destructive: true, description: 'Permanently delete an owned unshared Account remarketing list and its derived similar lists. Requires expected_snapshot_hash and a complete bounded scan with no targeting, combined-list or signal references. Confirms disappearance; never retries an uncertain deletion.', payload: reference }),
  ];
}
