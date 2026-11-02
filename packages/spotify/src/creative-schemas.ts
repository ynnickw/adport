import { mediaSourceFields } from '@adport/core';
import { z } from 'zod';
import { budgetSchema, spotifyId } from './schemas.js';

const strings = z.array(z.string().min(1)).max(1000);
const money = z.number().int().nonnegative().safe();
const url = z.string().url().refine(value => { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }, 'Use an HTTP(S) destination without embedded credentials');
export const assetType = z.enum(['AUDIO', 'IMAGE', 'VIDEO']);
export const assetFormat = z.enum(['AUDIO', 'IMAGE', 'VIDEO', 'MULTI', 'CATALOG']);
const adLanguage = z.enum(['ARABIC', 'ARABIC_EGYPT', 'BULGARIAN', 'CHINESE', 'CHINESE_HK', 'CHINESE_TAIWAN', 'CROATIAN', 'CZECH', 'DANISH', 'DUTCH', 'ENGLISH', 'FINNISH', 'FRENCH', 'FRENCH_CANADA', 'GERMAN', 'GREEK', 'HEBREW', 'HUNGARIAN', 'INDONESIAN', 'ITALIAN', 'JAPANESE', 'KOREAN', 'NORWEGIAN', 'POLISH', 'PORTUGUESE', 'PORTUGUESE_PORTUGAL', 'ROMANIAN', 'RUSSIAN', 'SLOVAK', 'SPANISH', 'SPANISH_ARGENTINA', 'SPANISH_LATAM_CARIBBEAN', 'SPANISH_MEXICO', 'SWEDISH', 'THAI', 'TURKISH', 'UKRAINIAN', 'VIETNAMESE']);
export const deliveryGoal = z.enum(['UNSET', 'IMPRESSIONS', 'REACH', 'VIDEO_VIEWS', 'CLICKS', 'PAGE_VIEWS', 'APP_INSTALLS', 'STREAMS', 'LEADS']);
export const bidStrategy = z.enum(['COST_PER_RESULT', 'MAX_BID', 'AUTOBID', 'UNSET']);
export const frequencyCaps = z.array(z.object({ frequency_unit: z.enum(['DAY', 'WEEK', 'MONTH']), frequency_period: z.number().int().positive(), max_impressions: z.number().int().positive() }).strict()).max(6);
export const targets = z.object({
  age_ranges: z.array(z.object({ min: z.number().int().min(13).max(99), max: z.number().int().min(13).max(99) }).refine(v => v.max >= v.min)).optional(),
  artist_ids: strings.optional(), genre_ids: strings.optional(), interest_ids: z.array(spotifyId).optional(),
  geo_targets: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/).optional(), city_ids: strings.optional(), postal_code_ids: strings.optional(), region_ids: strings.optional() }).strict().optional(),
  genders: z.array(z.enum(['MALE', 'FEMALE', 'NON_BINARY'])).optional(), platforms: z.array(z.enum(['ANDROID', 'DESKTOP', 'IOS'])).optional(),
  podcast_episode_topic_ids: strings.optional(), language: z.string().regex(/^[a-z]{2}$/).optional(), playlist_ids: strings.optional(),
  placements: z.array(z.enum(['MUSIC', 'PODCAST', 'PODCAST_SAI', 'PODCAST_DAI'])).min(1).optional(),
  audience_ids: z.array(spotifyId).optional(), audience_ids_exclusions: z.array(spotifyId).optional(),
  sensitive_topic_exclusions: z.object({ topics: z.array(z.object({ id: z.string().min(1), filter_option: z.enum(['STANDARD', 'LIMITED', 'PARTIAL', 'RESTRICTED']) }).strict()).optional(), filter_option: z.enum(['STANDARD', 'LIMITED', 'PARTIAL', 'RESTRICTED']).optional() }).strict().refine(v => Boolean(v.topics) !== Boolean(v.filter_option), 'Choose topics or a global filter').optional(),
  user_day_parts: z.array(z.object({ day_of_week: z.array(z.enum(['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'])), hour_of_day: z.array(z.object({ min: z.number().int().min(0).max(23), max: z.number().int().min(0).max(23) }).refine(v => v.max >= v.min)) }).strict()).optional(),
}).strict();
export const campaignPatch = z.object({ name: z.string().trim().min(2).max(200).optional(), purchase_order: z.string().min(2).max(45).optional(), delivery_goal_group: z.enum(['AWARENESS', 'WEBSITE_TRAFFIC', 'APP_PROMOTION', 'ENGAGEMENT_ON_SPOTIFY', 'LEAD_GEN', 'VIDEO_VIEWS']).optional(), status: z.enum(['PAUSED', 'ACTIVE', 'ARCHIVED']).optional() }).strict();
export const groupPatch = z.object({
  name: z.string().trim().min(2).max(200).optional(), start_time: z.iso.datetime().optional(), end_time: z.iso.datetime().optional(),
  budget: budgetSchema.optional(), bid_micro_amount: money.optional(), bid_strategy: bidStrategy.optional(), targets: targets.optional(),
  category: z.string().regex(/^ADV_\d+_\d+$/).optional(), asset_format: assetFormat.optional(), delivery_goal: deliveryGoal.optional(),
  pacing: z.enum(['PACING_ASAP', 'PACING_EVEN']).optional(), frequency_caps: frequencyCaps.optional(), dataset_id: spotifyId.optional(), mobile_app_id: spotifyId.optional(),
}).strict();
export const adPatch = z.object({
  name: z.string().trim().min(2).max(200).optional(), advertiser_name: z.string().min(1).max(200).optional(), tagline: z.string().min(1).max(200).optional(),
  assets: z.object({ asset_id: spotifyId.optional(), logo_asset_id: spotifyId.optional(), companion_asset_id: spotifyId.optional(), canvas_asset_id: spotifyId.optional() }).strict().optional(),
  asset_format: assetFormat.optional(), call_to_action: z.object({ key: z.enum(['APPLY_NOW', 'BOOK_NOW', 'BUY_NOW', 'BUY_TICKETS', 'CLICK_NOW', 'DOWNLOAD', 'FIND_STORES', 'GET_COUPON', 'GET_INFO', 'INSTALL_NOW', 'LEARN_MORE', 'LISTEN_NOW', 'MORE_INFO', 'ORDER_NOW', 'PRE_SAVE', 'SAVE_NOW', 'SHARE', 'SHOP_NOW', 'SIGN_UP', 'VISIT_PROFILE', 'VISIT_SITE', 'WATCH_NOW']).optional(), language: adLanguage.optional(), clickthrough_url: url.optional() }).strict().optional(),
  third_party_tracking: z.array(z.object({ measurement_partner: z.enum(['IAS', 'DCM', 'UNSET']), url }).strict()).max(11).optional(),
  weight: z.number().int().min(1).max(100).optional(),
}).strict();
export const createGroup = groupPatch.extend({ campaign_id: spotifyId, name: z.string().trim().min(2).max(200) });
export const createAd = adPatch.extend({ ad_set_id: spotifyId, name: z.string().trim().min(2).max(200) });
export const draftEntity = z.enum(['campaigns', 'ad_sets', 'ads']);
export const draftMutation = z.object({ entity: draftEntity, draft_id: spotifyId });
export const updateCampaign = campaignPatch.extend({ draft_id: spotifyId }).refine(v => Object.keys(v).length > 1, 'Provide a change');
export const updateGroup = groupPatch.extend({ draft_id: spotifyId }).refine(v => Object.keys(v).length > 1, 'Provide a change');
export const updateAd = adPatch.extend({ draft_id: spotifyId }).refine(v => Object.keys(v).length > 1, 'Provide a change');
export const publishDraft = z.object({ draft_campaign_id: spotifyId, draft_hierarchy_version: z.number().int().positive() });
export const createAsset = z.object({ name: z.string().trim().min(2).max(120), asset_type: assetType, asset_subtype: z.enum(['BACKGROUND_MUSIC', 'USER_UPLOADED_AUDIO']).optional() }).refine(v => !v.asset_subtype || v.asset_type === 'AUDIO', 'Asset subtype is audio-only');
export const uploadAsset = z.object({ asset_id: spotifyId, ...mediaSourceFields }).refine(v => Number(Boolean(v.media_id)) + Number(Boolean(v.file_path)) === 1, 'Choose media_id or file_path');
export const assetResponse = z.looseObject({ id: spotifyId, name: z.string(), asset_type: assetType, status: z.string(), url: z.string().optional() });
export const draftResponse = z.looseObject({ id: spotifyId, name: z.string().nullable().optional(), ad_account_id: spotifyId.optional(), campaign_id: spotifyId.optional(), ad_set_id: spotifyId.optional(), status: z.string().nullable().optional(), draft_hierarchy_version: z.number().int().positive().nullable().optional() });
