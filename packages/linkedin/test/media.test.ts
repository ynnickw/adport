import { createHash } from 'node:crypto';
import { createContext, DEFAULT_POLICY, PolicyEngine, verifyMedia, type MediaResolver, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it, vi } from 'vitest';
import { LinkedInAdsClient } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';

// Official version-202608 Videos/Documents contracts retrieved 2026-11-04.
// Inclusive part bounds, ETags, empty finalize response, finder encoding and
// nested mediaLibraryMetadata patches are asserted on the outgoing wire.
const A = '123456', owner = 'urn:li:organization:42', account = `urn:li:sponsoredAccount:${A}`, V = 'urn:li:video:QA_video', D = 'urn:li:document:QA_document';
const guard = { forcePausedCreation: true }, pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
type Row = Record<string, any>;
function fixture() {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 80_000); bytes.write('ftypisom', 4);
  const state: Row = { account: { id: Number(A), name: 'Fixture', currency: 'USD', status: 'DRAFT', reference: owner }, videos: [{ id: V, owner, status: 'AVAILABLE', downloadUrl: 'https://dms.licdn.com/fixture.mp4?expires=1', mediaLibraryMetadata: { associatedAccount: account, assetName: 'Fixture video', mediaLibraryStatus: 'ACTIVE' } }], document: { id: D, owner: account, status: 'PROCESSING' }, parts: [{ firstByte: 0, lastByte: 4194303, uploadUrl: 'https://www.linkedin.com/dms-uploads/QA_video/uploadedVideo?part=1' }, { firstByte: 4194304, lastByte: bytes.length - 1, uploadUrl: 'https://www.linkedin.com/dms-uploads/QA_video/uploadedVideo?part=2' }], uploads: 0 };
  const calls: { url: URL; init: RequestInit; body?: Row }[] = []; let override: ((call: typeof calls[number]) => Response | undefined) | undefined;
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined, call = { url, init, body }; calls.push(call);
    const replaced = override?.(call); if (replaced) return replaced;
    if (url.hostname === 'www.linkedin.com') return new Response(null, { status: url.pathname.includes('uploadedVideo') ? 200 : 201, headers: { etag: `"part-${++state.uploads}"` } });
    if (url.pathname === `/rest/adAccounts/${A}`) return Response.json(state.account);
    if (url.searchParams.get('action') === 'initializeUpload') return Response.json({ value: url.pathname.endsWith('videos') ? { video: V, uploadToken: '', uploadUrlsExpireAt: Date.now() + 60_000, uploadInstructions: state.parts } : { document: D, uploadUrl: 'https://www.linkedin.com/dms-uploads/opaque-upload-id/uploaded-document/0?capability=fixture', uploadUrlExpiresAt: Date.now() + 60_000 } });
    if (url.searchParams.get('action') === 'finalizeUpload') return new Response(null, { status: 200 });
    if (init.method === 'POST') { Object.assign(state.videos[0].mediaLibraryMetadata, body!.patch.mediaLibraryMetadata.$set); return new Response(null, { status: 204 }); }
    if (url.pathname === '/rest/videos') return Response.json({ elements: state.videos, paging: { start: Number(url.searchParams.get('start') ?? 0), count: 100, total: state.videos.length } });
    if (url.pathname.startsWith('/rest/documents/')) return Response.json(state.document);
    throw new Error('Unhandled fixture request');
  });
  const media: MediaResolver = { read: vi.fn(async (source, options) => verifyMedia(source.file_path?.endsWith('.pdf') ? pdf : bytes, source.file_path ?? 'fixture.mp4', source.expected_sha256, options)) };
  const provider = new LinkedInAdsProvider(new LinkedInAdsClient({ accessToken: 'fixture-token' }, fetcher as typeof fetch), media);
  const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ provider: 'linkedin', tool, accountId: A, kind, payload });
  const upload = (kind: 'video' | 'document') => op(`linkedin_upload_${kind}`, { name: 'Private fixture', ...(kind === 'video' ? { owner_organization: owner } : {}), file_path: kind === 'video' ? '/fixture.mp4' : '/fixture.pdf', expected_sha256: createHash('sha256').update(kind === 'video' ? bytes : pdf).digest('hex') });
  return { provider, state, calls, bytes, op, upload, override(fn: typeof override) { override = fn; } };
}
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c.init.method !== 'GET');

describe('LinkedIn multipart video and PDF media', () => {
  it('previews without initializing uploads, then transfers exact inclusive ranges and ordered ETags before finalizing', async () => {
    const f = fixture(), op = f.upload('video');
    expect(await f.provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false }); expect(mutations(f)).toHaveLength(0);
    expect(await f.provider.applyWrite(op, guard)).toMatchObject({ applied: true, resourceIds: [V], details: { status: 'UPLOAD_ACCEPTED', processing_complete: false, next_tool: 'linkedin_get_library_video' } });
    const writes = mutations(f); expect(writes).toHaveLength(4);
    expect(writes[0]!.body).toEqual({ initializeUploadRequest: { owner, fileSizeBytes: f.bytes.length, uploadCaptions: false, uploadThumbnail: false, mediaLibraryMetadata: { associatedAccount: account, assetName: 'Private fixture' } } });
    expect(writes[0]!.init.headers).toMatchObject({ 'Linkedin-Version': '202608', 'X-Restli-Protocol-Version': '2.0.0' });
    expect(Buffer.from(writes[1]!.init.body as Uint8Array).equals(f.bytes.subarray(0, 4194304))).toBe(true); expect(Buffer.from(writes[2]!.init.body as Uint8Array).equals(f.bytes.subarray(4194304))).toBe(true);
    expect(writes[1]!.init.headers).not.toHaveProperty('authorization'); expect(writes[1]!.init.redirect).toBe('error');
    expect(writes[3]!.body).toEqual({ finalizeUploadRequest: { video: V, uploadToken: '', uploadedPartIds: ['part-1', 'part-2'] } });
  });
  it.each(['gap', 'overlap', 'foreign-url', 'wrong-id', 'oversize-part'] as const)('rejects %s before sending any bytes and retains initialized video ID', async reason => {
    const f = fixture();
    if (reason === 'gap') f.state.parts[1].firstByte++;
    if (reason === 'overlap') f.state.parts[1].firstByte--;
    if (reason === 'foreign-url') f.state.parts[1].uploadUrl = 'https://attacker.example/upload';
    if (reason === 'wrong-id') f.state.parts[0].uploadUrl = 'https://www.linkedin.com/dms-uploads/foreign/uploadedVideo';
    if (reason === 'oversize-part') f.state.parts = [{ ...f.state.parts[0], lastByte: f.bytes.length - 1 }];
    await expect(f.provider.applyWrite(f.upload('video'), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: [V], stage: 'validate upload instructions' } });
    expect(mutations(f)).toHaveLength(1);
  });
  it('sends only remaining source bytes when the final native part cap extends beyond EOF', async () => {
    const f = fixture(); f.state.parts[1].lastByte = 8 * 1024 * 1024 - 1;
    await f.provider.applyWrite(f.upload('video'), guard);
    const transferred = f.calls.filter(c => c.url.hostname === 'www.linkedin.com').map(c => Buffer.from(c.init.body as Uint8Array));
    expect(transferred.map(v => v.length)).toEqual([4194304, 80000]);
    expect(Buffer.concat(transferred).equals(f.bytes)).toBe(true);
  });
  it.each(['', '""', 'duplicate', 'failure'] as const)('does not finalize or replay after a missing/invalid part acknowledgement: %s', async etag => {
    const f = fixture(); f.override(c => c.url.hostname === 'www.linkedin.com' ? new Response(null, { status: etag === 'failure' ? 500 : 200, headers: { etag: etag === 'duplicate' ? 'same' : etag } }) : undefined);
    await expect(f.provider.applyWrite(f.upload('video'), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: [V] } });
    expect(f.calls.some(c => c.url.searchParams.get('action') === 'finalizeUpload')).toBe(false);
    expect(f.calls.filter(c => c.url.searchParams.get('action') === 'initializeUpload')).toHaveLength(1);
  });
  it('does not invent video ownership when the account lacks an organization reference', async () => {
    const f = fixture(); delete f.state.account.reference;
    expect(await f.provider.media.context(A)).toMatchObject({ video_upload_available: false, document_owner: account });
    await expect(f.provider.previewWrite(f.upload('video'), guard)).rejects.toThrow('organization reference'); expect(mutations(f)).toHaveLength(0);
  });
  it('binds organization ownership across previews and permits an owned campaign’s distinct associated Page', async () => {
    const f = fixture(), op = f.upload('video'); f.state.account.reference = 'urn:li:organization:99';
    await expect(f.provider.previewWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    f.override(c => c.url.pathname.endsWith('/adCampaigns/7') ? Response.json({ id: 7, name: 'Fixture campaign', account, status: 'PAUSED', type: 'SPONSORED_UPDATES', associatedEntity: owner }) : undefined);
    op.payload = { ...op.payload as object, campaign_id: '7' };
    expect(await f.provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false }); expect(mutations(f)).toHaveLength(0);
  });
  it('preserves a native permission rejection and never replays initialization', async () => {
    const f = fixture(); f.override(c => c.url.searchParams.get('action') === 'initializeUpload' ? Response.json({}, { status: 403 }) : undefined);
    await expect(f.provider.applyWrite(f.upload('video'), guard)).rejects.toMatchObject({ details: { stage: 'initialize', resource_ids: [], reason: expect.stringContaining('HTTP 403') } });
    expect(mutations(f)).toHaveLength(1);
  });
  it('uploads a PDF with account ownership and auth only to the validated native destination', async () => {
    const f = fixture(), op = f.upload('document'); await f.provider.previewWrite(op, guard); expect(mutations(f)).toHaveLength(0);
    expect(await f.provider.applyWrite(op, guard)).toMatchObject({ applied: true, resourceIds: [D], details: { processing_complete: false } });
    const writes = mutations(f); expect(writes).toHaveLength(2); expect(writes[0]!.body).toEqual({ initializeUploadRequest: { owner: account } });
    expect(writes[1]!.init).toMatchObject({ method: 'PUT', headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/octet-stream' }, body: pdf, redirect: 'error' });
    expect(await f.provider.media.document(A, D)).toMatchObject({ id: D, status: 'PROCESSING' });
    f.state.document.owner = 'urn:li:sponsoredAccount:999'; await expect(f.provider.media.document(A, D)).rejects.toThrow('selected sponsored account');
  });
  it('rejects an unsafe document upload URL without leaking auth or replaying initialization', async () => {
    const f = fixture(); f.override(c => c.url.searchParams.get('action') === 'initializeUpload' ? Response.json({ value: { document: D, uploadUrl: 'https://attacker.example/dms-uploads/QA_document/ads-uploadedDocument/0', uploadUrlExpiresAt: Date.now() + 60_000 } }) : undefined);
    await expect(f.provider.applyWrite(f.upload('document'), guard)).rejects.toMatchObject({ details: { resource_ids: [D] } }); expect(mutations(f)).toHaveLength(1);
  });
  it('encodes the video finder’s scalar status and exposes actual account-owned video actions', async () => {
    const f = fixture(), result = await f.provider.media.videos({ account_id: A, library_status: 'ACTIVE', start: 0, count: 20 });
    const request = f.calls.find(c => c.url.pathname === '/rest/videos')!;
    expect(request.url.searchParams.get('associatedAccount')).toBe(account); expect(request.url.searchParams.get('mediaLibraryStatus')).toBe('ACTIVE');
    expect(result.creatives[0]).toMatchObject({ media: [{ type: 'video', url: f.state.videos[0].downloadUrl }], actions: [{ arguments: { account_id: A, video_id: V, expected_library_hash: expect.stringMatching(/^[a-f0-9]{64}$/) } }] });
    f.state.videos[0].mediaLibraryMetadata.associatedAccount = 'urn:li:sponsoredAccount:999'; await expect(f.provider.media.videos({ account_id: A, start: 0, count: 20 })).rejects.toThrow('mismatch');
  });
  it('binds edits to library metadata rather than expiring URLs, uses nested patches and verifies readback', async () => {
    const f = fixture(), before = await f.provider.media.libraryVideo(A, V); f.state.videos[0].downloadUrl += '&rotated=1';
    const op = f.op('linkedin_update_video', { video_id: V, expected_library_hash: before.library_snapshot_hash, asset_name: 'Renamed', library_status: 'ARCHIVED' }, 'update');
    await f.provider.applyWrite(op, guard);
    const write = mutations(f)[0]!; expect(write.url.searchParams.get('associatedAccount')).toBe(account); expect(write.init.headers).toMatchObject({ 'X-RestLi-Method': 'PARTIAL_UPDATE' });
    expect(write.body).toEqual({ patch: { mediaLibraryMetadata: { $set: { assetName: 'Renamed', mediaLibraryStatus: 'ARCHIVED' } } } });
    await expect(f.provider.previewWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    f.state.videos[0].status = 'PROCESSING'; const current = await f.provider.media.libraryVideo(A, V);
    await expect(f.provider.previewWrite(f.op('linkedin_update_video', { video_id: V, expected_library_hash: current.library_snapshot_hash, library_status: 'ACTIVE' }, 'update'), guard)).rejects.toThrow('processing state');
  });
  it('rejects repeated finder pages and unconfirmed metadata readback without replaying the write', async () => {
    const f = fixture(); f.override(c => c.url.pathname === '/rest/videos' ? Response.json({ elements: f.state.videos, paging: { start: Number(c.url.searchParams.get('start')), count: 100, links: [{ rel: 'next' }] } }) : undefined);
    await expect(f.provider.media.libraryVideo(A, 'urn:li:video:missing')).rejects.toThrow('repeated');
    const before = await f.provider.media.libraryVideo(A, V);
    f.override(c => c.init.method === 'POST' ? new Response(null, { status: 204 }) : undefined);
    await expect(f.provider.applyWrite(f.op('linkedin_update_video', { video_id: V, expected_library_hash: before.library_snapshot_hash, asset_name: 'Unconfirmed' }, 'update'), guard)).rejects.toMatchObject({ details: { resource_ids: [V] } });
    expect(mutations(f)).toHaveLength(1);
  });
  it('keeps every upload behind exact-argument, protected-account and one-use pending checks', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>(), engine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, { async sweep() {}, async put(v) { pending.set(v.id, v); }, async get(id) { return pending.get(id); }, async delete(id) { pending.delete(id); }, async consume(id: string, expectedHash: string) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } }, { async append() {} });
    const runtime = await createContext({ engine, providerModules: [{ provider: f.provider, tools: linkedinTools(f.provider) }] });
    await expect(runtime.registry.call('linkedin_upload_document', { account_id: A, ...f.upload('document').payload as object }, runtime.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(mutations(f)).toHaveLength(0);
    const allowed = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(v) { pending.set(v.id, v); }, async get(id) { return pending.get(id); }, async delete(id) { pending.delete(id); }, async consume(id: string, expectedHash: string) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } }, { async append() {} }), providerModules: [{ provider: f.provider, tools: linkedinTools(f.provider) }] });
    const input = { account_id: A, ...f.upload('document').payload as object }, preview = await allowed.registry.call('linkedin_upload_document', input, allowed.ctx) as { pending_operation_id: string };
    await expect(allowed.registry.call('linkedin_upload_document', { ...input, name: 'Changed', pending_operation_id: preview.pending_operation_id }, allowed.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(await allowed.registry.call('linkedin_upload_document', { ...input, pending_operation_id: preview.pending_operation_id }, allowed.ctx)).toMatchObject({ applied: true });
    await expect(allowed.registry.call('linkedin_upload_document', { ...input, pending_operation_id: preview.pending_operation_id }, allowed.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
    expect(f.calls.filter(c => c.url.searchParams.get('action') === 'initializeUpload')).toHaveLength(1);
    const tools = linkedinTools(f.provider); expect(tools.find(v => v.name === 'linkedin_upload_video')?.annotations).toMatchObject({ readOnly: false, destructive: false });
  });
});
