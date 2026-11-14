import { z } from 'zod';
import { xId } from './schemas.js';

export const accountMediaIdentity = z.object({ account_id: xId, account_media_id: xId }).strict();
export const accountMediaUsage = accountMediaIdentity.extend({ reference_offset: z.number().int().min(0).max(9999).default(0), reference_limit: z.number().int().min(1).max(100).default(50), expected_context_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(input => input.reference_offset === 0 || input.expected_context_hash !== undefined, 'Later reference pages require the original context hash');
export const deleteAccountMedia = z.object({ account_media_id: xId, expected_context_hash: z.string().regex(/^[a-f0-9]{64}$/), acknowledge_source_deletion: z.literal(true) }).strict();
