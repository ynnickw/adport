import { z } from 'zod';
import { AdportError, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import type { TikTokClient } from './client.js';
import { audienceId, audienceNativeId } from './custom-audience-schemas.js';
import { audienceRuleContext, ruleSelection, ruleAudienceCreate, lookalikeAudienceCreate, lookalikeAudiencesRefresh } from './audience-authoring-schemas.js';
import { TikTokCustomAudiences, customAudienceConfiguration, audienceOperationFailure } from './custom-audiences.js';
import type { TikTokAudienceSources } from './audience-sources.js';

type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
type Audience = Awaited<ReturnType<TikTokCustomAudiences['get']>>['audience'];
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const notes = ['A new audience does not attach itself to an ad group. Refresh can affect current ad groups or shared recipients already using that audience.', 'TikTok processes audience work asynchronously, potentially up to 48 hours. Acceptance and metadata readback do not prove matching, final rule/specification or availability.', 'Native source eligibility, event names, sharing permissions and quotas remain authoritative. The preview is local; there is no conditional-write or atomic-batch guarantee.', 'No native mutation is automatically retried. Reconcile known audience IDs after a partial or uncertain outcome.'];
const invalid = () => new AdportError('PROVIDER_ERROR', 'TikTok audience creation/refresh metadata could not be verified.');
const ready = (row: Audience) => { if (row.is_valid !== true || row.is_expiring !== false || row.native_error_reported) throw new AdportError('INVALID_INPUT', 'An available, non-expiring audience without a reported native error is required.'); };
const owned = (account: string, row: Audience) => { if (row.is_creator !== true || row.owner_id !== account) throw new AdportError('POLICY_VIOLATION', 'Refresh requires an audience created by this advertiser; recipient access is not ownership.'); };
// The published get table has no OFFLINE type mapping; report it rather than invent one.
const ruleTypes: Partial<Record<z.infer<typeof ruleAudienceCreate>['audience_type'], string>> = { APP: 'App Activity Audience', ENGAGEMENT: 'Engagement Audience', ENGAGEMENT_LIVE_VIDEO: 'Engagement Audience', ENGAGEMENT_ORGANIC_VIDEO: 'Engagement Audience', PIXEL: 'Website Audience', LEAD_GENERATION: 'Lead Generation', BUSINESS_ACCOUNT: 'Rule Business Account', TIKTOK_SHOP: 'Rule ad shop' };
function lookalikeEcho(actual: unknown, expected: z.infer<typeof lookalikeAudienceCreate>['lookalike_spec']) {
  const item = Array.isArray(actual) ? actual.length === 1 ? actual[0] : undefined : actual;
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !Object.hasOwn(lookalikeAudienceCreate.shape.lookalike_spec.shape, key))) return false;
  const row = item as Record<string, unknown>, parsed = lookalikeAudienceCreate.shape.lookalike_spec.safeParse({ source_audience_id: row.source_audience_id, include_source: row.include_source, mobile_os: row.mobile_os, placements: typeof row.placements === 'string' ? [row.placements] : row.placements, location_ids: row.location_ids, audience_size: row.audience_size });
  if (!parsed.success) return false;const normalized = (value: typeof expected) => ({ ...value, placements: [...value.placements].sort(), location_ids: [...value.location_ids].sort() });
  if (canonical(normalized(parsed.data)) !== canonical(normalized(expected))) throw invalid();return true;
}
function ruleEcho(raw: string | null | undefined, expected: z.infer<typeof ruleAudienceCreate>['rule_spec']) {
  let value: unknown;try { value = JSON.parse(raw ?? 'null'); } catch { return false; }
  const parsed = audienceRuleContext.shape.rule_spec.safeParse(value);if (!parsed.success) return false;
  const set = (value: typeof expected.inclusion_rule_set) => ({ ...value, rules: value.rules.map(row => ({ ...row, event_source_ids: row.event_source_ids ? [...row.event_source_ids].sort() : undefined })).sort((a, b) => canonical(a).localeCompare(canonical(b))) });
  const normalized = (value: typeof expected) => ({ inclusion_rule_set: set(value.inclusion_rule_set), ...(value.exclusion_rule_set ? { exclusion_rule_set: set(value.exclusion_rule_set) } : {}) });
  if (canonical(normalized(parsed.data)) !== canonical(normalized(expected))) throw invalid();return true;
}
export class TikTokAudienceAuthoring {
  constructor(private readonly client: TikTokClient, private readonly audiences: TikTokCustomAudiences, private readonly sources: TikTokAudienceSources) {}
  async context(value: unknown) { return this.sources.context(audienceRuleContext.parse(value)); }
  private async read(account: string, id: string) { return (await this.audiences.get({ account_id: account, custom_audience_id: id })).audience; }
  private async created(account: string, id: string, name: string, expectedType?: string) {
    const row = await this.read(account, id);owned(account, row);
    if (!row.type.trim() || row.name !== name || row.native_error_reported || expectedType && row.type.trim() !== expectedType) throw invalid();return row;
  }
  private receipt(account: string, row: Audience, extra: Record<string, unknown>): WriteResult { return { applied: true, resourceIds: [row.audience_id], details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, metadata_readback: 'VERIFIED', membership_verified: false, native_is_valid: row.is_valid, native_reported_type: row.type, ...extra, next_tool: 'tiktok_get_custom_audience', next_arguments: { account_id: account, custom_audience_id: row.audience_id } }, warnings: notes.slice(1) }; }
  async plan(op: WriteOperation): Promise<Plan> {
    audienceId.parse(op.accountId);
    if (op.provider !== 'tiktok' || !(op.tool === 'tiktok_create_lookalike_audience' && op.kind === 'create' || op.tool === 'tiktok_create_rule_audience' && op.kind === 'create' || op.tool === 'tiktok_refresh_lookalike_audiences' && op.kind === 'update')) throw new AdportError('INVALID_INPUT', 'Unsupported audience authoring operation/provider kind.');
    if (op.tool === 'tiktok_create_rule_audience') return this.rulePlan(op);
    if (op.tool === 'tiktok_refresh_lookalike_audiences') return this.refreshPlan(op);
    const input = lookalikeAudienceCreate.parse(op.payload), spec = input.lookalike_spec;
    const prepare = async () => { const row = await this.read(op.accountId, spec.source_audience_id);ready(row);if (!(row.is_creator === true && row.owner_id === op.accountId || row.is_creator === false && row.shared === true && row.owner_id !== undefined && row.owner_id !== op.accountId)) throw new AdportError('POLICY_VIOLATION', 'The seed must have proven creator or shared-recipient access under this advertiser.');if (row.snapshot_hash !== input.expected_source_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'Seed configuration or availability changed; read it and preview again.');if (row.type === 'Lookalike Audience' || row.cover_num === undefined || row.cover_num < 100) throw new AdportError('INVALID_INPUT', 'The seed must be a non-lookalike audience with at least 100 native matched users.');return row; };
    const source = await prepare();return { summary: `Create lookalike audience · ${input.custom_audience_name}`, changes: ['+ Lookalike audience from ' + source.name], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: op.accountId, kind: 'create', title: 'Create lookalike audience', subject: input.custom_audience_name, fields: [{ label: 'Seed audience', after: { id: source.audience_id, name: source.name, matched_users: source.cover_num, owner: source.is_creator, shared: source.shared } }, { label: 'Include seed members', after: spec.include_source }, { label: 'Operating systems', after: spec.mobile_os }, { label: 'Placements', after: spec.placements }, { label: 'Locations', after: spec.location_ids }, { label: 'Audience breadth', after: spec.audience_size }], notices: notes },
      execute: async () => { await prepare();let id: string | undefined;try {
        id = z.object({ custom_audience_id: audienceNativeId }).parse(await this.client.post('dmp/custom_audience/lookalike/create', { advertiser_id: op.accountId, custom_audience_name: input.custom_audience_name, lookalike_spec: spec })).custom_audience_id;
        const actual = await this.created(op.accountId, id, input.custom_audience_name, 'Lookalike Audience');return this.receipt(op.accountId, actual, { requested_source_audience_id: spec.source_audience_id, specification_readback: lookalikeEcho(actual.lookalike_spec, spec) ? 'VERIFIED_NATIVE_ECHO' : 'UNCONFIRMED_NATIVE_REPRESENTATION' });
      } catch (error) { throw audienceOperationFailure(error, id ? [id] : []); } } };
  }
  private async rulePlan(op: WriteOperation): Promise<Plan> {
    const input = ruleAudienceCreate.parse(op.payload), selection = ruleSelection(input);
    const prepare = async () => { const context = await this.sources.context({ account_id: op.accountId, ...selection });if (context.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'Rule selection, source metadata or source permissions changed; read the context and preview again.');return context; };
    const before = await prepare(), display = (set: typeof input.rule_spec.inclusion_rule_set) => set.rules.map(row => ({ event: row.filter_set.filters[0]!.value, lookback_days: row.retention_days, sources: row.event_source_ids ?? 'All available advertiser sources' }));
    return { summary: `Create rule audience · ${input.custom_audience_name}`, changes: ['+ ' + input.audience_type + ' audience; inclusion rules use OR logic' + (input.rule_spec.exclusion_rule_set ? '; matching exclusion rules remove users' : '')], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: op.accountId, kind: 'create', title: 'Create rule audience', subject: input.custom_audience_name, fields: [{ label: 'Audience type', after: input.audience_type }, { label: 'Verified source selection', after: before.records }, { label: 'Include any', after: display(input.rule_spec.inclusion_rule_set) }, ...(input.rule_spec.exclusion_rule_set ? [{ label: 'Exclude any', after: display(input.rule_spec.exclusion_rule_set) }] : []), { label: 'Refresh automatically', after: input.is_auto_refresh }, { label: 'Audience enhancement', after: 'Disabled' }, { label: 'Audience subtype', after: input.audience_sub_type }, { label: 'Retention requested', after: input.retention_in_days ?? 'Native default; independent of event lookback' }], notices: [...notes, ...before.notes] },
      execute: async () => { await prepare();let id: string | undefined;try {
        const { acknowledge_all_event_sources: _acknowledgement, ...nativeSelection } = selection;
        id = z.object({ custom_audience_id: audienceNativeId }).parse(await this.client.post('dmp/custom_audience/rule/create', { advertiser_id: op.accountId, ...nativeSelection, custom_audience_name: input.custom_audience_name, is_auto_refresh: input.is_auto_refresh, audience_enhancement: false, audience_sub_type: input.audience_sub_type, ...(input.retention_in_days !== undefined ? { retention_in_days: input.retention_in_days } : {}) })).custom_audience_id;
        const actual = await this.created(op.accountId, id, input.custom_audience_name, ruleTypes[input.audience_type]);return this.receipt(op.accountId, actual, { requested_audience_type: input.audience_type, type_mapping_verified: input.audience_type in ruleTypes, rule_readback: ruleEcho(actual.rule, input.rule_spec) ? 'VERIFIED_NATIVE_ECHO' : 'UNCONFIRMED_NATIVE_REPRESENTATION', source_selection_verified: true, retention_requested: input.retention_in_days, native_expired_time: actual.expired_time });
      } catch (error) { throw audienceOperationFailure(error, id ? [id] : []); } } };
  }
  private async refreshPlan(op: WriteOperation): Promise<Plan> {
    const input = lookalikeAudiencesRefresh.parse(op.payload), ids = input.targets.map(row => row.custom_audience_id);
    const prepare = async () => { const rows = await this.audiences.inspect(op.accountId, ids);for (const row of rows) { const target = input.targets.find(target => target.custom_audience_id === row.audience_id)!;owned(op.accountId, row);ready(row);if (row.type !== 'Lookalike Audience') throw new AdportError('INVALID_INPUT', 'Every refresh target must be a native Lookalike Audience.');if (row.snapshot_hash !== target.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'A lookalike target changed; read every target and preview again.'); }return rows; };
    const before = await prepare();return { summary: `Refresh ${ids.length} lookalike audiences`, changes: before.map(row => '~ Refresh ' + row.name), coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: op.accountId, kind: 'update', title: 'Refresh lookalike audiences', subject: `${ids.length} selected`, fields: before.map(row => ({ label: row.name, before: { id: row.audience_id, shared: row.shared }, after: 'Recompute native lookalike membership' })), notices: notes },
      execute: async () => { const fresh = await prepare();try {
        z.object({}).strict().parse(await this.client.post('dmp/custom_audience/lookalike/update', { advertiser_id: op.accountId, custom_audience_ids: ids }));
        const results: Array<{ id: string; status: string; native_is_valid?: boolean }> = [];
        const actualRows = await this.audiences.inspect(op.accountId, ids);
        for (const row of fresh) { const actual = actualRows.find(actual => actual.audience_id === row.audience_id)!;owned(op.accountId, actual);if (actual.native_error_reported || canonical(customAudienceConfiguration(actual)) !== canonical(customAudienceConfiguration(row))) throw invalid();results.push({ id: row.audience_id, status: 'ACCEPTED_FOR_PROCESSING', native_is_valid: actual.is_valid }); }
        return { applied: true, resourceIds: ids, details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, metadata_preservation: 'VERIFIED', membership_verified: false, accepted_count: ids.length, results, next_tool: 'tiktok_get_custom_audience' }, warnings: notes.slice(1) };
      } catch (error) { throw audienceOperationFailure(error, ids); } } };
  }
}
