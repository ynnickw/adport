import { z } from 'zod';
import { cardUri, mediaKey, snowflake } from './creative-tools.js';
import { xId } from './schemas.js';

export const cardTypes = z.enum(['IMAGE_APP', 'IMAGE_CAROUSEL_APP', 'IMAGE_CAROUSEL_WEBSITE', 'IMAGE_MULTI_DEST_CAROUSEL_WEBSITE', 'IMAGE_WEBSITE', 'MIXED_MEDIA_MULTI_DEST_CAROUSEL_WEBSITE', 'MIXED_MEDIA_SINGLE_DEST_CAROUSEL_APP', 'MIXED_MEDIA_SINGLE_DEST_CAROUSEL_WEBSITE', 'VIDEO_APP', 'VIDEO_CAROUSEL_APP', 'VIDEO_CAROUSEL_WEBSITE', 'VIDEO_MULTI_DEST_CAROUSEL_WEBSITE', 'VIDEO_WEBSITE']);
export const cardButtonLabel = z.enum(['BOOK', 'CONNECT', 'INSTALL', 'OPEN', 'ORDER', 'PLAY', 'SHOP']);
export const cardWebsite = z.string().url().max(8192).refine(value => { try { const url = new URL(value);return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, 'Use an HTTP or HTTPS destination without embedded credentials');
const appId = z.string().min(1).max(512);
const appDestination = z.object({ type: z.literal('APP'), country_code: z.string().regex(/^[A-Z]{2}$/), googleplay_app_id: appId.optional(), ios_app_store_identifier: appId.optional(), googleplay_deep_link: z.string().url().max(8192).optional(), ios_deep_link: z.string().url().max(8192).optional() }).strict()
  .refine(v => !!v.googleplay_app_id || !!v.ios_app_store_identifier, 'Provide at least one app store identifier')
  .refine(v => !v.googleplay_deep_link || !!v.googleplay_app_id, 'An Android deep link needs googleplay_app_id')
  .refine(v => !v.ios_deep_link || !!v.ios_app_store_identifier, 'An iOS deep link needs ios_app_store_identifier');
export const cardComponent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('MEDIA'), media_key: mediaKey }).strict(),
  z.object({ type: z.literal('SWIPEABLE_MEDIA'), media_keys: z.array(mediaKey).min(2).max(6) }).strict(),
  z.object({ type: z.literal('DETAILS'), title: z.string().min(1).max(10_000).describe('Native title length and content eligibility are validated by X only on apply.'), destination: z.object({ type: z.literal('WEBSITE'), url: cardWebsite }).strict() }).strict(),
  z.object({ type: z.literal('BUTTON'), label: z.object({ type: z.literal('ENUM'), value: cardButtonLabel }).strict(), destination: appDestination }).strict(),
]);
// Arrays avoid tuple prefixItems, which some MCP hosts cannot import.
export const cardComponents = z.array(cardComponent).length(2).refine(v => ['MEDIA', 'SWIPEABLE_MEDIA'].includes(v[0]!.type) && ['DETAILS', 'BUTTON'].includes(v[1]!.type), 'Use one media component followed by one website-details or app-button component');
export const cardSlides = z.array(cardComponents.refine(v => v[0]!.type === 'MEDIA' && v[1]!.type === 'DETAILS', 'Each multi-destination slide needs one MEDIA and one website DETAILS component')).min(2).max(6);
const layout = { components: cardComponents.optional(), slides: cardSlides.optional() };
export const createCard = z.object({ name: z.string().trim().min(1).max(80), ...layout }).strict().refine(v => !!v.components !== !!v.slides, 'Provide components or slides, never both');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const updateCard = z.object({ card_id: snowflake, expected_configuration_hash: hash, acknowledge_shared_creative_effects: z.literal(true), name: z.string().trim().min(1).max(80).optional(), ...layout,
  title: z.string().min(1).max(10_000).optional(), website_url: cardWebsite.optional(), button_label: cardButtonLabel.optional(), slide_index: z.number().int().min(0).max(5).optional(),
}).strict().refine(v => !(v.components && v.slides), 'Provide components or slides, never both')
  .refine(v => ['name', 'components', 'slides', 'title', 'website_url', 'button_label'].some(key => Object.hasOwn(v, key)), 'Provide card changes')
  .refine(v => !(v.components || v.slides) || !['title', 'website_url', 'button_label', 'slide_index'].some(key => Object.hasOwn(v, key)), 'Use a replacement layout or copy shortcuts, never both')
  .refine(v => v.slide_index === undefined || v.title !== undefined || v.website_url !== undefined || v.button_label !== undefined, 'A slide index requires a copy change');
export const deleteCard = z.object({ card_id: snowflake, expected_configuration_hash: hash, acknowledge_shared_creative_effects: z.literal(true) }).strict();
export const listCards = z.object({ account_id: xId, count: z.number().int().min(1).max(200).default(20), cursor: z.string().min(1).max(4096).optional(), card_types: z.array(cardTypes).min(1).max(13).optional(), card_ids: z.array(snowflake).min(1).max(200).optional(), card_uris: z.array(cardUri).min(1).max(200).optional(), q: z.string().min(1).max(80).optional(), include_legacy_cards: z.boolean().default(false), with_deleted: z.boolean().default(false), include_media: z.boolean().default(true) });
export const nativeCard = z.looseObject({ id: xId, card_uri: cardUri, name: z.string().nullish(), card_type: z.string(), deleted: z.boolean(), components: z.array(z.unknown()).max(100).nullish(), slides: z.array(z.array(z.unknown()).max(100)).max(100).nullish() });
export type NativeCard = z.infer<typeof nativeCard>;
export type CardLayout = { components?: z.infer<typeof cardComponents>; slides?: z.infer<typeof cardSlides> };
export const cardWrites = new Set(['x_create_card', 'x_update_card', 'x_delete_card']);
