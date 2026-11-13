import { z } from 'zod';
import { cardUri, mediaKey, snowflake } from './creative-tools.js';
import { postHash } from './post-schemas.js';
import { xId } from './schemas.js';

const unique = (values: string[]) => new Set(values).size === values.length;
const mediaKeys = z.array(mediaKey).max(4).refine(unique, 'Use unique media keys');
// X ignores seconds. Reject sub-minute input instead of silently changing approval.
export const scheduledTime = z.iso.datetime().regex(/T\d{2}:\d{2}:00Z$/, 'Use a UTC minute, ending in :00Z');
export const scheduledFields = z.object({
  as_user_id: snowflake, scheduled_at: scheduledTime,
  text: z.string().max(10_000).optional(), name: z.string().min(1).max(80).optional(),
  media_keys: mediaKeys.optional(), card_uri: cardUri.optional(),
}).strict().refine(value => Boolean(value.text?.trim() || value.media_keys?.length), 'Provide text or media');
export const createScheduled = scheduledFields.safeExtend({ expected_context_hash: postHash, acknowledge_automatic_publication: z.literal(true) });
export const updateScheduled = z.object({
  user_id: snowflake, scheduled_tweet_id: snowflake, expected_snapshot_hash: postHash,
  scheduled_at: scheduledTime.optional(), text: z.string().max(10_000).optional(), name: z.string().max(80).optional(),
  media_keys: mediaKeys.optional(), card_uri: cardUri.nullable().optional(),
  acknowledge_automatic_publication: z.literal(true), acknowledge_shared_effects: z.boolean().optional(),
}).strict().refine(value => ['scheduled_at', 'text', 'name', 'media_keys', 'card_uri'].some(key => value[key as keyof typeof value] !== undefined), 'Provide a changed field');
export const deleteScheduled = z.object({ user_id: snowflake, scheduled_tweet_id: snowflake, expected_snapshot_hash: postHash, acknowledge_permanent_deletion: z.literal(true) }).strict();
export const scheduledReference = z.object({ account_id: xId, user_id: snowflake, scheduled_tweet_id: snowflake }).strict();
export const scheduledList = z.object({ account_id: xId, user_id: snowflake, count: z.number().int().min(1).max(200).default(20), cursor: z.string().min(1).max(4096).optional(), include_media: z.boolean().default(true) }).strict();
export const nativeScheduled = z.object({
  id: snowflake, user_id: snowflake, account_id: xId.optional(), name: z.string().nullable(), text: z.string(),
  scheduled_status: z.string(), nullcast: z.boolean(), scheduled_at: z.iso.datetime(),
  card_uri: cardUri.nullable(), media_keys: mediaKeys, tweet_id: snowflake.nullable(),
  completed_at: z.iso.datetime().nullable().optional(),
});
export type ScheduledPost = z.infer<typeof nativeScheduled>;
export const nativeScheduledPromotion = z.object({ id: xId, account_id: xId.optional(), line_item_id: xId, scheduled_tweet_id: snowflake, tweet_id: snowflake.nullable(), deleted: z.boolean() });
export type ScheduledPromotion = z.infer<typeof nativeScheduledPromotion>;
export const scheduledPromotionList = z.object({ account_id: xId, line_item_id: xId, count: z.number().int().min(1).max(200).default(20), cursor: z.string().min(1).max(4096).optional(), with_deleted: z.boolean().default(false) }).strict();
export const scheduledPromotionSelection = z.object({ user_id: snowflake, line_item_id: xId, scheduled_tweet_id: snowflake }).strict();
export const createScheduledPromotion = scheduledPromotionSelection.safeExtend({ expected_context_hash: postHash, acknowledge_automatic_promotion: z.literal(true) });
export const deleteScheduledPromotion = z.object({ scheduled_promoted_tweet_id: xId, expected_context_hash: postHash }).strict();
export const scheduledWrites = new Set(['x_create_scheduled_post', 'x_update_scheduled_post', 'x_delete_scheduled_post', 'x_create_scheduled_promoted_post', 'x_delete_scheduled_promoted_post']);
