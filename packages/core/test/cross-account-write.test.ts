import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { additionalAccountIds, AuditLog, createContext, DEFAULT_POLICY, defineTool, guardedWriteTool, hashOperation, PendingStore, PolicyEngine, type AdProvider, type WriteOperation } from '../src/index.js';

const dirs: string[] = [];
async function fixture(protectedAccounts: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'adport-cross-account-'));dirs.push(dir);
  const pending = new PendingStore(join(dir, 'pending')), audit = new AuditLog(join(dir, 'audit')), engine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: protectedAccounts }, pending, audit);
  const provider: AdProvider = { id: 'google', capabilities: () => ({ serverDryRun: false }), listAccounts: async () => [], report: async () => ({ rows: [] }), previewWrite: vi.fn(async () => ({ summary: 'Share resource', changes: [], coercions: [], budgetDeltas: [], serverValidated: false })), applyWrite: vi.fn(async () => ({ applied: true as const, resourceIds: ['resource'] })) };
  const tool = guardedWriteTool({ name: 'google_test_share', namespace: 'google', provider: 'google', kind: 'update', description: 'Synthetic cross-account policy fixture', payload: z.object({ recipients: z.array(z.string()).min(1) }).strict(), additionalAccountInputs: ['recipients'] }), runtime = await createContext({ engine, providerModules: [{ provider, tools: [tool] }] });
  return { provider, engine, pending, runtime, tool };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('cross-account structural policy metadata', () => {
  it('derives declared scalar/array accounts once and rejects invalid values or undeclared schema fields', () => {
    expect(additionalAccountIds({ additionalAccountInputs: ['one', 'many'] }, { one: 'b', many: ['a', 'b'] })).toEqual(['a', 'b']);expect(additionalAccountIds({}, { recipients: ['unrelated'] })).toEqual([]);
    for (const recipients of [123, [123], [''], [' '.repeat(2)], ['a'.repeat(201)], Array.from({ length: 101 }, (_, i) => String(i))]) expect(() => additionalAccountIds({ additionalAccountInputs: ['recipients'] }, { recipients })).toThrow();
    expect(() => defineTool({ name: 'google_bad_fixture', namespace: 'google', description: 'fixture', input: z.object({ recipient: z.string() }), additionalAccountInputs: ['not_declared'], handler: async () => ({}) })).toThrow(/declared/);
  });
  it('binds derived destination IDs to the real shared pending operation and consumes approval once', async () => {
    const f = await fixture(), input = { account_id: '1111111111', recipients: ['3333333333', '2222222222', '3333333333'] }, preview: any = await f.runtime.registry.call(f.tool.name, input, f.runtime.ctx), stored = await f.pending.get(preview.pending_operation_id);
    expect(stored!.op.affectedAccountIds).toEqual(['2222222222', '3333333333']);expect(f.provider.applyWrite).not.toHaveBeenCalled();
    expect(await f.runtime.registry.call(f.tool.name, { ...input, pending_operation_id: preview.pending_operation_id }, f.runtime.ctx)).toMatchObject({ applied: true });expect(f.provider.applyWrite).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ affectedAccountIds: ['2222222222', '3333333333'] }), expect.anything());
    await expect(f.runtime.registry.call(f.tool.name, { ...input, pending_operation_id: preview.pending_operation_id }, f.runtime.ctx)).rejects.toThrow();
  });
  it('rejects any protected destination before provider preview or execution, including canonical IDs', async () => {
    const f = await fixture(['2222222222']);await expect(f.runtime.registry.call(f.tool.name, { account_id: '1111111111', recipients: ['222-222-2222'] }, f.runtime.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(f.provider.previewWrite).not.toHaveBeenCalled();expect(f.provider.applyWrite).not.toHaveBeenCalled();
  });
  it('invalidates an approval if affected accounts change even with identical payload', async () => {
    const f = await fixture(), op: WriteOperation = { provider: 'google', accountId: '1111111111', tool: 'google_test_share', kind: 'update', payload: {}, affectedAccountIds: ['2222222222'] }, pending = await f.engine.validate(f.provider, op);
    for (const affectedAccountIds of [undefined, ['3333333333']]) await expect(f.engine.apply(f.provider, { ...op, affectedAccountIds }, pending.pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.provider.applyWrite).not.toHaveBeenCalled();
    expect(hashOperation(op)).toBe(hashOperation({ ...op, affectedAccountIds: ['2222222222', '2222222222'] }));expect(hashOperation({ ...op, affectedAccountIds: undefined })).not.toBe(hashOperation(op));
  });
});
