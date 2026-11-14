import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createContext, DEFAULT_POLICY, PolicyEngine, guardedWriteTool, mediaWriteSchemas, type AdProvider, type ManagedMediaLibrary, type PendingOperation, type WriteResult } from '../src/index.js';

const ID = '11111111-1111-4111-8111-111111111111', SHA = 'a'.repeat(64);
function fixture(providerId = 'meta', mime = 'image/png', definitions?: Array<{ name: string; payload: z.ZodObject<z.ZodRawShape> }>) {
  const pending = new Map<string, PendingOperation>(), apply = vi.fn(async () => ({ applied: true as const, resourceIds: ['native-1'] }));
  const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(id) { return pending.get(id); }, async delete(id) { pending.delete(id); }, async consume(id, expectedHash) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } }, { async append() {} });
  const track = vi.fn(async (_input: Record<string, unknown>, execute: () => Promise<WriteResult>) => execute());
  const media: ManagedMediaLibrary = { scopeId: 'project', list: async () => ({ assets: [], truncated: false }), get: async id => ({ id, name: 'Launch.png', content_type: mime, byte_length: 120, sha256: SHA, status: 'READY' }), read: async () => { throw new Error('Planning must not transfer bytes'); }, previewWrite: async () => { throw new Error('Unexpected library write'); }, applyWrite: async () => { throw new Error('Unexpected library write'); }, trackUpload: track };
  const provider: AdProvider = { id: providerId, capabilities: () => ({ serverDryRun: false }), listAccounts: async () => [{ provider: providerId, id: 'account-1', name: 'Enabled account' }], report: async () => ({ rows: [], truncated: false }), previewWrite: async () => ({ summary: 'Upload exact file', changes: ['Unattached source'], coercions: [], budgetDeltas: [], serverValidated: false }), applyWrite: apply };
  const tools = (definitions ?? [{ name: 'meta_upload_image', payload: z.object({ media_id: z.string().uuid(), expected_sha256: z.string() }) }]).map(value => guardedWriteTool({ ...value, provider: providerId, namespace: providerId, kind: 'create', description: 'Fixture native upload' }));
  return { runtime: createContext({ providerModules: [{ provider, tools }], engine, media }), apply, track, media };
}

describe('central media distribution planning', () => {
  it('binds exact source and enabled destination without creating an approval or reading file bytes', async () => {
    const f = fixture(), runtime = await f.runtime;
    expect(runtime.registry.get('meta_upload_image').annotations).toMatchObject({ readOnly: false, destructive: false });
    const result = await runtime.registry.call('media_distribution_plan', { media_id: ID }, runtime.ctx) as { destinations: Array<Record<string, unknown>> };
    expect(result.destinations[0]).toMatchObject({ provider: 'meta', account_id: 'account-1', tool: 'meta_upload_image', ready: true, arguments: { account_id: 'account-1', media_id: ID, expected_sha256: SHA } });
    expect(result.destinations[0]).not.toHaveProperty('pending_operation_id'); expect(f.apply).not.toHaveBeenCalled(); expect(f.track).not.toHaveBeenCalled();
    await expect(runtime.registry.call('media_distribution_plan', { media_id: ID, provider: 'meta', account_id: 'other' }, runtime.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  });
  it.each(['media_id', 'expected_sha256', 'account_id', 'project_id', 'file_path', 'pending_operation_id'])('rejects a %s override in provider parameters', async key => {
    const runtime = await fixture().runtime;
    await expect(runtime.registry.call('media_distribution_plan', { media_id: ID, parameters: { [key]: 'override' } }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('does not pretend unsupported files are converted for another channel', async () => {
    const f = fixture('google', 'video/mp4'), runtime = await f.runtime;
    const result = await runtime.registry.call('media_distribution_plan', { media_id: ID }, runtime.ctx) as { destinations: unknown[] };
    expect(result.destinations[0]).toMatchObject({ available: false }); expect(f.apply).not.toHaveBeenCalled();
  });
  it('prepares then reuses a Spotify container through existing registered schemas', async () => {
    const f = fixture('spotify', 'audio/mpeg', [{ name: 'spotify_create_asset', payload: z.object({ name: z.string(), asset_type: z.enum(['AUDIO']) }) }, { name: 'spotify_upload_asset', payload: z.object({ asset_id: z.string(), media_id: z.string().uuid(), expected_sha256: z.string() }) }]), runtime = await f.runtime;
    const first = await runtime.registry.call('media_distribution_plan', { media_id: ID }, runtime.ctx) as { destinations: unknown[] };
    expect(first.destinations[0]).toMatchObject({ stage: 'prepare', tool: 'spotify_create_asset', arguments: { asset_type: 'AUDIO', name: 'Launch.png' } });
    const next = await runtime.registry.call('media_distribution_plan', { media_id: ID, provider: 'spotify', account_id: 'account-1', parameters: { asset_id: 'native-container' } }, runtime.ctx) as { destinations: unknown[] };
    expect(next.destinations[0]).toMatchObject({ stage: 'upload', tool: 'spotify_upload_asset', arguments: { asset_id: 'native-container', media_id: ID, expected_sha256: SHA } });
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('keeps original-content and board visibility choices explicit for Pinterest', async () => {
    const f = fixture('pinterest', 'image/png', [{ name: 'pinterest_create_image_pin', payload: z.object({ media_id: z.string(), expected_sha256: z.string(), board_id: z.string(), original_content: z.literal(true), expected_board_privacy: z.enum(['PUBLIC', 'SECRET']), confirm_publication: z.boolean().default(false) }) }]), runtime = await f.runtime;
    const result = await runtime.registry.call('media_distribution_plan', { media_id: ID }, runtime.ctx) as { destinations: Array<{ ready: boolean; fields: Array<{ key: string }> }> };
    expect(result.destinations[0]!.ready).toBe(false); expect(result.destinations[0]!.fields.map(field => field.key)).toEqual(expect.arrayContaining(['board_id', 'original_content', 'expected_board_privacy']));
    const publicPlan = await runtime.registry.call('media_distribution_plan', { media_id: ID, provider: 'pinterest', account_id: 'account-1', parameters: { board_id: 'board', original_content: true, expected_board_privacy: 'PUBLIC' } }, runtime.ctx) as typeof result;
    expect(publicPlan.destinations[0]!.ready).toBe(false); expect(publicPlan.destinations[0]!.fields.map(field => field.key)).toContain('confirm_publication');
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('tracks an actual approved provider apply once, never previews, mismatched arguments or replays', async () => {
    const f = fixture(), runtime = await f.runtime, args = { account_id: 'account-1', media_id: ID, expected_sha256: SHA };
    const preview = await runtime.registry.call('meta_upload_image', args, runtime.ctx) as { pending_operation_id: string };
    expect(f.track).not.toHaveBeenCalled();
    await expect(runtime.registry.call('meta_upload_image', { ...args, expected_sha256: 'b'.repeat(64), pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(f.track).not.toHaveBeenCalled();
    await runtime.registry.call('meta_upload_image', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    expect(f.track).toHaveBeenCalledOnce(); expect(f.track.mock.calls[0]![0]).toEqual({ provider: 'meta', account_id: 'account-1', tool: 'meta_upload_image', media_id: ID, expected_sha256: SHA }); expect(f.apply).toHaveBeenCalledOnce();
    await expect(runtime.registry.call('meta_upload_image', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow(); expect(f.apply).toHaveBeenCalledOnce(); expect(f.track).toHaveBeenCalledOnce();
  });
  it('normalizes shared labels and requires the asset metadata version', () => {
    const schema = mediaWriteSchemas.media_update_metadata, input = { media_id: ID, expected_sha256: SHA, expected_version: 1, tags: [' Launch ', 'launch'], platforms: ['meta', 'meta'] };
    expect(schema.parse(input)).toMatchObject({ tags: ['launch'], platforms: ['meta'] });
    expect(schema.safeParse({ ...input, expected_version: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...input, platforms: ['unknown'] }).success).toBe(false);
  });
});
