import { z } from 'zod';
import { snowflake } from './creative-tools.js';
import { promotedAccountSchema, xId } from './schemas.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const nativePromotedAccount = promotedAccountSchema.extend({ user_id: snowflake, account_id: xId.optional(), approval_status: z.string().optional() });
export const promotedAccountList = z.object({ account_id: xId, line_item_id: xId, count: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(4096).optional(), with_deleted: z.boolean().default(false) }).strict();
export const promotedAccountSelection = z.object({ line_item_id: xId, user_id: snowflake }).strict();
export const createPromotedAccount = promotedAccountSelection.extend({ expected_context_hash: hash, acknowledge_active_association: z.literal(true), acknowledge_live_profile: z.literal(true) }).strict();
export const deletePromotedAccount = z.object({ promoted_account_id: xId, expected_context_hash: hash }).strict();
export const promotedAccountWrites = new Set(['x_create_promoted_account', 'x_delete_promoted_account']);
