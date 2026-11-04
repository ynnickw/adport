import { createContext, DEFAULT_POLICY, PolicyEngine, type ManagedMediaLibrary, type PendingOperation, type WriteOperation } from '../src/index.js';
import { describe, expect, it } from 'vitest';

function fixture() {
  const pending = new Map<string, PendingOperation>(), calls: WriteOperation[] = [];
  const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(id) { return pending.get(id); }, async delete(id) { pending.delete(id); } }, { async append() {} });
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
});
