import { creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { XAdsProvider } from './provider.js';
import { xId } from './schemas.js';

export const snowflake = z.string().regex(/^[1-9]\d{0,24}$/);
export const mediaKey = z.string().regex(/^\d+_[1-9]\d{0,24}$/);
export const cardUri = z.string().regex(/^card:\/\/[1-9]\d{0,24}$/);
const text = z.string().max(10_000).describe('Native weighted-length/content validation happens on apply; local preview is not server validation.');
const mediaKeys = z.array(mediaKey).max(4).refine(v => new Set(v).size === v.length, 'Use unique media keys');
const draftFields = { text: text.optional(), name: z.string().min(1).max(80).optional(), media_keys: mediaKeys.optional(), card_uri: cardUri.nullable().optional() };
export const createDraft = z.object({ as_user_id: snowflake, ...draftFields });
export const updateDraft = z.object({ draft_tweet_id: snowflake, ...draftFields }).refine(v => Object.keys(v).length > 1, 'Provide draft changes');
export const updateLibrary = z.object({ media_key: mediaKey, name: z.string().min(1).max(100).optional(), file_name: z.string().min(1).max(255).optional(), title: z.string().max(70).optional(), description: z.string().max(200).optional(), poster_media_key: mediaKey.optional() }).refine(v => Object.keys(v).length > 1, 'Provide library changes');
export const draftList = z.object({ account_id: xId, count: z.number().int().min(1).max(200).default(20), cursor: z.string().optional(), user_id: snowflake.optional(), include_media: z.boolean().default(true) });
export const libraryList = z.object({ account_id: xId, count: z.number().int().min(1).max(50).default(20), cursor: z.string().optional(), media_type: z.enum(['IMAGE', 'GIF', 'VIDEO']).optional(), q: z.string().min(1).max(255).optional() });

export function xCreativeTools(provider: XAdsProvider): AnyToolDefinition[] {
  const read = <T extends z.ZodRawShape>(name: string, description: string, input: z.ZodObject<T>, handler: (value: z.output<z.ZodObject<T>>) => Promise<unknown>) => defineTool({ name, namespace: 'x', description, input, annotations: { readOnly: true }, handler });
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove' = 'update') => guardedWriteTool({ name, namespace: 'x', provider: 'x', kind, description, payload });
  return [
    defineTool({ name: 'x_draft_tweets', namespace: 'x', description: 'View native account drafts with actual copy, media previews and guarded edit actions. Native draft state is separate from ad delivery.', input: draftList, output: creativesOutput.passthrough(), presentation: 'creatives', pagination: { cursorInput: 'cursor' }, annotations: { readOnly: true }, handler: v => provider.creatives.drafts(v) }),
    read('x_get_draft_tweet', 'Read a native draft through the selected account, keeping snowflake IDs as strings.', z.object({ account_id: xId, draft_tweet_id: snowflake }), v => provider.creatives.draft(v.account_id, v.draft_tweet_id)),
    defineTool({ name: 'x_media_library', namespace: 'x', description: 'View native account media-library images, GIFs and videos, processing state and metadata edit actions.', input: libraryList, output: creativesOutput.passthrough(), presentation: 'creatives', pagination: { cursorInput: 'cursor' }, annotations: { readOnly: true }, handler: v => provider.creatives.library(v) }),
    read('x_get_media_library_item', 'Read one account-scoped media-library item, including native processing readiness and preview URLs.', z.object({ account_id: xId, media_key: mediaKey }), v => provider.creatives.media(v.account_id, v.media_key)),
    read('x_promotable_users', 'Read account-associated users and FULL/RETWEETS_ONLY eligibility for creative authoring.', z.object({ account_id: xId }), v => provider.creatives.users(v.account_id)),
    read('x_authenticated_user_access', 'Read the authenticated actor and native account permissions, including TWEET_COMPOSER when granted.', z.object({ account_id: xId }), v => provider.creatives.access(v.account_id)),
    read('x_get_cards', 'Read exact native cards by account-associated card URI, including legacy card content.', z.object({ account_id: xId, card_uris: z.array(cardUri).min(1).max(200), with_deleted: z.boolean().default(false) }), v => provider.creatives.cards(v.account_id, v.card_uris, v.with_deleted)),
    write('x_create_draft_tweet', 'Create a promoted-only native draft; no post publication or ad association. Checks FULL advertiser/composer access and owned ready media/cards. Local preview is not native content validation.', createDraft, 'create'),
    write('x_update_draft_tweet', 'Edit supplied native draft copy/name/media/card fields, preserving omitted values and nullcast state. Empty media_keys clears media; null card_uri clears the card.', updateDraft),
    write('x_delete_draft_tweet', 'Permanently delete one verified native draft. This cannot be undone and does not delete an already published post.', z.object({ draft_tweet_id: snowflake }), 'remove'),
    write('x_update_media_library', 'Edit native media-library metadata or a video poster, preserving omitted fields. Metadata can be shared with existing creatives; library status is separate from ad delivery.', updateLibrary),
    write('x_delete_media_library_item', 'Delete a verified native media-library record. Existing posts/ads may retain media; this is not an ad pause or proof of underlying byte deletion.', z.object({ media_key: mediaKey }), 'remove'),
  ];
}
