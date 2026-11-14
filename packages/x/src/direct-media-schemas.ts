import { z } from 'zod';
import { mediaCreativeSchema, xId } from './schemas.js';

export const accountMediaTypes = ['BANNER', 'BANNER_TABLET', 'INTERSTITIAL', 'INTERSTITIAL_LANDSCAPE', 'INTERSTITIAL_LANDSCAPE_TABLET', 'INTERSTITIAL_TABLET', 'MEDIUM_RECTANGLE', 'PREROLL', 'VAST_PREROLL'] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const page = { count: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(4096).optional(), with_deleted: z.boolean().default(false) };
export const accountMediaList = z.object({ account_id: xId, ...page, creative_types: z.array(z.enum(accountMediaTypes)).min(1).max(accountMediaTypes.length).refine(values => new Set(values).size === values.length, 'Use unique creative types').optional() }).strict();
export const directMediaList = z.object({ account_id: xId, line_item_id: xId, ...page, include_media: z.boolean().default(true) }).strict();
export const nativeAccountMedia = z.looseObject({ id: xId, creative_type: z.string(), video_id: z.string().nullable().optional(), media_url: z.string().nullable().optional(), deleted: z.boolean(), account_id: xId.optional() });
export const nativeDirectMedia = mediaCreativeSchema.extend({ creative_type: z.string(), landing_url: z.string().nullable().optional(), approval_status: z.string().optional(), account_id: xId.optional() });
const destination = z.string().url().max(4096).refine(value => { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }, 'Use an HTTP(S) destination without embedded credentials');
export const directMediaSelection = z.object({ line_item_id: xId, account_media_id: xId, landing_url: destination.optional() }).strict();
export const createDirectMedia = directMediaSelection.extend({ expected_context_hash: hash, acknowledge_active_association: z.literal(true) }).strict();
export const deleteDirectMedia = z.object({ media_creative_id: xId, expected_context_hash: hash }).strict();
export const directMediaWrites = new Set(['x_create_media_creative', 'x_delete_media_creative']);
