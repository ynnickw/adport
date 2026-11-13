import { AdportError, LocalMediaResolver, type MediaResolver, type WriteOperation, type WritePreview, type WriteResult, type WriteReview } from '@adport/core';
import { z } from 'zod';
import { mediaKey, snowflake } from './creative-tools.js';
import { registerMedia, uploadMedia } from './media-tools.js';
import type { XAdsProvider } from './provider.js';
import { xId } from './schemas.js';

interface MediaPlan extends Omit<WritePreview, 'serverValidated'> { execute(): Promise<WriteResult> }
const nativeId = snowflake.refine(v => v.length <= 19, 'Native media v2 ID exceeds 19 digits');
const processing = z.looseObject({ state: z.enum(['pending', 'in_progress', 'succeeded', 'failed']), check_after_secs: z.number().int().nonnegative().optional(), progress_percent: z.number().min(0).max(100).optional() });
const nativeMedia = z.looseObject({ id: nativeId, media_key: mediaKey.optional(), expires_after_secs: z.number().int().positive().optional(), size: z.number().int().nonnegative().safe().optional(), processing_info: processing.optional() });
const receiptSchema = z.object({ kind: z.literal('media_upload_v1'), account_id: xId, user_id: nativeId, media_id: nativeId, media_key: mediaKey.optional(), media_type: z.enum(['IMAGE', 'GIF', 'VIDEO']), sha256: z.string().regex(/^[a-f0-9]{64}$/), byte_length: z.number().int().positive().max(50 * 1024 * 1024), finalized: z.boolean(), expires_at: z.number().int().positive().safe() });
type Receipt = z.infer<typeof receiptSchema>;

export class XMediaService {
  constructor(private readonly provider: XAdsProvider, private readonly media: MediaResolver = new LocalMediaResolver()) {}
  private receipt(account: string, value: string) {
    const parsed = receiptSchema.safeParse(this.provider.client.verifyResourceReceipt(value)), now = Math.floor(Date.now() / 1000);
    if (!parsed.success || parsed.data.account_id !== xId.parse(account) || parsed.data.expires_at <= now || parsed.data.expires_at > now + 86_400 || (parsed.data.media_key && parsed.data.media_key.split('_')[1] !== parsed.data.media_id)) throw new AdportError('INVALID_INPUT', 'x: expired or mismatched account upload receipt');
    return parsed.data;
  }
  private async author(account: string, user: string, write: boolean) {
    if (!(await this.provider.creatives.users(account)).some(v => v.user_id === user && v.promotable_user_type === 'FULL' && !v.deleted)) throw new AdportError('INVALID_INPUT', 'x: upload author is not a current FULL promotable account user');
    if (write) { const access = await this.provider.creatives.access(account); if (access.user_id !== user && !access.permissions.includes('TWEET_COMPOSER')) throw new AdportError('INVALID_INPUT', 'x: upload author needs native composer access'); }
  }
  private checked(value: z.infer<typeof nativeMedia>, bound: Receipt) {
    if (value.id !== bound.media_id || (value.media_key && value.media_key.split('_')[1] !== value.id) || (bound.media_key && value.media_key && bound.media_key !== value.media_key) || (value.size !== undefined && value.size !== bound.byte_length)) throw new AdportError('PROVIDER_ERROR', 'x: upload processing ID/key/size mismatch');
    const updated = { ...bound, ...(value.media_key ? { media_key: value.media_key } : {}), ...(value.expires_after_secs ? { expires_at: Math.min(bound.expires_at, Math.floor(Date.now() / 1000) + value.expires_after_secs) } : {}) };
    return { native: value, bound: updated, state: value.processing_info?.state ?? 'succeeded', resource_receipt: this.provider.client.resourceReceipt(updated) };
  }
  private async nativeStatus(bound: Receipt) {
    const { data } = await this.provider.client.mediaRequest('GET', 'media/upload', z.object({ data: nativeMedia }), { media_id: bound.media_id, command: 'STATUS' });
    return this.checked(data, bound);
  }
  async status(account: string, value: string) {
    const bound = this.receipt(account, value); await this.author(account, bound.user_id, false);
    return this.nativeStatus(bound);
  }
  async plan(op: WriteOperation): Promise<MediaPlan> {
    const account = xId.parse(op.accountId);
    if (op.provider !== 'x' || op.kind !== 'create') throw new AdportError('INVALID_INPUT', 'x: media provider/kind mismatch');
    const plan = (summary: string, changes: string[], execute: () => Promise<WriteResult>, review: WriteReview): MediaPlan => ({ summary, changes, execute, review, coercions: [], budgetDeltas: [] });
    if (op.tool === 'x_upload_media') {
      const input = uploadMedia.parse(op.payload); nativeId.parse(input.as_user_id); await this.author(account, input.as_user_id, true);
      const file = await this.media.read(input, { maxBytes: 50 * 1024 * 1024, contentTypes: ['image/png', 'image/jpeg', 'image/gif', 'video/mp4'] }), kind = file.contentType === 'image/gif' ? 'GIF' : file.contentType.startsWith('image/') ? 'IMAGE' : 'VIDEO';
      if (file.bytes.byteLength > (kind === 'IMAGE' ? 5 : kind === 'GIF' ? 15 : 50) * 1024 * 1024) throw new AdportError('INVALID_INPUT', 'x: media exceeds the image5MiB/GIF15MiB/video50MiB application limit');
      const category = kind === 'IMAGE' ? 'tweet_image' : kind === 'GIF' ? 'tweet_gif' : 'amplify_video';
      return plan('Upload X native media bytes', [`${file.name}; ${file.contentType}; ${file.bytes.byteLength} bytes; SHA-256 ${file.sha256}. Author ${input.as_user_id}, category ${category}.`, 'Initialize, append 1MiB JSON/base64 chunks and finalize. Upload processing and library registration are separate. No post or ad is created; incomplete native uploads may remain until provider expiry.'], async () => {
        const init = (await this.provider.client.mediaRequest('POST', 'media/upload/initialize', z.object({ data: nativeMedia }), {}, { additional_owners: [input.as_user_id], media_category: category, media_type: file.contentType, total_bytes: file.bytes.byteLength })).data;
        let bound: Receipt = { kind: 'media_upload_v1', account_id: account, user_id: input.as_user_id, media_id: init.id, ...(init.media_key ? { media_key: init.media_key } : {}), media_type: kind, sha256: file.sha256, byte_length: file.bytes.byteLength, finalized: false, expires_at: Math.floor(Date.now() / 1000) + Math.min(init.expires_after_secs ?? 3600, 86_400) };
        try {
          this.checked(init, bound);
          for (let offset = 0, segment = 0; offset < file.bytes.byteLength; offset += 1024 * 1024, segment++) await this.provider.client.mediaRequest('POST', `media/upload/${init.id}/append`, z.object({ data: z.object({ expires_at: z.number().int().positive().safe().optional() }).optional() }), {}, { segment_index: segment, media: Buffer.from(file.bytes.subarray(offset, offset + 1024 * 1024)).toString('base64') });
          const final = (await this.provider.client.mediaRequest('POST', `media/upload/${init.id}/finalize`, z.object({ data: nativeMedia }))).data;
          const result = this.checked(final, { ...bound, finalized: true }); bound = result.bound;
          if (result.state === 'failed') throw new Error('x: native media processing failed');
          return { applied: true, resourceIds: [bound.media_key ?? bound.media_id], details: { upload_id: bound.media_id, ...(bound.media_key ? { media_key: bound.media_key } : {}), status: result.state, resource_receipt: result.resource_receipt, expires_at: new Date(bound.expires_at * 1000).toISOString(), next_tool: result.state === 'succeeded' ? 'x_register_uploaded_media' : 'x_media_upload_status', note: 'Upload finalized; this does not register a library entry, publish a post or prove ad eligibility.' } };
        } catch (error) { throw new AdportError('PROVIDER_ERROR', error instanceof Error ? error.message : 'x: upload failed; reconcile before retrying', { resource_ids: [bound.media_key ?? bound.media_id], resource_receipt: this.provider.client.resourceReceipt(bound), note: 'Upload was not replayed. Native incomplete bytes may remain until provider expiry.' }); }
      }, { provider: 'x', accountId: account, kind: 'create', title: `Upload ${kind.toLowerCase()}`, subject: file.name, fields: [{ label: 'Type', after: file.contentType }, { label: 'Size', after: `${file.bytes.byteLength.toLocaleString('en-US')} bytes` }, { label: 'Author', after: input.as_user_id }, { label: 'SHA-256', after: file.sha256 }], notices: ['X validates on apply. An incomplete upload may remain until it expires.', 'Publishing and library registration are separate actions.'] });
    }
    if (op.tool !== 'x_register_uploaded_media') throw new AdportError('INVALID_INPUT', 'x: unsupported media operation');
    const input = registerMedia.parse(op.payload), bound = this.receipt(account, input.resource_receipt); await this.author(account, bound.user_id, true);
    if (!bound.finalized) throw new AdportError('INVALID_INPUT', 'x: incomplete upload cannot be registered; create a new approved upload after reconciling the incomplete session');
    const status = await this.nativeStatus(bound), key = status.bound.media_key;
    if (status.state !== 'succeeded' || !key) throw new AdportError('INVALID_INPUT', 'x: upload is not processed or has no native media key; check x_media_upload_status');
    if (bound.media_type === 'IMAGE' && (input.title !== undefined || input.description !== undefined)) throw new AdportError('INVALID_INPUT', 'x: title/description require video or GIF media');
    try { const existing = await this.provider.creatives.media(account, key); if (!existing.deleted) throw new AdportError('INVALID_INPUT', 'x: media is already registered in this account'); }
    catch (error) { if (!(error instanceof AdportError) || !error.details || typeof error.details !== 'object' || !('http_status' in error.details) || error.details.http_status !== 404) throw error; }
    const fields = { media_key: key, name: input.name, ...(input.file_name !== undefined ? { file_name: input.file_name } : {}), ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}) };
    return plan(`Register X upload ${key}`, [`Associate this approved ${bound.media_type} upload with account ${account}; SHA-256 ${bound.sha256}. ${JSON.stringify(fields)}`, 'No post publication or ad association. Native library and processing eligibility remain separate from campaign approval.'], async () => {
      try {
        const { data } = await this.provider.client.request('POST', `accounts/${account}/media_library`, z.object({ data: z.looseObject({ media_key: mediaKey }) }), fields);
        if (data.media_key !== key) throw new Error('x: registered media key mismatch');
        const observed = await this.provider.creatives.media(account, key);
        if (observed.deleted || observed.media_type !== bound.media_type || Object.entries(fields).some(([field, value]) => observed[field] !== value)) throw new Error('x: registered media metadata readback mismatch');
        return { applied: true, resourceIds: [key], details: { status: observed.media_status, next_tool: 'x_get_media_library_item' } };
      } catch (error) { throw new AdportError('PROVIDER_ERROR', error instanceof Error ? error.message : 'x: library registration failed; reconcile before retrying', { resource_ids: [key], resource_receipt: input.resource_receipt }); }
    }, { provider: 'x', accountId: account, kind: 'create', title: 'Add media to X library', subject: input.name, fields: [{ label: 'Media', after: key }, ...(input.file_name === undefined ? [] : [{ label: 'File name', after: input.file_name }]), ...(input.title === undefined ? [] : [{ label: 'Title', after: input.title }]), ...(input.description === undefined ? [] : [{ label: 'Description', after: input.description }]), { label: 'SHA-256', after: bound.sha256 }], notices: ['Adds the approved upload to this account’s media library. Publishing is a separate action.'] });
  }
}
