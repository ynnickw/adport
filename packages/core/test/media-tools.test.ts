import { createContext, DEFAULT_POLICY, PolicyEngine, type ManagedMediaLibrary, type MediaAsset, type PendingOperation, type WriteOperation } from '../src/index.js';
import { describe, expect, it } from 'vitest';

function fixture() {
  const pending = new Map<string, PendingOperation>(), calls: WriteOperation[] = [];
  const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(id) { return pending.get(id); }, async delete(id) { pending.delete(id); }, async consume(id: string, expectedHash: string) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } }, { async append() {} });
  const media = (scopeId: string): ManagedMediaLibrary => ({ scopeId, list: async () => ({ assets: [], truncated: false }), read: async () => { throw new Error('No file read expected'); }, get: async () => { throw new Error('No metadata read expected'); }, previewWrite: async op => { calls.push(op); return { summary: 'Stage exact private file', changes: ['Private library only'], coercions: [], budgetDeltas: [], serverValidated: false }; }, applyWrite: async op => { calls.push(op); return { applied: true, resourceIds: ['11111111-1111-4111-8111-111111111111'] }; } });
  return { engine, media, pending, calls };
}

describe('project media tools through the shared policy gate', () => {
  const metadata = { name: 'test.png', content_type: 'image/png', byte_length: 17, sha256: 'a'.repeat(64) };
  it('advertises agent upload paths and project writes without an invented advertising account', async () => {
    const f = fixture(), runtime = await createContext({ engine: f.engine, media: f.media('project-a') });
    const names = runtime.registry.list().map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['media_list', 'media_get', 'media_prepare_upload', 'media_upload', 'media_upload_part', 'media_finalize_upload', 'media_rename', 'media_delete']));
    expect(runtime.registry.get('media_prepare_upload').input.shape).not.toHaveProperty('account_id');
    for (const name of ['media_prepare_upload', 'media_upload', 'media_upload_part', 'media_finalize_upload', 'media_rename']) expect(runtime.registry.get(name).annotations).toMatchObject({ readOnly: false, destructive: false });
    expect(runtime.registry.get('media_delete').annotations).toMatchObject({ readOnly: false, destructive: true });
    const preview = await runtime.registry.call('media_prepare_upload', metadata, runtime.ctx) as { applied: boolean; pending_operation_id: string };
    expect(preview.applied).toBe(false); expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ provider: 'media', accountId: 'project-a', payload: metadata });
    await expect(runtime.registry.call('media_prepare_upload', { ...metadata, name: 'different.png', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const other = await createContext({ engine: f.engine, media: f.media('project-b') });
    await expect(other.registry.call('media_prepare_upload', { ...metadata, pending_operation_id: preview.pending_operation_id }, other.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const applied = await runtime.registry.call('media_prepare_upload', { ...metadata, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    expect(applied).toMatchObject({ applied: true }); expect(f.calls).toHaveLength(3);
  });

  it('rejects readonly authorization, unsupported local management and oversized inline input before mutation', async () => {
    const f = fixture(), denied = await createContext({ engine: f.engine, media: f.media('project-a'), authorizeToolCall: () => { throw new Error('Read-only connection'); } });
    await expect(denied.registry.call('media_prepare_upload', metadata, denied.ctx)).rejects.toThrow('Read-only');
    const local = await createContext();
    await expect(local.registry.call('media_prepare_upload', metadata, local.ctx)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    const runtime = await createContext({ engine: f.engine, media: f.media('project-a') });
    await expect(runtime.registry.call('media_upload', { ...metadata, byte_length: 1024 * 1024 + 1, data_base64: 'YQ==' }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.calls).toEqual([]);
  });

  it('binds a host file import to its exact capability, checksum and selected project', async () => {
    const f = fixture(), runtime = await createContext({ engine: f.engine, media: f.media('project-a') });
    const input = { ...metadata, file: { download_url: 'https://files.oaiusercontent.com/file-fixture?sig=fixture', file_id: 'file_fixture' } };
    expect(runtime.registry.get('media_import_file').fileInputs).toEqual(['file']);
    expect(runtime.registry.get('media_inspect_file').annotations.readOnly).toBe(true);
    const preview = await runtime.registry.call('media_import_file', input, runtime.ctx) as { pending_operation_id: string };
    await expect(runtime.registry.call('media_import_file', { ...input, file: { ...input.file, file_id: 'file_other' }, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const other = await createContext({ engine: f.engine, media: f.media('project-b') });
    await expect(other.registry.call('media_import_file', { ...input, pending_operation_id: preview.pending_operation_id }, other.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(await runtime.registry.call('media_import_file', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toMatchObject({ applied: true });
    expect(f.calls.at(-1)).toMatchObject({ provider: 'media', accountId: 'project-a', kind: 'create', payload: input });
  });

  it.each([
    ['image/png', 'image'], ['video/mp4', 'video'], ['audio/mpeg', 'audio'], ['application/pdf', 'image'],
  ])('previews one ready %s source without listing or reading its bytes', async (content_type, kind) => {
    const f = fixture(), id = '11111111-1111-4111-8111-111111111111';
    const asset: MediaAsset = { id, ...metadata, content_type, status: 'READY', preview_url: 'https://storage.example/original', ...(content_type === 'application/pdf' ? { preview_cover_url: 'https://storage.example/cover.png' } : {}), tags: ['qa'], platforms: ['meta'], metadata_version: 3 };
    const library = f.media('project-a'), reads: string[] = [];
    library.get = async value => { reads.push(value); return asset; };
    library.list = async () => { throw new Error('No list expected'); };
    const runtime = await createContext({ engine: f.engine, media: library });
    const result = await runtime.registry.call('media_get', { media_id: id }, runtime.ctx);
    expect(result).toMatchObject({ asset, truncated: false, creatives: [{ id, name: metadata.name, status: 'READY', descriptions: ['17 bytes', 'Tags: qa', 'Platforms: meta'], actions: [], media: [{ type: kind, url: content_type === 'application/pdf' ? asset.preview_cover_url : asset.preview_url, ...(content_type === 'application/pdf' ? { open_url: asset.preview_url } : {}) }] }] });
    expect(reads).toEqual([id]); expect(f.calls).toEqual([]);
    expect(runtime.registry.get('media_get').output!.safeParse(result).success).toBe(true);
  });

  it.each(['PROCESSING', 'FAILED', 'DELETED'] as const)('keeps %s metadata visible without offering its media as ready', async status => {
    const f = fixture(), id = '11111111-1111-4111-8111-111111111111', library = f.media('project-a');
    library.get = async () => ({ id, ...metadata, status, preview_url: 'https://storage.example/stale.png' });
    const runtime = await createContext({ engine: f.engine, media: library });
    expect(await runtime.registry.call('media_get', { media_id: id }, runtime.ctx)).toMatchObject({ asset: { status }, creatives: [{ status, media: [] }], truncated: false });
    expect(f.calls).toEqual([]);
  });

  it('preserves a local HTTP source for headless download without exposing it as a browser preview', async () => {
    const f = fixture(), id = '11111111-1111-4111-8111-111111111111', library = f.media('project-a');
    const asset: MediaAsset = { id, ...metadata, status: 'READY', preview_url: 'http://127.0.0.1:54321/storage/v1/object/sign/creative-media/local-source' };
    library.get = async () => asset;
    const runtime = await createContext({ engine: f.engine, media: library });
    const result = await runtime.registry.call('media_get', { media_id: id }, runtime.ctx);
    expect(result).toMatchObject({ asset, creatives: [{ media: [] }] });
    expect(runtime.registry.get('media_get').output!.safeParse(result).success).toBe(true);
    expect(f.calls).toEqual([]);
  });
});
