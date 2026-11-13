import { defineTool, guardedWriteTool, mediaSourceFields, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { XAdsProvider } from './provider.js';
import { snowflake } from './creative-tools.js';
import { xId } from './schemas.js';

export const mediaReceipt = z.string().min(1).max(2048);
export const uploadMedia = z.object({ as_user_id: snowflake, ...mediaSourceFields }).refine(v => Boolean(v.media_id) !== Boolean(v.file_path), 'Choose project media_id or local file_path');
export const registerMedia = z.object({ resource_receipt: mediaReceipt, name: z.string().min(1).max(100), file_name: z.string().min(1).max(255).optional(), title: z.string().max(70).optional(), description: z.string().max(200).optional() });
export function xMediaTools(provider: XAdsProvider): AnyToolDefinition[] {
  return [
    guardedWriteTool({ name: 'x_upload_media', namespace: 'x', provider: 'x', kind: 'create', description: 'Upload SHA-256-bound image/GIF/video bytes through native v2 initialize/append/finalize with the existing OAuth1 grant. Returns a signed account/author-bound processing receipt; does not register, publish or attach an ad.', payload: uploadMedia }),
    defineTool({ name: 'x_media_upload_status', namespace: 'x', description: 'Read native upload processing only with the signed receipt from this account’s approved upload. Native IDs alone do not authorize account-less status reads.', input: z.object({ account_id: xId, resource_receipt: mediaReceipt }), annotations: { readOnly: true }, handler: v => provider.mediaUploads.status(v.account_id, v.resource_receipt) }),
    guardedWriteTool({ name: 'x_register_uploaded_media', namespace: 'x', provider: 'x', kind: 'create', description: 'Register an approved, processed upload in its account’s native media library. Requires its unexpired signed receipt, checks current author/processing, and preserves upload IDs on a partial failure. No post publication or ad association.', payload: registerMedia }),
  ];
}
