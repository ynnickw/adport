import { z } from 'zod';
import { audienceId, audienceName } from './custom-audience-schemas.js';

export const audienceSourceType = z.enum(['APP', 'BUSINESS_ACCOUNT', 'ENGAGEMENT', 'ENGAGEMENT_LIVE_VIDEO', 'ENGAGEMENT_ORGANIC_VIDEO', 'LEAD_GENERATION', 'OFFLINE', 'PIXEL', 'TIKTOK_SHOP']);
export const eventSourceId = z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/);
const sourceIds = z.array(eventSourceId).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Source IDs must be unique');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const audienceIdentityFields = { identity_id: eventSourceId.optional(), identity_type: z.enum(['TT_USER', 'BC_AUTH_TT']).optional(), identity_authorized_bc_id: audienceId.optional() };
const identityIssues = (input: { identity_id?: string; identity_type?: string; identity_authorized_bc_id?: string }, needed: boolean, ctx: z.RefinementCtx) => {
  if (needed ? !input.identity_id || !input.identity_type : input.identity_id !== undefined || input.identity_type !== undefined || input.identity_authorized_bc_id !== undefined) ctx.addIssue({ code: 'custom', message: needed ? 'Select an exact TT_USER or BC_AUTH_TT identity for video sources' : 'Identity fields apply only to organic/live video sources' });
  if (input.identity_type === 'BC_AUTH_TT' ? !input.identity_authorized_bc_id : input.identity_authorized_bc_id !== undefined) ctx.addIssue({ code: 'custom', message: 'Only BC_AUTH_TT requires identity_authorized_bc_id' });
};
export const audienceSourceList = z.object({ account_id: audienceId, source_type: audienceSourceType, source_ids: sourceIds.optional(), ...audienceIdentityFields, page_size: z.number().int().positive().max(20).default(20), cursor: z.string().min(1).max(8192).optional() }).strict().superRefine((input, ctx) => {
  identityIssues(input, ['ENGAGEMENT_LIVE_VIDEO', 'ENGAGEMENT_ORGANIC_VIDEO'].includes(input.source_type), ctx);
  if (input.source_type === 'LEAD_GENERATION' && input.source_ids) ctx.addIssue({ code: 'custom', message: 'Lead-generation audiences use all available advertiser form events, not source IDs' });
});
export const audienceIdentityList = z.object({ account_id: audienceId, identity_type: z.enum(['TT_USER', 'BC_AUTH_TT', 'CUSTOMIZED_USER', 'AUTH_CODE']), identity_authorized_bc_id: audienceId.optional(), page: z.number().int().positive().safe().default(1), page_size: z.number().int().positive().max(100).default(100) }).strict().superRefine((input, ctx) => {
  if (input.identity_type === 'BC_AUTH_TT' ? !input.identity_authorized_bc_id : input.identity_authorized_bc_id !== undefined) ctx.addIssue({ code: 'custom', message: 'Only BC_AUTH_TT requires identity_authorized_bc_id' });
});
// Native event strings are preserved exactly. Published enum/example aliases differ;
// the API remains authoritative. Parameter-filter nesting also needs clarification.
const eventFilter = z.object({ field: z.literal('EVENT'), operator: z.literal('EQ'), value: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/) }).strict();
const rule = z.object({ event_source_ids: sourceIds.optional(), retention_days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60), z.literal(90), z.literal(180)]), filter_set: z.object({ operator: z.literal('OR'), filters: z.array(eventFilter).length(1) }).strict() }).strict();
const ruleSet = z.object({ operator: z.literal('OR'), rules: z.array(rule).min(1).max(20) }).strict();
export const audienceRuleSelection = z.object({ audience_type: audienceSourceType, ...audienceIdentityFields, rule_spec: z.object({ inclusion_rule_set: ruleSet, exclusion_rule_set: ruleSet.optional() }).strict(), acknowledge_all_event_sources: z.literal(true).optional() }).strict().superRefine((input, ctx) => {
  const video = ['ENGAGEMENT_LIVE_VIDEO', 'ENGAGEMENT_ORGANIC_VIDEO'].includes(input.audience_type);identityIssues(input, video, ctx);
  const rules = [...input.rule_spec.inclusion_rule_set.rules, ...(input.rule_spec.exclusion_rule_set?.rules ?? [])], ids = new Set(rules.flatMap(row => row.event_source_ids ?? []));
  if (ids.size > (video ? 10 : 100)) ctx.addIssue({ code: 'custom', message: video ? 'Select at most 10 distinct videos' : 'Select at most 100 distinct event sources' });
  for (const row of rules) {
    if (input.audience_type === 'LEAD_GENERATION' && row.event_source_ids !== undefined) ctx.addIssue({ code: 'custom', message: 'TikTok forbids event_source_ids for Lead Generation audiences' });
    if (!row.event_source_ids && !['ENGAGEMENT', 'LEAD_GENERATION'].includes(input.audience_type)) ctx.addIssue({ code: 'custom', message: 'Explicit event_source_ids are required for this audience type' });
    if (!row.event_source_ids && input.acknowledge_all_event_sources !== true) ctx.addIssue({ code: 'custom', message: 'Omitted event sources require acknowledgement of all current/future available advertiser sources' });
    if ((video || input.audience_type === 'BUSINESS_ACCOUNT' && row.filter_set.filters[0]!.value !== 'BUSINESS ACCOUNT PROFILE FOLLOW') && row.retention_days > 30) ctx.addIssue({ code: 'custom', message: 'This video/business event supports only 7, 14 or 30 lookback days' });
  }
});
export const audienceRuleContext = audienceRuleSelection.safeExtend({ account_id: audienceId });
export const ruleAudienceCreate = audienceRuleSelection.safeExtend({ custom_audience_name: audienceName, expected_context_hash: hash, is_auto_refresh: z.boolean(), audience_sub_type: z.enum(['NORMAL', 'REACH_FREQUENCY']).default('NORMAL'), retention_in_days: z.number().int().min(1).max(365).optional() });
export const lookalikeSpec = z.object({ source_audience_id: audienceId, include_source: z.boolean(), mobile_os: z.enum(['ALL', 'ANDROID', 'IOS']), placements: z.array(z.enum(['TikTok', 'TopBuzz & BuzzVideo', 'Pangle'])).min(1).max(3).refine(values => new Set(values).size === values.length), location_ids: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(100).refine(values => new Set(values).size === values.length), audience_size: z.enum(['NARROW', 'BALANCED', 'BROAD']) }).strict();
export const lookalikeAudienceCreate = z.object({ custom_audience_name: audienceName, expected_source_snapshot_hash: hash, lookalike_spec: lookalikeSpec }).strict();
export const lookalikeAudiencesRefresh = z.object({ targets: z.array(z.object({ custom_audience_id: audienceId, expected_snapshot_hash: hash }).strict()).min(1).max(100).refine(values => new Set(values.map(v => v.custom_audience_id)).size === values.length), acknowledge_shared_effects: z.literal(true) }).strict();
export function ruleSelection(input: z.infer<typeof audienceRuleSelection>) { return audienceRuleSelection.parse({ audience_type: input.audience_type, rule_spec: input.rule_spec, ...(input.identity_id ? { identity_id: input.identity_id, identity_type: input.identity_type, ...(input.identity_authorized_bc_id ? { identity_authorized_bc_id: input.identity_authorized_bc_id } : {}) } : {}), ...(input.acknowledge_all_event_sources ? { acknowledge_all_event_sources: true } : {}) }); }
