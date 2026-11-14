import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import { targeting } from './creative-tools.js';
import type { RedditAdsProvider } from './provider.js';
import { redditId as id } from './schemas.js';

const name = z.string().trim().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/), unique = (values: string[]) => new Set(values).size === values.length;
export const trackingType = z.enum(['PAGE_VISIT', 'VIEW_CONTENT', 'SEARCH', 'ADD_TO_CART', 'ADD_TO_WISHLIST', 'PURCHASE', 'LEAD', 'SIGN_UP', 'CUSTOM']);
export const customerAudience = z.object({ name, type: z.literal('CUSTOMER_LIST') }).strict();
export const pixelAudience = z.object({ name, type: z.literal('PIXEL_RETARGETING'), pixel_audience_config: z.object({ pixel_ids: z.array(id).length(1), targetings: z.array(trackingType).min(1).refine(unique, 'Use unique tracking types'), lookback_window_days: z.number().int().min(1).max(90), custom_targetings: z.array(z.string().min(1)).max(50).optional() }).strict() }).strict();
export const engagementAudience = z.object({ name, type: z.literal('ENGAGEMENT_RETARGETING'), engagement_audience_config: z.object({ campaign_ids: z.array(id).min(1).max(500).refine(unique, 'Use unique campaign IDs'), tracking_types: z.array(z.enum(['IMPRESSIONS', 'CLICKS', 'UPVOTES', 'COMMENT_SUBMISSIONS', 'VIDEO_WATCHED_50_PERCENT', 'VIDEO_WATCHED_100_PERCENT', 'VIDEO_STARTED'])).min(1).refine(unique, 'Use unique tracking types'), lookback_window_days: z.number().int().min(1).max(180) }).strict() }).strict();
export const customAudience = z.discriminatedUnion('type', [customerAudience, pixelAudience, engagementAudience]);
export const audienceUsers = z.object({ audience_id: id, action_type: z.enum(['ADD', 'REMOVE']), column_order: z.array(z.enum(['EMAIL_SHA256', 'MAID_SHA256'])).min(1).max(2).refine(unique, 'Use unique columns'), user_data: z.array(z.array(hash).min(1).max(2)).min(1).max(2500) }).refine(v => v.user_data.every(row => row.length === v.column_order.length), 'Each row must match column_order').refine(v => new Set(v.user_data.map(row => JSON.stringify(row))).size === v.user_data.length, 'Use unique rows');
// Saved audiences omit the ad-group-only placements dimension in current v3.
export const savedTargeting = targeting.omit({ locations: true });
export const createSaved = z.object({ name, targeting: savedTargeting });
export const updateSaved = z.object({ saved_audience_id: id, name: name.optional(), targeting: savedTargeting.optional() }).refine(v => v.name !== undefined || v.targeting !== undefined, 'Provide audience changes');
const href = z.string().url().max(4096).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }, 'Use an HTTP(S) URL without embedded credentials');
const text = z.string().min(1).max(2000), amount = z.number().finite().nonnegative();
export const conversionEvent = z.object({
  event_at: z.number().int().positive().safe().describe('Unix epoch milliseconds'), action_source: z.enum(['WEBSITE', 'APP', 'OTHER', 'PHYSICAL_STORE']),
  click_id: text.optional(), event_source_url: href.optional(), referrer_url: href.optional(),
  type: z.object({ tracking_type: trackingType, custom_event_name: z.string().min(1).max(64).optional() }).strict().refine(v => v.tracking_type !== 'CUSTOM' || Boolean(v.custom_event_name), 'CUSTOM needs custom_event_name'),
  metadata: z.object({ conversion_id: z.string().min(1).max(200).describe('Stable deduplication ID; reuse for retries'), order_id: z.string().max(100).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), item_count: z.number().int().nonnegative().optional(), value: amount.optional(), products: z.array(z.object({ id: text, category: text.optional(), name: text.optional(), quantity: z.number().int().nonnegative().optional(), item_price: amount.optional() }).strict()).optional() }).strict().refine(v => v.value === undefined || Boolean(v.currency), 'Revenue value requires currency'),
  user: z.object({ email: hash.optional(), external_id: hash.optional(), phone_number: hash.optional(), aaid: hash.optional(), idfa: hash.optional(), ip_address: z.union([z.ipv4(), z.ipv6()]).optional(), user_agent: text.optional(), uuid: text.optional(), data_processing_options: z.object({ country: text.optional(), region: text.optional(), modes: z.array(z.literal('LDU')).optional() }).strict().optional(), screen_dimensions: z.object({ height: z.number().int().min(0).max(32767), width: z.number().int().min(0).max(32767) }).strict().optional() }).strict().optional().describe('Pre-hash customer match keys using Reddit’s normalization rules; device IP/user-agent and Pixel UUID stay unhashed'),
}).strict();
export const sendEvents = z.object({ pixel_id: id, mode: z.enum(['TEST', 'LIVE']).default('TEST'), test_id: z.string().min(1).optional(), events: z.array(conversionEvent).min(1).max(1000) }).refine(v => v.mode === 'TEST' ? Boolean(v.test_id) : !v.test_id, 'TEST requires test_id; LIVE must omit test_id').refine(v => new Set(v.events.map(e => `${e.action_source}:${e.metadata.conversion_id}`)).size === v.events.length, 'Use unique conversion IDs within each action source');

export function redditManagementTools(provider: RedditAdsProvider): AnyToolDefinition[] {
  const account = { account_id: id }, page = { page_size: z.number().int().min(1).max(1000).default(50), cursor: z.string().url().optional() };
  const read = <T extends z.ZodRawShape>(name: string, description: string, input: z.ZodObject<T>, handler: (input: z.output<z.ZodObject<T>>) => Promise<unknown>) => defineTool({ name, namespace: 'reddit', description, input, annotations: { readOnly: true }, handler });
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove' = 'update') => guardedWriteTool({ name, namespace: 'reddit', provider: 'reddit', description, payload, kind });
  return [
    read('reddit_audiences', 'List custom audiences available to the account, including ownership, type, size and processing readiness.', z.object({ ...account, name: z.string().optional(), ...page }), v => provider.management.list(v, 'custom_audiences')),
    read('reddit_get_audience', 'Read one custom audience already available to the selected account. Availability does not grant editing rights to a shared audience.', z.object({ ...account, audience_id: id }), v => provider.management.audience(v.account_id, v.audience_id)),
    write('reddit_create_customer_audience', 'Create an empty customer-list audience. Membership upload is a separate approval with pre-hashed identifiers.', customerAudience.omit({ type: true }), 'create'),
    write('reddit_create_pixel_audience', 'Create website retargeting from one account-available Pixel and explicit event/window settings.', pixelAudience.omit({ type: true }), 'create'),
    write('reddit_create_engagement_audience', 'Create engagement retargeting from verified account-owned campaigns with explicit events/window settings.', engagementAudience.omit({ type: true }), 'create'),
    write('reddit_update_audience_users', 'Add/remove at most 2,500 pre-hashed customer rows from an owned CUSTOMER_LIST audience. Preview shows count and digest, not identifiers.', audienceUsers),
    write('reddit_delete_audience', 'Permanently delete an account-owned custom audience. Ads using it can lose eligibility; shared foreign audiences cannot be deleted.', z.object({ audience_id: id }), 'remove'),
    read('reddit_saved_audiences', 'List reusable saved targeting audiences and their native readiness/usage counts.', z.object({ ...account, ...page }), v => provider.management.list(v, 'saved_audiences')),
    read('reddit_get_saved_audience', 'Read an account-owned saved audience and its native targeting.', z.object({ ...account, saved_audience_id: id }), v => provider.management.saved(v.account_id, v.saved_audience_id)),
    write('reddit_create_saved_audience', 'Create reusable native REDDIT_AUDIENCE targeting, with expansion explicitly off unless supplied. Audience references must be account-available.', createSaved, 'create'),
    write('reddit_update_saved_audience', 'Change name or supplied saved targeting dimensions, preserving omitted settings. Changes can affect all ad groups using it.', updateSaved),
    write('reddit_delete_saved_audience', 'Mark an owned saved audience DELETED using native PATCH. Reports active ad-group usage before approval.', z.object({ saved_audience_id: id }), 'remove'),
    read('reddit_pixels', 'List Pixels already available to the selected ad account. Current v3 has no public Pixel creation/update endpoint.', z.object({ ...account, ...page }), v => provider.management.list(v, 'pixels')),
    read('reddit_pixel_last_fired', 'Read native last-fired timestamps after proving the Pixel is available to this account. Missing timestamps remain unavailable.', z.object({ ...account, pixel_id: id }), v => provider.management.lastFired(v.account_id, v.pixel_id)),
    write('reddit_send_conversion_events', 'Submit up to 1,000 deduplicated events to an account-available Pixel. Requires existing adsconversions scope. TEST needs Events Manager test_id; explicit LIVE affects measurement. Customer keys must be pre-hashed.', sendEvents, 'create'),
  ];
}
