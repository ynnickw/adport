import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { XAdsProvider } from './provider.js';
import { xId as id } from './schemas.js';
import { X_PLACEMENTS } from './analytics.js';

const ids = z.array(id).min(1).max(200).refine(value => new Set(value).size === value.length, 'Use unique IDs');
const page = { account_id: id, count: z.number().int().min(1).max(1000).default(200), cursor: z.string().min(1).max(4096).optional(), with_deleted: z.boolean().default(false), with_total_count: z.boolean().default(false).describe('Request a total on the initial page; native cursor requests omit this flag') };
export const webTags = z.object({ account_id: id, count: page.count, cursor: page.cursor, with_deleted: page.with_deleted }).strict();
export const appTags = z.object({ ...page, app_event_tag_ids: ids.optional() }).strict();
export const trackingTags = z.object({ ...page, tracking_tag_ids: ids.optional(), line_item_ids: ids.optional() }).strict();
export const webTag = z.object({ account_id: id, web_event_tag_id: id, with_deleted: page.with_deleted }).strict();
export const appTag = z.object({ account_id: id, app_event_tag_id: id, with_deleted: page.with_deleted }).strict();
export const trackingTag = z.object({ account_id: id, tracking_tag_id: id, with_deleted: page.with_deleted }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const url = z.url({ protocol: /^https$/ }).max(8192).refine(value => { const parsed = new URL(value); return !parsed.username && !parsed.password && !parsed.hash; }, 'Use an HTTPS tracking URL without credentials or a fragment');
export const createTrackingTag = z.object({ line_item_id: id, tracking_tag_type: z.enum(['IMPRESSION_TAG', 'CLICK_TRACKER']), tracking_tag_url: url }).strict();
export const updateTrackingTag = z.object({ tracking_tag_id: id, expected_configuration_hash: hash, tracking_tag_url: url }).strict();
export const deleteTrackingTag = z.object({ tracking_tag_id: id, expected_configuration_hash: hash }).strict();
export const conversionStats = z.object({
  account_id: id, entity: z.enum(['CAMPAIGN', 'LINE_ITEM', 'PROMOTED_TWEET']),
  entity_ids: z.array(id).min(1).max(20).refine(value => new Set(value).size === value.length, 'Use unique entity IDs'),
  start_date: z.iso.date(), end_date: z.iso.date(), placement: z.enum(X_PLACEMENTS),
  metric_group: z.enum(['WEB_CONVERSION', 'MOBILE_CONVERSION']),
}).strict().refine(value => value.end_date >= value.start_date && Date.parse(value.end_date) - Date.parse(value.start_date) < 30 * 86_400_000, 'Choose an inclusive range of at most 30 days');

export function xMeasurementTools(provider: XAdsProvider): AnyToolDefinition[] {
  const read = { namespace: 'x', presentation: 'records' as const, output: z.looseObject({ records: z.array(z.record(z.string(), z.unknown())) }), annotations: { readOnly: true } };
  const write = { namespace: 'x', provider: 'x' };
  return [
    defineTool({ ...read, name: 'x_web_event_tags', description: 'Inspect native account-scoped website conversion tags and embed code as inert data. Native cursors preserve pagination. This does not create events or install a pixel.', input: webTags, pagination: { cursorInput: 'cursor' }, handler: input => provider.measurement.listWeb(input) }),
    defineTool({ ...read, name: 'x_get_web_event_tag', description: 'Read one website conversion tag by exact account and ID, without executing embed code or sending an event.', input: webTag, handler: input => provider.measurement.getWeb(input) }),
    defineTool({ ...read, name: 'x_app_event_tags', description: 'Inspect native app event tags, app identity, conversion type and attribution windows with exact ID filters and cursor pagination. Sends no app events.', input: appTags, pagination: { cursorInput: 'cursor' }, handler: input => provider.measurement.listApp(input) }),
    defineTool({ ...read, name: 'x_get_app_event_tag', description: 'Read one native app event tag and attribution windows in the selected account. Sends no events.', input: appTag, handler: input => provider.measurement.getApp(input) }),
    defineTool({ ...read, name: 'x_tracking_tags', description: 'Inspect native impression/click tracking tags with account/line-item ownership checks, configuration hashes and native cursor/ID filters.', input: trackingTags, pagination: { cursorInput: 'cursor' }, handler: input => provider.measurement.listTracking(input) }),
    defineTool({ ...read, name: 'x_get_tracking_tag', description: 'Read one impression/click tracking tag and its configuration_hash after checking its line item and campaign in the selected account.', input: trackingTag, handler: input => provider.measurement.getTracking(input) }),
    guardedWriteTool({ ...write, name: 'x_create_tracking_tag', kind: 'create', destructive: false, description: 'Associate an HTTPS impression or click tracker with an existing non-draft line item. May immediately change measurement on an active ad group. Verifies native receipt/readback; sends no test event and never retries automatically.', payload: createTrackingTag }),
    guardedWriteTool({ ...write, name: 'x_update_tracking_tag', kind: 'update', destructive: false, description: 'Change only a tracking-tag URL using a current configuration_hash. Preserves its parent/type and independently reads back the result. May affect active measurement immediately; no automatic retry.', payload: updateTrackingTag }),
    guardedWriteTool({ ...write, name: 'x_delete_tracking_tag', kind: 'remove', destructive: true, description: 'Disassociate a tracking tag using a current configuration_hash. Verifies native deleted=true and independent readback. Can stop third-party measurement; does not pause ads or claim a restore endpoint.', payload: deleteTrackingTag }),
    defineTool({ ...read, name: 'x_conversion_stats', description: 'Read native WEB_CONVERSION or separately requested MOBILE_CONVERSION objects for up to 20 verified entities and 30 account-local dates. Placement is explicit. Preserves native fields/units; does not label them normalized conversions, revenue, CPA or ROAS.', input: conversionStats, handler: input => provider.measurement.conversions(input) }),
  ];
}
