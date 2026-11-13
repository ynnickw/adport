import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTikTokCatalogAccessStore, catalogGrant, catalogScopeKey, requireCatalogAccess, type TikTokCatalogAccessStore } from '../src/catalog-access.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// Native catalog/get and catalog/update shapes verified against TikTok-owned
// public docs catalogGet/catalogUpdate, collected2026-11-05 in the contract manifest.
const A = '7111000000000000001', B = '111', C = '222';
const scope = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const };
const catalog = { catalog_id: C, catalog_name: 'QA <catalog>', catalog_type: 'ECOM', bc_info: { bc_id: B, bc_name: 'QA Business Center', picture_url: '' }, catalog_conf: { currency: 'EUR', country: 'DE', channel: 'CLIENT', is_multi_country: false }, ad_creation_eligible: 'AVAILABLE', update_time: '2026-11-01 00:00:00' };
const dirs: string[] = [];
async function directory() { const value = await mkdtemp(join(tmpdir(), 'adport-tiktok-catalog-'));dirs.push(value);return value; }
afterEach(async () => { for (const value of dirs.splice(0)) await rm(value, { recursive: true, force: true }); });
type Row = Record<string, unknown>;
type Call = { url: URL; init: RequestInit };
function fixture(store?: TikTokCatalogAccessStore, override?: (call: Call, written: boolean) => unknown | Response) {
  const calls: Call[] = [];let current = structuredClone(catalog), written = false;
  const client = new TikTokClient({ accessToken: 'inert-token' }, async (input, init = {}) => {
    const call = { url: new URL(String(input)), init };calls.push(call);const custom = override?.(call, written);
    if (custom !== undefined) return custom instanceof Response ? custom : Response.json({ code: 0, message: 'OK', data: custom });
    if (call.url.pathname.endsWith('/catalog/get/')) return Response.json({ code: 0, data: { list: [current], page_info: { page: 1, total_page: 1 } } });
    if (call.url.pathname.endsWith('/catalog/update/')) { written = true;current = { ...current, catalog_name: JSON.parse(String(init.body)).name };return Response.json({ code: 0, data: { catalog_id: C } }); }
    throw new Error('Unexpected fixture endpoint');
  });
  const provider = new TikTokAdsProvider(client, { appId: 'inert', secret: 'inert' }, undefined, store);
  const op = (tool: string, payload: Row): WriteOperation => ({ provider: 'tiktok', tool, accountId: A, kind: 'update', payload });
  return { provider, service: provider.catalogs, calls, op };
}
async function selected(mode: 'read' | 'write' = 'write') { const store = new FileTikTokCatalogAccessStore(join(await directory(), 'grants'));await store.compareAndSet(scope, catalogGrant(scope).hash, mode);return store; }
const writes = (calls: Call[]) => calls.filter(value => value.init.method !== 'GET');
const guard = { forcePausedCreation: true };
const input = { account_id: A, bc_id: B, catalog_id: C };

describe('explicit TikTok catalog scope', () => {
  it('has no implicit scope from an advertiser or Business Center credential', async () => {
    const f = fixture();await expect(f.service.get(input)).rejects.toThrow('Catalog access has not been selected');expect(f.calls).toHaveLength(0);expect(await f.service.access(A)).toMatchObject({ records: [] });
    const store = new FileTikTokCatalogAccessStore(join(await directory(), 'grants'));await expect(requireCatalogAccess(store, scope)).rejects.toThrow('does not have read access');
  });
  it('keeps account, Business Center, catalog and purpose distinct, including absent and revoked revisions', async () => {
    const store = await selected('read');expect((await store.get(scope)).mode).toBe('read');
    for (const patch of [{ accountId: '333' }, { businessId: '333' }, { resourceId: '333' }]) expect((await store.get({ ...scope, ...patch })).mode).toBe('none');
    const before = await store.get(scope), revoked = await store.compareAndSet(scope, before.hash, 'none');expect(revoked.revision).toBe(before.revision + 1);expect(revoked.hash).not.toBe(catalogGrant(scope).hash);expect(await store.list(A)).toEqual([]);await expect(store.compareAndSet(scope, before.hash, 'write')).rejects.toThrow('changed');
    expect(() => catalogGrant({ ...scope, kind: 'catalog_creation' }, 'write')).toThrow();expect(() => catalogGrant(scope, 'write', Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it('publishes private files atomically, rejects symlinks/transplants and permits only one concurrent update', async () => {
    const dir = join(await directory(), 'grants'), store = new FileTikTokCatalogAccessStore(dir), missing = await store.get(scope);
    const attempts = await Promise.allSettled([store.compareAndSet(scope, missing.hash, 'read'), store.compareAndSet(scope, missing.hash, 'write')]);expect(attempts.filter(value => value.status === 'fulfilled')).toHaveLength(1);expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const file = join(dir, catalogScopeKey(scope) + '.json');expect((await stat(file)).mode & 0o777).toBe(0o600);expect((await readdir(dir)).filter(value => !value.endsWith('.json'))).toEqual([]);
    const other = { ...scope, resourceId: '999' };await writeFile(join(dir, catalogScopeKey(other) + '.json'), await readFile(file));await expect(store.get(other)).rejects.toThrow('could not be verified');
    await rm(join(dir, catalogScopeKey(other) + '.json'));await symlink(file, join(dir, catalogScopeKey(other) + '.json'));await expect(store.get(other)).rejects.toThrow('could not be verified');
  });
  it('rejects a mismatched store result and preserves read-only principal restrictions', async () => {
    const file = await selected(), other = catalogGrant({ ...scope, resourceId: '999' }, 'write', 1), store = { canManage: false, canWrite: false, get: async () => other, authorize: async () => other, list: async () => [other], compareAndSet: file.compareAndSet.bind(file) };
    await expect(requireCatalogAccess(store, scope)).rejects.toThrow('scope');await expect(requireCatalogAccess(store, scope, true)).rejects.toThrow('cannot modify');
  });
});

describe('TikTok exact catalog reads and native rename', () => {
  it('uses fixed native v1.3 paths, string IDs, trailing slash, redirect rejection and exact configuration', async () => {
    const f = fixture(await selected('read')), result = await f.service.get(input), call = f.calls[0]!;
    expect(call.url.href).toContain('https://business-api.tiktok.com/open_api/v1.3/catalog/get/?');expect(Object.fromEntries(call.url.searchParams)).toEqual({ bc_id: B, catalog_id: C, page: '1', page_size: '1000' });expect(new Headers(call.init.headers).get('Access-Token')).toBe('inert-token');expect(call.init.redirect).toBe('error');expect(call.init.signal).toBeDefined();expect(result.catalog.configuration_hash).toMatch(/^[a-f0-9]{64}$/);expect(result.records[0]).toMatchObject({ name: catalog.catalog_name, business_center: 'QA Business Center', native_ad_eligibility: 'AVAILABLE' });expect(writes(f.calls)).toHaveLength(0);
  });
  it.each(['wrong-catalog', 'wrong-bc', 'multiple', 'empty', 'wrong-page'])('rejects %s exact-ID responses', async fault => {
    const f = fixture(await selected(), () => ({ list: fault === 'empty' ? [] : fault === 'multiple' ? [catalog, catalog] : [{ ...catalog, ...(fault === 'wrong-catalog' ? { catalog_id: '999' } : {}), ...(fault === 'wrong-bc' ? { bc_info: { bc_id: '999' } } : {}) }], page_info: { page: fault === 'wrong-page' ? 2 : 1, total_page: 1 } }));await expect(f.service.get(input)).rejects.toThrow('scope');
  });
  it('does not expose native error bodies or replay permission errors', async () => {
    const f = fixture(await selected(), () => Response.json({ code: 40001, message: 'sensitive-provider-error', data: { access_token: 'private-native-token' }, request_id: 'safe-request-1' }));await expect(f.service.get(input)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { provider_code: 40001, request_id: 'safe-request-1' } });
    try { await f.service.get(input); } catch (error) { expect(JSON.stringify(error)).not.toContain('private-native-token');expect(String(error)).not.toContain('sensitive-provider-error'); }expect(f.calls).toHaveLength(2);
  });
  it('previews with reads, sends native name rather than catalog_name and independently verifies preservation', async () => {
    const f = fixture(await selected()), current = (await f.service.get(input)).catalog, operation = f.op('tiktok_update_catalog', { bc_id: B, catalog_id: C, name: 'QA renamed', expected_configuration_hash: current.configuration_hash, acknowledge_shared_effects: true });
    const preview = await f.provider.previewWrite(operation, guard);expect(preview.review?.fields[0]).toMatchObject({ before: catalog.catalog_name, after: 'QA renamed' });expect(writes(f.calls)).toHaveLength(0);expect(preview.serverValidated).toBe(false);
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ applied: true, resourceIds: [C] });expect(writes(f.calls)).toHaveLength(1);const write = writes(f.calls)[0]!;expect(write.url.pathname).toBe('/open_api/v1.3/catalog/update/');expect(JSON.parse(String(write.init.body))).toEqual({ bc_id: B, catalog_id: C, name: 'QA renamed' });expect(f.calls.at(-1)!.init.method).toBe('GET');
  });
  it('checks current grant and snapshot before writes and ignores volatile diagnostics only', async () => {
    let patch: Row = {};const store = await selected(), f = fixture(store, call => call.init.method === 'GET' ? { list: [{ ...catalog, ...patch }] } : undefined), current = (await f.service.get(input)).catalog;
    patch = { ad_creation_eligible: 'NOT_AVAILABLE', update_time: '2030-01-01' };expect((await f.service.get(input)).catalog.configuration_hash).toBe(current.configuration_hash);
    patch = { catalog_conf: { ...catalog.catalog_conf, currency: 'USD' } };await expect(f.provider.applyWrite(f.op('tiktok_update_catalog', { bc_id: B, catalog_id: C, name: 'changed', expected_configuration_hash: current.configuration_hash, acknowledge_shared_effects: true }), guard)).rejects.toThrow('configuration changed');
    const access = await store.get(scope);await store.compareAndSet(scope, access.hash, 'read');await expect(f.provider.previewWrite(f.op('tiktok_update_catalog', { bc_id: B, catalog_id: C, name: 'changed', expected_configuration_hash: current.configuration_hash, acknowledge_shared_effects: true }), guard)).rejects.toThrow('write access');expect(writes(f.calls)).toHaveLength(0);
  });
  it.each(['wrong-id', 'readback-mismatch', 'transport'])('retains known ID after %s without automatic replay', async fault => {
    const f = fixture(await selected(), (call, written) => {
      if (call.init.method === 'POST' && fault === 'wrong-id') return { catalog_id: '999' };
      if (call.init.method === 'POST' && fault === 'transport') throw new Error('synthetic transport');
      if (written && fault === 'readback-mismatch') return { list: [{ ...catalog, catalog_type: 'HOTEL' }] };
      return undefined;
    });const current = (await f.service.get(input)).catalog;await expect(f.provider.applyWrite(f.op('tiktok_update_catalog', { bc_id: B, catalog_id: C, name: 'new', expected_configuration_hash: current.configuration_hash, acknowledge_shared_effects: true }), guard)).rejects.toMatchObject({ details: { resource_ids: [C] } });expect(writes(f.calls)).toHaveLength(1);
  });
});

describe('catalog access administration is separate from agent capabilities', () => {
  it('omits management tools from the default hosted catalog and rejects non-manager stores before native reads', async () => {
    const store = await selected(), reader = { canManage: false, canWrite: true, get: store.get.bind(store), authorize: store.authorize.bind(store), list: store.list.bind(store), compareAndSet: store.compareAndSet.bind(store) }, f = fixture(reader);
    expect(tiktokTools(f.provider).some(value => value.name === 'tiktok_set_catalog_access')).toBe(false);expect(tiktokTools(f.provider, { catalogAccessManagement: true }).some(value => value.name === 'tiktok_set_catalog_access')).toBe(true);
    await expect(f.service.accessSnapshot(input)).rejects.toThrow('Only the local owner');expect(f.calls).toHaveLength(0);
  });
  it('uses shared approval hashing, apply-time scope checks, audit and protected-account rejection', async () => {
    const dir = await directory(), store = new FileTikTokCatalogAccessStore(join(dir, 'grants')), f = fixture(store), audit = new AuditLog(join(dir, 'audit')), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), audit), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider, { catalogAccessManagement: true }) }] });
    const args = { ...input, mode: 'write', expected_access_hash: catalogGrant(scope).hash }, preview = await runtime.registry.call('tiktok_set_catalog_access', args, runtime.ctx) as { pending_operation_id: string };expect((await store.get(scope)).mode).toBe('none');expect(writes(f.calls)).toHaveLength(0);
    await expect(runtime.registry.call('tiktok_set_catalog_access', { ...args, mode: 'read', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(await runtime.registry.call('tiktok_set_catalog_access', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toHaveProperty('result.applied', true);expect((await store.get(scope)).mode).toBe('write');
    const current = (await f.service.get(input)).catalog, rename = { ...input, name: 'QA', expected_configuration_hash: current.configuration_hash, acknowledge_shared_effects: true }, pending = await runtime.registry.call('tiktok_update_catalog', rename, runtime.ctx) as { pending_operation_id: string };
    const grant = await store.get(scope);await store.compareAndSet(scope, grant.hash, 'read');await expect(runtime.registry.call('tiktok_update_catalog', { ...rename, pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('write access');expect(writes(f.calls)).toHaveLength(0);
    const blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(join(dir, 'blocked')), audit), before = f.calls.length;await expect(blocked.validate(f.provider, f.op('tiktok_set_catalog_access', { bc_id: B, catalog_id: C, mode: 'none', expected_access_hash: (await store.get(scope)).hash }))).rejects.toThrow('protected');expect(f.calls).toHaveLength(before);
    const logs = (await Promise.all((await readdir(join(dir, 'audit'))).map(file => readFile(join(dir, 'audit', file), 'utf8')))).join('');expect(logs).toContain('tiktok_set_catalog_access');expect(logs).toContain('applied');
  });
  it('can revoke a grant after native catalog permissions have been lost', async () => {
    const store = await selected(), current = await store.get(scope), f = fixture(store, () => { throw new Error('Native calls must not be made'); });expect(await f.provider.applyWrite(f.op('tiktok_set_catalog_access', { bc_id: B, catalog_id: C, mode: 'none', expected_access_hash: current.hash }), guard)).toMatchObject({ applied: true });expect(f.calls).toHaveLength(0);await expect(f.service.get(input)).rejects.toThrow('read access');
  });
});
