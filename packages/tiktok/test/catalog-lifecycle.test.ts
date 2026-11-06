import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogGrant, creationScope, FileTikTokCatalogAccessStore, requireCatalogAccess } from '../src/catalog-access.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// Current official docs refreshed 2026-11-05: catalog/create1740306481704961,
// catalog/delete1740310064588801, available_country/get1740491257516034, get1740315452868610.
const A = '7678335757387513873', B = '111', C = '9007199254740993', OLD = '222', creation = creationScope(A, B), guard = { forcePausedCreation: true };
type Row = Record<string, any>;
const dirs: string[] = [];afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function setup(delegate = true) {
  const dir = await mkdtemp(join(tmpdir(), 'adport-catalog-lifecycle-'));dirs.push(dir);const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));if (delegate) await store.compareAndSet(creation, catalogGrant(creation).hash, 'create');
  const oldScope = { accountId: A, businessId: B, resourceId: OLD, kind: 'catalog' as const };await store.compareAndSet(oldScope, catalogGrant(oldScope).hash, 'write');
  const state = { regions: ['US', 'GB', 'DE', 'VN'], catalogs: [{ catalog_id: OLD, catalog_name: 'Shared old', catalog_type: 'ECOM', bc_info: { bc_id: B }, catalog_conf: { currency: 'EUR', country: 'DE', is_multi_country: false } }] as Row[], failure: '', created: false, receiptId: C as unknown, permissionLost: false };
  const calls: Array<{ url: URL; init: RequestInit; body?: Row }> = [];
  const client = new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
    const url = new URL(String(raw)), body = init.body ? JSON.parse(String(init.body)) : undefined;calls.push({ url, init, body });const ok = (data: unknown) => Response.json({ code: 0, data });
    if (url.pathname.endsWith('/catalog/available_country/get/')) return ok({ region_codes: state.regions });
    if (url.pathname.endsWith('/catalog/get/')) { if (state.failure === 'readback' && state.created || state.permissionLost) return Response.json({ code: 40001, message: 'PRIVATE-BODY', request_id: 'request_qa' });const list = state.catalogs.filter(row => row.catalog_id === url.searchParams.get('catalog_id'));return ok({ list, page_info: { page: 1, total_page: 1, total_number: state.failure === 'contradictory-absence' && !list.length ? 10 : list.length } }); }
    if (init.method === 'POST') {
      if (state.failure === 'transport') throw new Error('PRIVATE-BODY');if (state.failure === 'native') return Response.json({ code: 40001, message: 'PRIVATE-BODY', request_id: 'request_qa' });
      if (url.pathname.endsWith('/catalog/create/')) {
        state.created = true;const conf = { ...body.catalog_conf, ...(body.catalog_conf.region_code ? { country: body.catalog_conf.region_code } : {}) };delete conf.region_code;if (conf.additional_config_list) conf.additional_config_list = [...conf.additional_config_list].reverse();
        const row = { catalog_id: C, catalog_name: body.name, catalog_type: body.catalog_type, bc_info: { bc_id: B }, catalog_conf: conf };if (state.failure === 'wrong-name') row.catalog_name = 'Different';if (state.failure === 'wrong-bc') row.bc_info.bc_id = '999';if (state.failure === 'wrong-config') row.catalog_conf.currency = 'USD';state.catalogs.push(row);
        if (state.failure === 'revoke') await store.compareAndSet(creation, (await store.get(creation)).hash, 'none');return ok({ catalog_id: state.receiptId });
      }
      if (url.pathname.endsWith('/catalog/delete/')) { if (state.failure !== 'remains') state.catalogs = state.catalogs.filter(row => row.catalog_id !== body.catalog_id);if (state.failure === 'denied-absence') state.permissionLost = true;return ok({ catalog_id: state.failure === 'wrong-receipt' ? '999' : body.catalog_id }); }
    }
    throw new Error('Unexpected fixture endpoint');
  });
  const provider = new TikTokAdsProvider(client, { appId: 'inert', secret: 'inert' }, undefined, store);
  const args = async (overrides: Row = {}) => { const context = await provider.catalogs.lifecycle.context({ account_id: A, bc_id: B });return { bc_id: B, name: 'New QA catalog', catalog_type: 'ECOM', catalog_conf: { currency: 'EUR', region_code: 'DE', is_multi_country: false }, expected_creation_access_hash: context.expected_creation_access_hash, expected_regions_hash: context.expected_regions_hash, acknowledge_new_catalog_management: true, ...overrides }; };
  const op = (tool: string, payload: Row): WriteOperation => ({ tool, provider: 'tiktok', accountId: A, kind: tool === 'tiktok_create_catalog' ? 'create' : 'remove', payload });
  const deletion = async () => { const current = await provider.catalogs.get({ account_id: A, bc_id: B, catalog_id: OLD });return { bc_id: B, catalog_id: OLD, expected_configuration_hash: current.catalog.configuration_hash, confirm_catalog_name: current.catalog.catalog_name, acknowledge_shared_effects: true, acknowledge_delete_products_and_feeds: true }; };
  return { dir, store, oldScope, state, provider, calls, args, op, deletion, writes: () => calls.filter(c => c.init.method === 'POST') };
}

describe('catalog creation delegation and adoption', () => {
  it('does not infer creation from existing catalog grants or enumerate existing Business Center catalogs', async () => {
    const f = await setup(false);await expect(f.provider.catalogs.lifecycle.context({ account_id: A, bc_id: B })).rejects.toThrow('delegate');expect(f.calls).toHaveLength(0);
    const s = await f.provider.catalogs.accessSnapshot({ account_id: A, bc_id: B, resource_kind: 'catalog_creation' });expect(s.grant.scope).toEqual(creation);expect(s.grant.mode).toBe('none');
  });
  it('delegates creation through the owner/local guarded access tool without native writes and revokes it without native credentials', async () => {
    const f = await setup(false), tools = tiktokTools(f.provider, { catalogAccessManagement: true }), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools }] });
    const args = { account_id: A, bc_id: B, resource_kind: 'catalog_creation', mode: 'create', expected_access_hash: catalogGrant(creation).hash }, preview = await runtime.registry.call('tiktok_set_catalog_access', args, runtime.ctx) as Row;expect(JSON.stringify(preview)).toContain('Existing catalogs are excluded');expect(f.writes()).toHaveLength(0);expect(f.calls.every(c => c.url.pathname.endsWith('/catalog/available_country/get/'))).toBe(true);
    await runtime.registry.call('tiktok_set_catalog_access', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);const granted = await f.store.get(creation);expect(granted.mode).toBe('create');f.calls.length = 0;
    const revoke = { ...args, mode: 'none', expected_access_hash: granted.hash }, pending = await runtime.registry.call('tiktok_set_catalog_access', revoke, runtime.ctx) as Row;await runtime.registry.call('tiktok_set_catalog_access', { ...revoke, pending_operation_id: pending.pending_operation_id }, runtime.ctx);expect(f.calls).toHaveLength(0);
  });
  it('rejects arbitrary creation/catalog scope-mode combinations', async () => {
    const f = await setup();for (const payload of [{ bc_id: B, mode: 'create' }, { bc_id: B, catalog_id: OLD, mode: 'create' }, { bc_id: B, resource_kind: 'catalog_creation', catalog_id: OLD, mode: 'create' }, { bc_id: B, resource_kind: 'catalog_creation', mode: 'write' }]) await expect(f.provider.previewWrite({ tool: 'tiktok_set_catalog_access', provider: 'tiktok', accountId: A, kind: 'update', payload: { ...payload, expected_access_hash: 'a'.repeat(64) } }, guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('creates and independently verifies only the returned catalog before adopting exact project write access', async () => {
    const f = await setup(), args = await f.args(), op = f.op('tiktok_create_catalog', args);expect(await f.provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false, review: { title: 'Create catalog' } });expect(f.writes()).toHaveLength(0);
    const result = await f.provider.applyWrite(op, guard);expect(result).toMatchObject({ resourceIds: [C], details: { configuration_readback: 'VERIFIED', project_catalog_access: 'write', ads_created: false } });expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toEqual({ bc_id: B, name: args.name, catalog_type: 'ECOM', catalog_conf: args.catalog_conf });expect(f.writes()[0]!.url.pathname).toBe('/open_api/v1.3/catalog/create/');
    await expect(requireCatalogAccess(f.store, { accountId: A, businessId: B, resourceId: C, kind: 'catalog' }, true)).resolves.toMatchObject({ mode: 'write', revision: 1 });await expect(requireCatalogAccess(f.store, { accountId: A, businessId: B, resourceId: '999', kind: 'catalog' })).rejects.toThrow();expect(f.calls.filter(c => c.url.pathname.endsWith('/catalog/get/')).every(c => c.url.searchParams.get('catalog_id') === C)).toBe(true);
  });
  it.each(['ECOM', 'HOTEL', 'FLIGHT', 'DESTINATION', 'ENTERTAINMENT', 'AUTO_VEHICLE', 'AUTO_MODEL', 'MINI_SERIES', 'GENERIC', 'ONLINE_TO_OFFLINE'])('supports the documented %s structural creation contract', async type => {
    const f = await setup(), conf = { currency: type === 'ONLINE_TO_OFFLINE' ? 'VND' : 'EUR', region_code: type === 'ONLINE_TO_OFFLINE' ? 'VN' : 'DE', ...(['ECOM', 'HOTEL', 'FLIGHT', 'DESTINATION'].includes(type) ? { is_multi_country: false } : {}) };await f.provider.applyWrite(f.op('tiktok_create_catalog', await f.args({ catalog_type: type, catalog_conf: conf })), guard);expect(f.writes()[0]!.body!.catalog_type).toBe(type);
  });
  it('supports explicit multi-country creation and unordered MINI_SERIES additional-region readback', async () => {
    for (const catalog of [{ catalog_type: 'HOTEL', catalog_conf: { currency: 'EUR', is_multi_country: true } }, { catalog_type: 'MINI_SERIES', catalog_conf: { currency: 'EUR', region_code: 'DE', additional_config_list: [{ region_code: 'US', currency: 'USD' }, { region_code: 'GB', currency: 'GBP' }] } }]) { const f = await setup();await f.provider.applyWrite(f.op('tiktok_create_catalog', await f.args(catalog)), guard);expect(f.writes()).toHaveLength(1); }
  });
  it.each([{ catalog_conf: { currency: 'EUR' } }, { catalog_conf: { currency: 'EUR', region_code: 'DE' } }, { catalog_conf: { currency: 'EUR', region_code: 'DE', is_multi_country: true } }, { catalog_type: 'GENERIC', catalog_conf: { currency: 'EUR', region_code: 'DE', is_multi_country: false } }, { catalog_type: 'MINI_SERIES', catalog_conf: { currency: 'EUR', region_code: 'DE', additional_config_list: [{ region_code: 'DE', currency: 'EUR' }] } }, { catalog_conf: { currency: 'EUR', region_code: 'ZZ', is_multi_country: false } }, { acknowledge_new_catalog_management: false }])('rejects invalid immutable configuration or unacknowledged adoption: %j', async patch => {
    const f = await setup();await expect(f.provider.previewWrite(f.op('tiktok_create_catalog', await f.args(patch)), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it.each(['grant', 'regions'])('rejects stale %s context before native submission', async mode => {
    const f = await setup(), args = await f.args();if (mode === 'grant') await f.store.compareAndSet(creation, (await f.store.get(creation)).hash, 'none');else f.state.regions.push('FR');await expect(f.provider.applyWrite(f.op('tiktok_create_catalog', args), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it.each(['wrong-name', 'wrong-bc', 'wrong-config', 'readback', 'revoke', 'transport', 'native', 'unsafe-id'])('never adopts or replays an unconfirmed creation: %s', async failure => {
    const f = await setup(), op = f.op('tiktok_create_catalog', await f.args());f.state.failure = failure;if (failure === 'unsafe-id') f.state.receiptId = 9007199254740992;let caught: unknown;try { await f.provider.applyWrite(op, guard); } catch (e) { caught = e; }expect(caught).toBeInstanceOf(Error);expect(String(caught)).not.toContain('PRIVATE-');expect(f.writes()).toHaveLength(1);expect((await f.store.get({ accountId: A, businessId: B, resourceId: C, kind: 'catalog' })).mode).toBe('none');if (!['unsafe-id', 'transport', 'native'].includes(failure)) expect(caught).toMatchObject({ details: { resourceIds: [C] } });
  });
  it('does not overwrite existing/tombstoned child decisions or retry adoption, and revoking creation leaves adopted grants independent', async () => {
    const f = await setup(), scope = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const }, delegation = await f.store.get(creation);await f.store.compareAndSet(scope, catalogGrant(scope).hash, 'none');await expect(f.store.adoptCreated(scope, delegation.hash)).rejects.toThrow('changed');
    const fresh = { ...scope, resourceId: '999' };await f.store.adoptCreated(fresh, delegation.hash);await expect(f.store.adoptCreated(fresh, delegation.hash)).rejects.toThrow('changed');await f.store.compareAndSet(creation, delegation.hash, 'none');expect((await f.store.get(fresh)).mode).toBe('write');
  });
  it('keeps creation in the shared token/hash/audit path and consumes a successful approval once', async () => {
    const f = await setup(), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] }), args = { account_id: A, ...await f.args() }, preview = await runtime.registry.call('tiktok_create_catalog', args, runtime.ctx) as Row;
    await expect(runtime.registry.call('tiktok_create_catalog', { ...args, name: 'Different', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.writes()).toHaveLength(0);await runtime.registry.call('tiktok_create_catalog', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);await expect(runtime.registry.call('tiktok_create_catalog', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(f.writes()).toHaveLength(1);const logs = (await Promise.all((await readdir(join(f.dir, 'audit'))).map(file => readFile(join(f.dir, 'audit', file), 'utf8')))).join('\n');expect(logs).toContain('tiktok_create_catalog');expect(logs).not.toContain('PRIVATE-');
  });
});

describe('permanent catalog deletion', () => {
  it('requires a writable exact grant, snapshot, exact name and whole-contents acknowledgement', async () => {
    const f = await setup(), args = await f.deletion();for (const patch of [{ confirm_catalog_name: 'other' }, { expected_configuration_hash: 'a'.repeat(64) }, { acknowledge_delete_products_and_feeds: false }]) await expect(f.provider.previewWrite(f.op('tiktok_delete_catalog', { ...args, ...patch }), guard)).rejects.toThrow();const op = f.op('tiktok_delete_catalog', args), preview = await f.provider.previewWrite(op, guard);expect(JSON.stringify(preview)).toContain('not enumerated or frozen');expect(f.writes()).toHaveLength(0);expect(await f.provider.applyWrite(op, guard)).toMatchObject({ resourceIds: [OLD], details: { resource_grant_retained: true, deletion_readback: 'ABSENT_FROM_FILTERED_CATALOG_VIEW' } });expect(f.writes()[0]!.body).toEqual({ bc_id: B, catalog_id: OLD });expect((await f.store.get(f.oldScope)).mode).toBe('write');
  });
  it.each(['remains', 'wrong-receipt', 'denied-absence', 'contradictory-absence', 'native', 'transport'])('does not treat %s as deletion success or replay', async failure => {
    const f = await setup(), op = f.op('tiktok_delete_catalog', await f.deletion());f.state.failure = failure;await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ details: { resourceIds: [OLD] } });expect(f.writes()).toHaveLength(1);
  });
  it('rechecks grant revocation and configuration before deleting', async () => {
    const f = await setup(), op = f.op('tiktok_delete_catalog', await f.deletion());await f.store.compareAndSet(f.oldScope, (await f.store.get(f.oldScope)).hash, 'read');await expect(f.provider.applyWrite(op, guard)).rejects.toThrow('write access');expect(f.writes()).toHaveLength(0);
  });
});
