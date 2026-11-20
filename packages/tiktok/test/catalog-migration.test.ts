import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogGrant, creationScope, FileTikTokCatalogAccessStore, migrationScope } from '../src/catalog-access.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// TikTok-owned v1.3 catalog/capitalize and bc/get contracts refreshed 2026-11-19.
const A = '7678335757387513873', B = '222', C = '9007199254740993';
const scope = migrationScope(A, B, C), guard = { forcePausedCreation: true };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(delegate = true) {
  const dir = await mkdtemp(join(tmpdir(), 'adport-migration-'));dirs.push(dir);
  const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));
  if (delegate) await store.compareAndSet(scope, catalogGrant(scope).hash, 'migrate');
  const state = { role: 'ADMIN', bc: B, present: false, fault: '' };
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const client = new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
    const url = new URL(String(raw));calls.push({ url, init });const ok = (data: unknown) => Response.json({ code: 0, data });
    if (url.pathname.endsWith('/bc/get/')) return ok({ list: [{ bc_info: { bc_id: state.bc, name: 'QA destination' }, user_role: state.role }], page_info: { page: 1, total_page: 1, total_number: 1 } });
    if (url.pathname.endsWith('/catalog/get/')) {
      if (state.fault === 'readback' && state.present) return Response.json({ code: 40001, message: 'PRIVATE' });
      return ok({ list: state.present ? [{ catalog_id: state.fault === 'wrong-id' ? '333' : C, catalog_name: 'QA source', catalog_type: 'ECOM', bc_info: { bc_id: state.fault === 'wrong-bc' ? '333' : B }, catalog_conf: { currency: 'EUR' } }] : [], page_info: { page: 1, total_page: 1, total_number: state.present ? 1 : 0 } });
    }
    if (url.pathname.endsWith('/catalog/capitalize/')) {
      if (state.fault === 'transport') throw new Error('PRIVATE');
      if (state.fault === 'denied') return Response.json({ code: 40001, message: 'PRIVATE' });
      state.present = state.fault !== 'absent';
      if (state.fault === 'revoke') await store.compareAndSet(scope, (await store.get(scope)).hash, 'none');
      return ok({});
    }
    throw new Error('Unexpected endpoint');
  });
  const provider = new TikTokAdsProvider(client, { appId: 'inert', secret: 'inert' }, undefined, store);
  const context = () => provider.catalogs.migration.context({ account_id: A, bc_id: B, catalog_id: C });
  const args = async () => { const current = await context();return { bc_id: B, catalog_id: C, expected_migration_access_hash: current.expected_migration_access_hash, expected_destination_hash: current.expected_destination_hash, confirm_catalog_id: C, acknowledge_shared_effects: true, acknowledge_source_ownership_not_independently_verified: true }; };
  const op = (payload: Record<string, unknown>): WriteOperation => ({ provider: 'tiktok', tool: 'tiktok_migrate_catalog', kind: 'update', accountId: A, payload });
  return { dir, store, state, calls, provider, context, args, op, writes: () => calls.filter(call => call.init.method === 'POST') };
}

describe('separately delegated TikTok catalog transfer', () => {
  it('does not infer transfer rights from creation or existing catalog grants', async () => {
    const f = await setup(false), creation = creationScope(A, B), catalog = { ...scope, kind: 'catalog' as const };
    await f.store.compareAndSet(creation, catalogGrant(creation).hash, 'create');await f.store.compareAndSet(catalog, catalogGrant(catalog).hash, 'write');
    await expect(f.context()).rejects.toThrow('attest');expect(f.calls).toHaveLength(0);
    expect(() => catalogGrant(scope, 'write')).toThrow();expect(() => catalogGrant(catalog, 'migrate')).toThrow();
    await expect(f.provider.catalogs.migration.context({ account_id: A, bc_id: '999', catalog_id: C })).rejects.toThrow('attest');
  });
  it('requires both owner attestations, exact scope and normal approval to delegate transfer', async () => {
    const f = await setup(false), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider, { catalogAccessManagement: true }) }] });
    const args = { account_id: A, bc_id: B, catalog_id: C, resource_kind: 'catalog_migration', mode: 'migrate', expected_access_hash: catalogGrant(scope).hash, acknowledge_source_ownership: true, acknowledge_shared_effects: true };
    for (const key of ['acknowledge_source_ownership', 'acknowledge_shared_effects']) await expect(runtime.registry.call('tiktok_set_catalog_access', { ...args, [key]: undefined }, runtime.ctx)).rejects.toThrow();
    const pending = await runtime.registry.call('tiktok_set_catalog_access', args, runtime.ctx) as { pending_operation_id: string };
    expect((await f.store.get(scope)).mode).toBe('none');expect(f.writes()).toHaveLength(0);
    await runtime.registry.call('tiktok_set_catalog_access', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx);
    expect((await f.store.get(scope)).mode).toBe('migrate');expect((await f.store.get({ ...scope, kind: 'catalog' })).mode).toBe('none');
  });
  it('previews truthfully, sends exact native string IDs, verifies destination, and leaves project access unchanged', async () => {
    const f = await setup(), op = f.op(await f.args()), preview = await f.provider.previewWrite(op, guard);
    expect(preview.serverValidated).toBe(false);expect(JSON.stringify(preview)).toContain('not independently verified');expect(f.writes()).toHaveLength(0);
    const bcRead = f.calls.find(call => call.url.pathname.endsWith('/bc/get/'))!;
    expect(Object.fromEntries(bcRead.url.searchParams)).toEqual({ bc_id: B, page: '1', page_size: '1' });
    const result = await f.provider.applyWrite(op, guard);expect(result).toMatchObject({ applied: true, resourceIds: [C], details: { destination_catalog_readback: 'VERIFIED', project_catalog_access: 'UNCHANGED' } });
    expect(f.writes()).toHaveLength(1);const write = f.writes()[0]!;
    expect(write.url.pathname).toBe('/open_api/v1.3/catalog/capitalize/');expect(JSON.parse(String(write.init.body))).toEqual({ advertiser_id: A, bc_id: B, catalog_id: C });
    expect(new Headers(write.init.headers).get('content-type')).toBe('application/json');expect(write.init.redirect).toBe('error');
    expect((await f.store.get({ ...scope, kind: 'catalog' })).mode).toBe('none');await expect(f.context()).rejects.toThrow('already');
  });
  it.each(['STANDARD', 'unknown'])('rejects destination role %s before native transfer', async role => {
    const f = await setup();f.state.role = role;await expect(f.context()).rejects.toThrow('Admin');expect(f.writes()).toHaveLength(0);
  });
  it('rechecks exact grant, destination and explicit confirmation at apply', async () => {
    const f = await setup(), args = await f.args();
    await expect(f.provider.previewWrite(f.op({ ...args, confirm_catalog_id: '333' }), guard)).rejects.toThrow();
    await expect(f.provider.previewWrite(f.op({ ...args, expected_destination_hash: 'a'.repeat(64) }), guard)).rejects.toThrow('changed');
    await f.store.compareAndSet(scope, (await f.store.get(scope)).hash, 'none');await expect(f.provider.applyWrite(f.op(args), guard)).rejects.toThrow('attest');expect(f.writes()).toHaveLength(0);
  });
  it.each(['transport', 'denied', 'readback', 'wrong-id', 'wrong-bc', 'absent', 'revoke'])('retains exact ID after %s and never automatically replays', async fault => {
    const f = await setup(), args = await f.args();f.state.fault = fault;
    await expect(f.provider.applyWrite(f.op(args), guard)).rejects.toMatchObject({ details: { resource_ids: [C] } });expect(f.writes()).toHaveLength(1);
  });
  it('uses the shared pending token, rejects argument changes, consumes approval and audits the operation', async () => {
    const f = await setup(), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] });
    const args = { account_id: A, ...await f.args() }, pending = await runtime.registry.call('tiktok_migrate_catalog', args, runtime.ctx) as { pending_operation_id: string };
    await expect(runtime.registry.call('tiktok_migrate_catalog', { ...args, expected_destination_hash: 'a'.repeat(64), pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await runtime.registry.call('tiktok_migrate_catalog', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx);
    await expect(runtime.registry.call('tiktok_migrate_catalog', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
    const logs = (await Promise.all((await readdir(join(f.dir, 'audit'))).map(file => readFile(join(f.dir, 'audit', file), 'utf8')))).join('');expect(logs).toContain('tiktok_migrate_catalog');expect(f.writes()).toHaveLength(1);
  });
});
