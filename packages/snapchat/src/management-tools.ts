import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { SnapchatAdsProvider } from './provider.js';
import { snapchatId as id } from './schemas.js';

const name = z.string().trim().min(1).max(375), days = z.number().int().min(1).max(395);
export const retention = z.union([days, z.literal(9999)]);
const common = { name, description: z.string().max(2000).optional() };
export const events = z.enum(['APP_INSTALL', 'PURCHASE', 'SAVE', 'START_CHECKOUT', 'ADD_CART', 'VIEW_CONTENT', 'ADD_BILLING', 'SIGN_UP', 'SEARCH', 'LEVEL_COMPLETE', 'APP_OPEN', 'PAGE_VIEW', 'SUBSCRIBE', 'AD_CLICK', 'AD_VIEW', 'COMPLETE_TUTORIAL', 'INVITE', 'LOGIN', 'SHARE', 'RESERVE', 'ACHIEVEMENT_UNLOCKED', 'ADD_TO_WISHLIST', 'SPENT_CREDITS', 'RATE', 'START_TRIAL', 'LIST_VIEW', 'CUSTOM_EVENT_1', 'CUSTOM_EVENT_2', 'CUSTOM_EVENT_3', 'CUSTOM_EVENT_4', 'CUSTOM_EVENT_5']);
const eventList = z.array(events).min(1).max(31).refine(v => new Set(v).size === v.length, 'Events must be unique');
export const customerAudience = z.object({ ...common, retention_in_days: retention.default(180) });
export const websiteAudience = z.object({ ...common, pixel_id: id, retention_in_days: days.default(180), events: eventList });
export const mobileAudience = z.object({ ...common, mobile_app_id: id, retention_in_days: days.default(180), events: eventList });
export const engagementAudience = z.object({ ...common, engagement_specs: z.array(z.object({ engagement_type: z.enum(['SNAP_ADS_SWIPE_UP', 'SNAP_ADS_TOP_VIEW_THRU_100', 'PROMOTED_STORY_TAP', 'CREATIVE_TOOLS_USE', 'PAID_IMPRESSIONS', 'NATIVE_LEAD_GEN_SUBMITTED']), source_type: z.enum(['AD_SQUAD', 'CAMPAIGN', 'AD_ACCOUNT']), source_id: id }).strict()).min(1).max(100) });
export const profileAudience = z.object({ ...common, profile_id: id, engagement_type: z.enum(['SUBSCRIBERS', 'ENGAGERS']), retention_in_days: days.max(180).default(180) });
export const lookalike = z.object({ ...common, seed_segment_id: id, countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(100), type: z.enum(['BALANCE', 'SIMILARITY', 'REACH']).default('BALANCE'), retention_in_days: days.max(180).default(180) });
export const audienceUpdate = z.object({ segment_id: id, name: name.optional(), description: z.string().max(2000).optional(), retention_in_days: retention.optional() }).refine(v => Object.keys(v).length > 1, 'Provide an audience field');
export const audienceUsers = z.object({ segment_id: id, schema: z.enum(['EMAIL_SHA256', 'MOBILE_AD_ID_SHA256', 'PHONE_SHA256']), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(10_000).refine(v => new Set(v).size === v.length, 'Hashes must be unique') });
export const conversionSource = { source_type: z.enum(['PIXEL', 'MOBILE_APP']), source_id: id };
export const conversionCreate = z.object({ ...common, ...conversionSource, event_type: events, rules: z.array(z.object({ key: z.enum(['EVENT_TAG', 'ITEM_ID', 'ITEM_CATEGORY', 'CURRENCY', 'SEARCH_STRING', 'SIGN_UP_METHOD', 'PAGE_URL', 'CATEGORY', 'CATEGORY_ID', 'BRAND', 'DELIVERY_METHOD', 'CUSTOMER_STATUS', 'PRICE', 'NUMBER_ITEMS']), values: z.array(z.union([z.string().max(2000), z.number().finite()])).min(1).max(100), operator: z.enum(['EQUAL_TO', 'NOT_EQUAL_TO', 'I_CONTAINS', 'I_NOT_CONTAINS', 'CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'I_STARTS_WITH', 'I_EQUAL_TO', 'I_NOT_EQUAL_TO', 'LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUALS']) }).strict()).min(1).max(100) }).superRefine((v, ctx) => { for (const [index, rule] of v.rules.entries()) { const numeric = ['PRICE', 'NUMBER_ITEMS'].includes(rule.key); if (rule.values.some(value => (typeof value === 'number') !== numeric) || (!numeric && /^(LESS|GREATER)_/.test(rule.operator)) || (numeric && !['EQUAL_TO', 'NOT_EQUAL_TO', 'LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUALS'].includes(rule.operator))) ctx.addIssue({ code: 'custom', path: ['rules', index], message: 'Rule value type/operator does not match the native key' }); } });
export const measurementUpdate = z.object({ ad_squad_id: id, pixel_id: id.optional(), mobile_app_id: id.optional() }).refine(v => Boolean(v.pixel_id || v.mobile_app_id), 'Provide an existing measurement source');

export function snapchatManagementTools(provider: SnapchatAdsProvider): AnyToolDefinition[] {
  const account = { account_id: id }, page = { limit: z.number().int().min(1).max(1000).default(50), cursor: z.string().min(1).optional() };
  const read = <T extends z.ZodRawShape>(name: string, description: string, input: z.ZodObject<T>, handler: (input: z.output<z.ZodObject<T>>) => Promise<unknown>) => defineTool({ name, namespace: 'snapchat', description, input, annotations: { readOnly: true }, handler });
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove' = 'update') => guardedWriteTool({ name, namespace: 'snapchat', provider: 'snapchat', description, payload, kind });
  return [
    read('snapchat_audiences', 'Read selected-account audience segment metadata and readiness; does not retrieve individual users.', z.object({ ...account, ...page }), v => provider.management.audiences(v)),
    read('snapchat_get_audience', 'Read an account-owned audience by ID, including native seed/specification and readiness fields.', z.object({ ...account, segment_id: id }), v => provider.management.audience(v.account_id, v.segment_id)),
    read('snapchat_pixels', 'Read pixels already available to this account. Pixel creation is done in Snap Ads Manager; this tool does not install tracking or send events.', z.object(account), v => provider.management.pixels(v.account_id)),
    read('snapchat_mobile_apps', 'List Snap App IDs already shared with the selected account; does not create or widen sharing.', z.object(account), v => provider.creatives.shared(v.account_id, 'mobile_apps')),
    read('snapchat_custom_conversions', 'Read native custom conversion definitions for an account-available Pixel or Snap App.', z.object({ ...account, ...conversionSource, ...page }), v => provider.management.conversions(v)),
    read('snapchat_audience_size', 'Read the non-binding audience size for an account-owned ad squad using native audience_size_v2.', z.object({ ...account, ad_squad_id: id }), v => provider.management.audienceSize(v.account_id, v.ad_squad_id)),
    write('snapchat_create_customer_audience', 'Create an empty FIRST_PARTY audience. No customer records are uploaded; 9999 means lifetime retention.', customerAudience, 'create'),
    write('snapchat_create_website_audience', 'Create a website-event audience from an account-available Pixel. Snap requires historical-event prefill; does not install tracking or send events.', websiteAudience, 'create'),
    write('snapchat_create_mobile_audience', 'Create a mobile-event audience from an already-available Snap App ID with historical-event prefill.', mobileAudience, 'create'),
    write('snapchat_create_engagement_audience', 'Create an audience from verified ad-account/campaign/ad-squad engagements. Native retention is 395 days; source entries are ORed.', engagementAudience, 'create'),
    write('snapchat_create_profile_audience', 'Create a subscribers/engagers audience from an already-shared Public Profile, with up to 180 days retention.', profileAudience, 'create'),
    write('snapchat_create_lookalike', 'Create a lookalike from an owned first-party or profile-engagement seed using native countries, similarity mode and retention.', lookalike, 'create'),
    write('snapchat_update_audience', 'Update an owned audience’s metadata/retention while preserving omitted mutable fields. Does not replace its event or seed specification.', audienceUpdate),
    write('snapchat_add_audience_users', 'Add up to 10000 pre-normalized lowercase SHA-256 identifiers to an owned FIRST_PARTY audience. Preview shows counts/digest, never identifiers. Raw personal data is rejected.', audienceUsers),
    write('snapchat_remove_audience_users', 'Remove up to 10000 SHA-256 identifiers from an owned FIRST_PARTY audience. Membership changes affect ads targeting the segment.', audienceUsers, 'remove'),
    write('snapchat_clear_audience_users', 'Remove all members from an owned FIRST_PARTY audience. This cannot be undone without uploading the identifiers again.', z.object({ segment_id: id }), 'remove'),
    write('snapchat_delete_audience', 'Permanently delete an owned audience. Existing targeting references can stop matching; use the separate preview/apply gate.', z.object({ segment_id: id }), 'remove'),
    write('snapchat_rename_pixel', 'Rename an account-owned Pixel. Shared pixels from other accounts cannot be renamed through this account.', z.object({ pixel_id: id, name })),
    write('snapchat_set_adsquad_measurement', 'Associate existing account-available Pixel/Snap App IDs with a verified ad squad using partial JSON Patch. Does not install code or send events.', measurementUpdate),
    write('snapchat_create_custom_conversion', 'Create a typed native Pixel/App custom conversion rule after verifying source access. Does not transmit a conversion event.', conversionCreate, 'create'),
    write('snapchat_delete_custom_conversion', 'Permanently delete a custom conversion after verifying access to its Pixel/App source.', z.object({ custom_conversion_id: id }), 'remove'),
  ];
}
