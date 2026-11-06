import { z } from 'zod';
import { cardUri, mediaKey, snowflake } from './creative-tools.js';
import { xId } from './schemas.js';

const unique = (values: string[]) => new Set(values).size === values.length;
export const postHash = z.string().regex(/^[a-f0-9]{64}$/);
export const postFields = z.object({
  as_user_id: snowflake,
  text: z.string().max(10_000).optional().describe('X validates native weighted length/content at apply.'),
  name: z.string().min(1).max(80).optional(),
  media_keys: z.array(mediaKey).min(1).max(4).refine(unique, 'Use unique media keys').optional(),
  card_uri: cardUri.optional(),
  conversation_settings: z.enum(['EVERYONE', 'FOLLOWING', 'MENTIONED_USERS']).default('EVERYONE'),
  video_cta: z.enum(['VISIT_SITE', 'WATCH_NOW']).optional(),
  video_cta_value: z.url().refine(value => { const url = new URL(value);return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }, 'Use an HTTP(S) URL without credentials').optional(),
  video_title: z.string().max(70).optional(),
  video_description: z.string().max(200).optional(),
}).strict().refine(value => Boolean(value.text?.trim() || value.media_keys?.length), 'Provide text or media')
  .refine(value => (value.video_cta !== undefined) === (value.video_cta_value !== undefined), 'Provide video_cta and video_cta_value together');
export const createPost = postFields.safeExtend({ expected_context_hash: postHash, confirm_publication: z.literal(true) });
export const renamePost = z.object({ user_id: snowflake, tweet_id: snowflake, expected_snapshot_hash: postHash, name: z.string().min(1).max(80) }).strict();
export const postList = z.object({ account_id: xId, user_id: snowflake, timeline_type: z.enum(['NULLCAST', 'ORGANIC', 'ALL']).default('NULLCAST'), include_mentions_and_replies: z.boolean().default(false), name: z.string().min(1).max(80).optional(), count: z.number().int().min(1).max(200).default(20), cursor: z.string().min(1).max(4096).optional() }).strict();
export const postReference = z.object({ account_id: xId, user_id: snowflake, tweet_id: snowflake }).strict();
export const promotionSelection = z.object({ line_item_id: xId, user_id: snowflake, tweet_ids: z.array(snowflake).min(1).max(50).refine(unique, 'Use unique post IDs') }).strict();
export const createPromotions = promotionSelection.safeExtend({ expected_context_hash: postHash, acknowledge_active_associations: z.literal(true) });
export const deletePromotion = z.object({ promoted_tweet_id: xId, expected_context_hash: postHash }).strict();
export const promotionList = z.object({ account_id: xId, line_item_id: xId, user_id: snowflake.optional(), count: z.number().int().min(1).max(200).default(20), cursor: z.string().min(1).max(4096).optional(), with_deleted: z.boolean().default(false) }).strict();

const urlEntity = z.object({ url: z.string(), expanded_url: z.string().optional(), display_url: z.string().optional(), indices: z.array(z.number().int().nonnegative()).length(2).optional() });
const mediaEntity = z.object({ id_str: snowflake, type: z.string(), media_key: mediaKey.optional(), media_url_https: z.string().optional(), url: z.string().optional(), expanded_url: z.string().optional(), video_info: z.object({ variants: z.array(z.object({ content_type: z.string(), url: z.string(), bitrate: z.number().nonnegative().optional() })).max(100) }).optional() });
export const nativePost = z.object({
  id_str: snowflake, user: z.object({ id_str: snowflake }), name: z.string().nullable(),
  full_text: z.string(), nullcast: z.boolean(), tweet_type: z.literal('PUBLISHED'),
  conversation_settings: z.string().optional(), truncated: z.boolean().optional(),
  entities: z.object({ urls: z.array(urlEntity).max(1000).optional(), media: z.array(mediaEntity).max(100).optional() }).optional(),
  extended_entities: z.object({ media: z.array(mediaEntity).max(100) }).optional(),
});
export type NativePost = z.infer<typeof nativePost>;
export const postWrites = new Set(['x_create_promoted_only_post', 'x_rename_published_post', 'x_create_promoted_posts', 'x_delete_promoted_post']);
