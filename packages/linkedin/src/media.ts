import { createHash } from 'node:crypto';
import { AdportError, LocalMediaResolver, creativesOutput, defineTool, guardedWriteTool, mediaSourceFields, type AnyToolDefinition, type MediaResolver, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { LinkedInAdsClient } from './client.js';
import type { LinkedInAdsProvider } from './provider.js';
import { accountUrn, linkedinId } from './schemas.js';

type Plan = Omit<WritePreview, 'serverValidated'> & { execute: () => Promise<WriteResult> };
const videoUrn = z.string().regex(/^urn:li:video:[A-Za-z0-9_-]+$/), documentUrn = z.string().regex(/^urn:li:document:[A-Za-z0-9_-]+$/);
const name = z.string().trim().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.object(mediaSourceFields).refine(v => Boolean(v.media_id) !== Boolean(v.file_path), 'Choose project media_id or local file_path');
const uploadVideo = source.safeExtend({ name, owner_organization: z.string().regex(/^urn:li:organization:[1-9]\d*$/), campaign_id: linkedinId.optional() }), uploadDocument = source.safeExtend({ name });
const updateVideo = z.object({ video_id: videoUrn, expected_library_hash: hash, asset_name: name.optional(), library_status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }).strict().refine(v => v.asset_name !== undefined || v.library_status !== undefined, 'Provide video library changes');
const metadata = z.looseObject({ associatedAccount: accountUrn, assetName: z.string(), mediaLibraryStatus: z.enum(['ACTIVE', 'ARCHIVED']) });
const videoSchema = z.looseObject({ id: videoUrn, owner: z.string(), status: z.enum(['WAITING_UPLOAD', 'PROCESSING', 'PROCESSING_FAILED', 'AVAILABLE']), mediaLibraryMetadata: metadata.optional() });
const documentSchema = z.looseObject({ id: documentUrn, owner: z.string(), status: z.enum(['WAITING_UPLOAD', 'PROCESSING', 'PROCESSING_FAILED', 'AVAILABLE']) });
const aurn = (account: string) => `urn:li:sponsoredAccount:${linkedinId.parse(account)}`;
const kinds = { linkedin_upload_video: 'create', linkedin_upload_document: 'create', linkedin_update_video: 'update' } as const;
export const LINKEDIN_MEDIA_WRITES = new Set(Object.keys(kinds));
const snapshot = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const libraryHash = (value: z.infer<typeof videoSchema>) => snapshot({ id: value.id, owner: value.owner, status: value.status, associatedAccount: value.mediaLibraryMetadata?.associatedAccount, assetName: value.mediaLibraryMetadata?.assetName, mediaLibraryStatus: value.mediaLibraryMetadata?.mediaLibraryStatus });
const safeMediaUrl = (value: unknown) => { if (typeof value !== 'string') return undefined; try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'licdn.com' || u.hostname.endsWith('.licdn.com')) ? value : undefined; } catch { return undefined; } };

/** Native version-202608 Videos/Documents contracts reviewed 2026-11-04. */
export class LinkedInMediaService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider, private readonly media: MediaResolver = new LocalMediaResolver()) {}
  async context(account: string, campaignId?: string) {
    const current = await this.provider.getAccount(linkedinId.parse(account));
    const campaign = campaignId ? await this.provider.getCampaign(account, campaignId) : undefined, reference = campaign ? campaign.associatedEntity : current.reference;
    const organization = typeof reference === 'string' && /^urn:li:organization:[1-9]\d*$/.test(reference) ? reference : undefined;
    return { account_id: account, account_status: current.status, ...(campaignId ? { campaign_id: campaignId } : {}), ...(organization ? { video_owner: organization } : {}), document_owner: aurn(account), video_upload_available: Boolean(organization), note: 'Video uploads bind owner_organization to this account’s reference or the selected owned campaign’s associatedEntity and register in its media library. LinkedIn still checks Page ADMIN/DSC and rw_ads permissions at apply. No grant or Page access is inferred. PDF document uploads use the selected sponsored-account owner. Uploading does not create a post or ad.' };
  }
  private async page(account: string, start: number, count: number, status?: 'ACTIVE' | 'ARCHIVED') {
    const result = await this.client.get('videos', z.looseObject({ elements: z.array(videoSchema), paging: z.object({ start: z.number().int().nonnegative(), count: z.number().int().nonnegative(), total: z.number().int().nonnegative().optional(), links: z.array(z.looseObject({ rel: z.string() })).optional() }).optional() }), { q: 'associatedAccount', associatedAccount: aurn(account), ...(status ? { mediaLibraryStatus: status } : {}), start, count });
    if (result.elements.length > count || result.elements.some(v => v.mediaLibraryMetadata?.associatedAccount !== aurn(account) || status && v.mediaLibraryMetadata.mediaLibraryStatus !== status) || result.paging && result.paging.start !== start || new Set(result.elements.map(v => v.id)).size !== result.elements.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: video library account/status/pagination mismatch');
    const next = Boolean(result.paging?.links?.some(v => v.rel === 'next')) || (result.paging?.total !== undefined ? start + result.elements.length < result.paging.total : result.elements.length >= count);
    if (next && !result.elements.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: video library continuation did not advance');
    return { items: result.elements, next };
  }
  async libraryVideo(account: string, resource: string) {
    videoUrn.parse(resource); await this.provider.getAccount(linkedinId.parse(account));
    const seen = new Set<string>(); let start = 0;
    while (start < 5000) {
      const page = await this.page(account, start, 100);
      if (page.items.some(v => seen.has(v.id))) throw new AdportError('PROVIDER_ERROR', 'linkedin: video library repeated a resource');
      const found = page.items.find(v => v.id === resource);
      if (found) return { ...found, library_snapshot_hash: libraryHash(found) };
      if (!page.next) throw new AdportError('INVALID_INPUT', 'linkedin: video was not found in the selected account library');
      page.items.forEach(v => seen.add(v.id)); start += page.items.length;
    }
    throw new AdportError('PROVIDER_ERROR', 'linkedin: video membership is unconfirmed after 5,000 entries');
  }
  async videos(input: { account_id: string; start: number; count: number; library_status?: 'ACTIVE' | 'ARCHIVED' }) {
    const account = linkedinId.parse(input.account_id); await this.provider.getAccount(account);
    const result = await this.page(account, input.start, input.count, input.library_status);
    return { items: result.items.map(v => ({ ...v, library_snapshot_hash: libraryHash(v) })), truncated: result.next, ...(result.next ? { next_start: input.start + result.items.length } : {}), creatives: result.items.map(v => {
      const library = v.mediaLibraryMetadata!, video = v.status === 'AVAILABLE' ? safeMediaUrl(v.downloadUrl) : undefined, thumbnail = safeMediaUrl(v.thumbnail);
      return { id: v.id, provider: 'linkedin', account_id: account, name: library.assetName, type: 'VIDEO_ASSET', status: v.status, headlines: [], descriptions: [`Media library: ${library.mediaLibraryStatus}; processing: ${v.status}${typeof v.processingFailureReason === 'string' ? ` — ${v.processingFailureReason}` : ''}`], landing_urls: [], media: video ? [{ type: 'video', url: video }] : thumbnail ? [{ type: 'image', url: thumbnail }] : [], actions: [{ label: 'Edit video library entry', tool: 'linkedin_update_video', arguments: { account_id: account, video_id: v.id, expected_library_hash: libraryHash(v) }, fields: [{ key: 'asset_name', label: 'Name', type: 'text', value: library.assetName }, { key: 'library_status', label: 'Library status', type: 'select', value: library.mediaLibraryStatus, options: [{ label: 'Active in library', value: 'ACTIVE' }, { label: 'Archived in library', value: 'ARCHIVED' }] }] }] };
    }) };
  }
  async document(account: string, resource: string) {
    documentUrn.parse(resource); await this.provider.getAccount(linkedinId.parse(account));
    const value = await this.client.get(`documents/${encodeURIComponent(resource)}`, documentSchema);
    if (value.id !== resource || value.owner !== aurn(account)) throw new AdportError('INVALID_INPUT', 'linkedin: document is not owned by the selected sponsored account');
    return value;
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'linkedin' || !LINKEDIN_MEDIA_WRITES.has(op.tool) || op.kind !== kinds[op.tool as keyof typeof kinds]) throw new AdportError('INVALID_INPUT', 'linkedin: invalid media operation kind');
    const account = linkedinId.parse(op.accountId);
    if (op.tool === 'linkedin_update_video') {
      const input = updateVideo.parse(op.payload), current = await this.libraryVideo(account, input.video_id), library = current.mediaLibraryMetadata!;
      if (current.library_snapshot_hash !== input.expected_library_hash) throw new AdportError('PENDING_MISMATCH', 'linkedin: video processing or library metadata changed; read the video again');
      if (input.library_status && input.library_status !== library.mediaLibraryStatus && (input.library_status === 'ARCHIVED' ? !['AVAILABLE', 'PROCESSING_FAILED'].includes(current.status) : current.status !== 'AVAILABLE')) throw new AdportError('INVALID_INPUT', 'linkedin: native processing state does not permit this library archive transition');
      const fields = { ...(input.asset_name ? { assetName: input.asset_name } : {}), ...(input.library_status ? { mediaLibraryStatus: input.library_status } : {}) };
      return this.planResult(`Update LinkedIn video library ${input.video_id}`, [`${JSON.stringify(fields)}; source bytes, posts, ads and delivery statuses are preserved.`], async () => {
        await this.client.partialUpdate(`videos/${encodeURIComponent(input.video_id)}`, { mediaLibraryMetadata: { $set: fields } }, { associatedAccount: aurn(account) });
        try { const updated = (await this.libraryVideo(account, input.video_id)).mediaLibraryMetadata!; if (Object.entries(fields).some(([key, value]) => updated[key] !== value)) throw new Error('readback mismatch'); }
        catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: video library update acknowledged but readback not confirmed; reconcile before retrying', { resource_ids: [input.video_id] }); }
        return { applied: true, resourceIds: [input.video_id] };
      });
    }
    const isVideo = op.tool === 'linkedin_upload_video', videoInput = isVideo ? uploadVideo.parse(op.payload) : undefined, input = videoInput ?? uploadDocument.parse(op.payload), context = await this.context(account, videoInput?.campaign_id);
    if (isVideo && !context.video_owner) throw new AdportError('INVALID_INPUT', 'linkedin: this account has no native organization reference for video ownership; establish the correct advertiser/Page association before uploading');
    if (videoInput && context.video_owner !== videoInput.owner_organization) throw new AdportError('PENDING_MISMATCH', 'linkedin: requested organization does not match the current account/campaign reference; read media context again');
    const file = await this.media.read(input, { maxBytes: isVideo ? 500_000_000 : 100_000_000, contentTypes: isVideo ? ['video/mp4'] : ['application/pdf'] });
    if (isVideo && file.bytes.length < 75_000) throw new AdportError('INVALID_INPUT', 'linkedin: advertising videos must be at least 75 kB; duration and codec eligibility are checked during native processing');
    return this.planResult(`Upload LinkedIn ${isVideo ? 'video' : 'PDF document'} “${input.name}”`, [`+ ${file.contentType}; ${file.bytes.length} bytes; SHA-256 ${file.sha256}.`, `Owner ${isVideo ? context.video_owner : context.document_owner}${isVideo ? `; account library ${aurn(account)}` : ''}.`, 'Source bytes are immutable and rechecked at preview/apply. Native processing acceptance is separate from availability. No post, creative, campaign or delivery status is created or changed.', ...(isVideo ? ['No captions or custom thumbnail are attached by this upload. LinkedIn can generate a default thumbnail. Page ADMIN/DSC permissions are checked natively at apply.'] : ['PDF only in this workflow; LinkedIn validates document structure and its 300-page limit. Office formats remain a separate file-ingestion extension.'])], async () => {
      let resource: string | undefined, stage = 'initialize';
      try {
        if (isVideo) {
          const initialized = await this.client.action('videos', 'initializeUpload', { initializeUploadRequest: { owner: context.video_owner, fileSizeBytes: file.bytes.length, uploadCaptions: false, uploadThumbnail: false, mediaLibraryMetadata: { associatedAccount: aurn(account), assetName: input.name } } }, z.object({ value: z.object({ video: videoUrn, uploadToken: z.string(), uploadUrlsExpireAt: z.number().int().positive(), uploadInstructions: z.array(z.object({ firstByte: z.number().int().nonnegative(), lastByte: z.number().int().nonnegative(), uploadUrl: z.string().url() })).min(1).max(128) }) }));
          const value = initialized.value; resource = value.video; stage = 'validate upload instructions';
          let offset = 0;
          for (const part of value.uploadInstructions) { if (part.firstByte !== offset || part.lastByte < part.firstByte || part.lastByte >= file.bytes.length || part.lastByte - part.firstByte + 1 > 4 * 1024 * 1024) throw new Error('invalid native upload byte range'); this.client.validateMediaUpload(part.uploadUrl, 'video', resource); offset = part.lastByte + 1; }
          if (offset !== file.bytes.length || value.uploadUrlsExpireAt <= Date.now()) throw new Error('incomplete or expired upload instructions');
          const parts: string[] = []; stage = 'transfer video parts';
          for (const part of value.uploadInstructions) parts.push(await this.client.uploadMedia(part.uploadUrl, file.bytes.subarray(part.firstByte, part.lastByte + 1), 'video', resource));
          if (new Set(parts).size !== parts.length) throw new Error('repeated native part acknowledgement');
          stage = 'finalize video'; await this.client.finalizeVideo({ finalizeUploadRequest: { video: resource, uploadToken: value.uploadToken, uploadedPartIds: parts } });
        } else {
          const initialized = await this.client.action('documents', 'initializeUpload', { initializeUploadRequest: { owner: context.document_owner } }, z.object({ value: z.object({ document: documentUrn, uploadUrl: z.string().url(), uploadUrlExpiresAt: z.number().int().positive() }) }));
          resource = initialized.value.document; stage = 'transfer document';
          if (initialized.value.uploadUrlExpiresAt <= Date.now()) throw new Error('expired document upload URL');
          await this.client.uploadMedia(initialized.value.uploadUrl, file.bytes, 'document', resource);
        }
      } catch (error) { throw new AdportError('PROVIDER_ERROR', `linkedin: ${stage} was not confirmed. No mutation was retried. Reconcile the returned native ID before another upload.`, { resource_ids: resource ? [resource] : [], stage, ...(error instanceof AdportError ? { reason: error.message } : {}) }); }
      return { applied: true, resourceIds: [resource!], details: { status: 'UPLOAD_ACCEPTED', processing_complete: false, sha256: file.sha256, byte_length: file.bytes.length, next_tool: isVideo ? 'linkedin_get_library_video' : 'linkedin_get_document' } };
    });
  }
  private planResult(summary: string, changes: string[], execute: Plan['execute']): Plan { return { summary, changes, coercions: [], budgetDeltas: [], notes: ['Preview is local; LinkedIn has no server dry-run for media. Uploads can remain WAITING_UPLOAD/PROCESSING or fail native processing. No request is automatically retried.'], execute }; }
}

export function linkedinMediaTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  const account = { account_id: linkedinId };
  return [
    defineTool({ name: 'linkedin_media_context', namespace: 'linkedin', description: 'Read the account organization reference or an owned campaign’s associatedEntity for video ownership, plus the sponsored-account document owner. Pass video_owner as owner_organization on upload. Does not infer Page permissions or request new grants.', input: z.object({ ...account, campaign_id: linkedinId.optional() }), annotations: { readOnly: true }, handler: v => provider.media.context(v.account_id, v.campaign_id) }),
    defineTool({ name: 'linkedin_videos', namespace: 'linkedin', description: 'View account-library video readiness, actual native previews and bound name/archive actions. ACTIVE/ARCHIVED describe library visibility, not ad delivery. Continue next_start as start.', input: z.object({ ...account, library_status: z.enum(['ACTIVE', 'ARCHIVED']).optional(), start: z.number().int().nonnegative().default(0), count: z.number().int().min(1).max(100).default(20) }), output: creativesOutput.passthrough(), annotations: { readOnly: true }, presentation: 'creatives', pagination: { cursorInput: 'start', cursorOutput: 'next_start' }, handler: v => provider.media.videos(v) }),
    defineTool({ name: 'linkedin_get_library_video', namespace: 'linkedin', description: 'Resolve an exact video through the selected account’s media-library finder, including archived entries. Returns processing status and library_snapshot_hash; membership lookup is bounded to 5,000 entries.', input: z.object({ ...account, video_id: videoUrn }), annotations: { readOnly: true }, handler: v => provider.media.libraryVideo(v.account_id, v.video_id) }),
    defineTool({ name: 'linkedin_get_document', namespace: 'linkedin', description: 'Read a PDF document’s native processing status and expiring download URL, requiring its owner to match the selected sponsored account. Organization/member-owned documents need their own access workflow.', input: z.object({ ...account, document_id: documentUrn }), annotations: { readOnly: true }, handler: v => provider.media.document(v.account_id, v.document_id) }),
    guardedWriteTool({ name: 'linkedin_upload_video', namespace: 'linkedin', provider: 'linkedin', kind: 'create', destructive: false, description: 'Upload checksum-bound MP4 parts and finalize in the account’s video library. owner_organization must match media context; optional campaign_id selects its owned associatedEntity. Native Page ADMIN/DSC permission required. No post/ad is created. Processing readiness is a separate read; hosted uploads use media_id.', payload: uploadVideo }),
    guardedWriteTool({ name: 'linkedin_upload_document', namespace: 'linkedin', provider: 'linkedin', kind: 'create', destructive: false, description: 'Upload a checksum-bound PDF owned by the selected sponsored account. No post or ad is published; native processing and the 300-page limit are checked separately. Hosted uploads use media_id. Office formats are not accepted by this tool.', payload: uploadDocument }),
    guardedWriteTool({ name: 'linkedin_update_video', namespace: 'linkedin', provider: 'linkedin', kind: 'update', description: 'Rename or archive/unarchive an account-library video with expected_library_hash. Native processing transitions are checked; bytes, posts and ad delivery remain unchanged. Readback verifies the metadata update.', payload: updateVideo }),
  ];
}
