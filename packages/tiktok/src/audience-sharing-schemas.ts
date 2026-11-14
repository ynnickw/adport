import { z } from 'zod';
import { audienceId } from './custom-audience-schemas.js';

const selectedIds = z.array(audienceId).min(1).max(10).refine(values => new Set(values).size === values.length, 'Use unique IDs');
export const sharingSelection = z.object({ custom_audience_ids: selectedIds, shared_advertiser_ids: selectedIds }).strict();
export const audienceSharesRead = sharingSelection.safeExtend({ account_id: audienceId });
export const audienceSharingContext = audienceSharesRead.safeExtend({ bc_id: audienceId, action: z.enum(['SHARE', 'UNSHARE']).default('SHARE') }).refine(value => value.action !== 'UNSHARE' || value.custom_audience_ids.length === 1 && value.shared_advertiser_ids.length === 1, 'Cancellation selects one audience/recipient pair');
export const shareAudiences = sharingSelection.safeExtend({ bc_id: audienceId, expected_context_hash: z.string().regex(/^[a-f0-9]{64}$/), acknowledge_recipient_access: z.literal(true) });
export const unshareAudience = z.object({ bc_id: audienceId, custom_audience_id: audienceId, shared_advertiser_id: audienceId, expected_context_hash: z.string().regex(/^[a-f0-9]{64}$/), acknowledge_shared_effects: z.literal(true) }).strict();
export const audienceSharingWrites = new Set(['tiktok_share_custom_audiences', 'tiktok_unshare_custom_audience']);
