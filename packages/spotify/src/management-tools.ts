import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { SpotifyAdsProvider } from './provider.js';
import { spotifyId } from './schemas.js';

const account = { account_id: spotifyId };
const page = { limit: z.number().int().positive().max(50).default(50), offset: z.number().int().nonnegative().default(0) };
const ids = z.array(spotifyId).min(1).max(100);
const nativeFields = z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).max(100);
const insightDimension = z.enum(['ACT_AND_SET', 'AGE', 'AUDIENCE', 'CITY', 'COUNTRY', 'DEVICE_TYPE', 'FORMAT', 'GENDER', 'GENRE', 'INTERESTS', 'METRO', 'PLACEMENT', 'PLACEMENT_TYPE', 'PLATFORM', 'PODCAST_EPISODE_TOPIC', 'REGION', 'TONE']);
const audienceName = z.string().trim().min(2).max(80);
const description = z.string().max(80).optional();
// JSON Schema consumers do not share JavaScript's Unicode-regexp flag.
// Keep the native name rule at runtime without exporting a nonportable pattern.
const reportName = z.string().trim().min(2).max(120).refine(value => /^[\p{L}\p{N} _-]+$/u.test(value), 'Use letters, numbers, spaces, underscores or hyphens').describe('Unicode letters/numbers, spaces, underscores and hyphens.');
export const createAudience = z.object({ name: audienceName, description, subtype: z.enum(['WEB_EVENT', 'AD_ENGAGEMENT']), dataset_ids: ids.optional(), campaign_ids: ids.optional(), ad_set_ids: ids.optional(), included_events: z.array(z.string().min(1)).min(1).max(100).optional(), excluded_events: z.array(z.string().min(1)).max(100).optional(), lookback_days: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(180)]), exposure_type: z.enum(['IMPRESSIONS', 'CLICKS']).optional() }).strict().superRefine((value, ctx) => {
  if (value.subtype === 'WEB_EVENT' && (!value.dataset_ids || !value.included_events || value.campaign_ids || value.ad_set_ids || value.exposure_type)) ctx.addIssue({ code: 'custom', message: 'Web-event audiences require datasets and included events, without engagement fields' });
  if (value.subtype === 'AD_ENGAGEMENT' && (Boolean(value.campaign_ids) === Boolean(value.ad_set_ids) || !value.exposure_type || value.dataset_ids || value.included_events || value.excluded_events)) ctx.addIssue({ code: 'custom', message: 'Engagement audiences require campaign_ids or ad_set_ids plus exposure_type, without web-event fields' });
});
export const createLookalike = z.object({ name: audienceName, description, seed_audience_id: spotifyId });
export const updateAudience = z.object({ audience_id: spotifyId, name: audienceName.optional(), description }).refine(v => v.name !== undefined || v.description !== undefined, 'Provide an audience field');
export const deleteAudience = z.object({ audience_id: spotifyId });
export const createReport = z.object({ name: reportName, granularity: z.enum(['LIFETIME', 'DAY']), dimensions: nativeFields, metrics: nativeFields, statuses: nativeFields.optional(), campaign_ids: ids.optional(), report_start: z.iso.datetime().optional(), report_end: z.iso.datetime().optional(), insight_dimension: insightDimension.optional(), attribution_window: z.enum(['IMPRESSION_30_DAY', 'IMPRESSION_7_DAY']).optional() }).superRefine((value, ctx) => {
  if (value.granularity === 'DAY' && (!value.report_start || !value.report_end)) ctx.addIssue({ code: 'custom', message: 'Daily exports require report_start and report_end' });
  if (value.insight_dimension && (value.granularity !== 'LIFETIME' || value.report_start || value.report_end)) ctx.addIssue({ code: 'custom', message: 'Insight exports require LIFETIME without report dates' });
  if (value.report_start && value.report_end && (Date.parse(value.report_end) < Date.parse(value.report_start) || Date.parse(value.report_end) - Date.parse(value.report_start) > 365 * 86_400_000)) ctx.addIssue({ code: 'custom', message: 'Report dates must be ordered and within365 days' });
  if ([value.report_start, value.report_end].some(v => v && !/T00:00:00Z$/.test(v))) ctx.addIssue({ code: 'custom', message: 'Use UTC midnight report dates' });
});
export const managementWriteNames = new Set(['spotify_create_audience', 'spotify_create_lookalike_audience', 'spotify_update_audience', 'spotify_delete_audience', 'spotify_create_report']);

export function spotifyManagementTools(provider: SpotifyAdsProvider): AnyToolDefinition[] {
  const read = <T extends z.ZodRawShape>(name: string, description: string, input: z.ZodObject<T>, handler: (input: z.output<z.ZodObject<T>>) => Promise<unknown>) => defineTool({ name, namespace: 'spotify', description, input, annotations: { readOnly: true }, handler });
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove') => guardedWriteTool({ name, namespace: 'spotify', provider: 'spotify', description, payload, kind });
  return [
    read('spotify_audiences', 'Read existing account-owned custom/lookalike audiences with native filters and pagination. Does not upload customer records.', z.object({ ...account, audience_ids: ids.optional(), audience_types: z.array(z.enum(['CUSTOM', 'LOOKALIKE'])).optional(), q: z.string().optional(), ...page }), input => provider.management.audiences(input)),
    read('spotify_get_audience', 'Read one account-owned custom/lookalike audience and its processing status.', z.object({ ...account, audience_id: spotifyId }), input => provider.management.audience(input.account_id, input.audience_id)),
    read('spotify_audience_datasets', 'Read eligible account datasets and available web events for audience creation. Returns native pagination limits.', z.object({ ...account, q: z.string().optional(), limit: z.number().int().positive().max(50).default(50) }), input => provider.management.eligibleDatasets(input)),
    read('spotify_insight_report', 'Read native lifetime insights for exactly one verified published ad set, as required by the live endpoint. Missing/suppressed conversion fields remain unavailable.', z.object({ ...account, ad_set_id: spotifyId, insight_dimension: insightDimension, fields: nativeFields, statuses: nativeFields.optional() }), input => provider.management.insights(input)),
    read('spotify_change_history', 'Read account change history within Spotify’s rolling180-day window. Actor details and billing rows depend on the caller’s role.', z.object({ ...account, entity_type: z.enum(['CAMPAIGN', 'AD_SET', 'AD_ACCOUNT', 'BUSINESS', 'CREATIVE']).optional(), entity_ids: ids.optional(), entity_name: z.string().optional(), created_gte: z.iso.datetime().optional(), created_lte: z.iso.datetime().optional(), change_category: z.enum(['STATUS', 'BUDGET', 'TARGETING', 'CREATIVE', 'SCHEDULING', 'SETTINGS', 'BILLING']).optional(), sort_direction: z.enum(['ASC', 'DESC']).default('DESC'), ...page }), input => provider.management.read(input, 'change_history')),
    read('spotify_report_status', 'Read a previously submitted account export’s status and native CSV URL. Does not fetch arbitrary URLs or create a public share.', z.object({ ...account, report_id: spotifyId }), input => provider.management.read({ account_id: input.account_id }, `async_reports/${input.report_id}`)),
    write('spotify_create_audience', 'Create a web-event or ad-engagement audience from existing account-owned resources. Does not upload customer records or attach targeting to ads.', createAudience, 'create'),
    write('spotify_create_lookalike_audience', 'Create a lookalike from an existing account-owned seed audience. Does not upload customer records or change ad targeting.', createLookalike, 'create'),
    write('spotify_update_audience', 'Rename or edit the description of an account-owned audience, preserving its native type and source rules.', updateAudience, 'update'),
    write('spotify_delete_audience', 'Delete an account-owned audience through the normal preview/apply gate. Review dependencies before applying.', deleteAudience, 'remove'),
    write('spotify_create_report', 'Submit a native asynchronous CSV export job. No ad or delivery changes. Native field names are server-validated; use spotify_report_status for completion.', createReport, 'create'),
  ];
}
