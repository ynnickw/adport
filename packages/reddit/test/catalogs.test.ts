import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { RedditAdsClient } from '../src/client.js';
import { RedditAdsProvider } from '../src/provider.js';
import { redditTools } from '../src/tools.js';
import { FileRedditCatalogAccessStore, catalogGrant, creationScope, requireCatalogAccess } from '../src/catalog-access.js';

// Official v3 OpenAPI refreshed 2026-11-05: https://ads-api.reddit.com/api/v3/openapi.json
// Business-scoped catalog POST201; account-less GET/PATCH; DELETE204 then GET404.
const A = 'a2_syntheticqa1', B = '1e200a0b-4e98-32cc-dd47-3006e4c85bb2', OTHER = '99999999-9999-9999-9999-999999999999', C = 'catalog_qa', NEW = 'catalog_new', P = 'pixel_qa', Q = 'pixel_other';
const scope = { account_id: A, business_id: B, catalog_id: C }, resource = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const }, delegation = creationScope(A, B), guard = { forcePausedCreation: true };
type Row = Record<string, any>;
const dirs: string[] = [];afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function setup(mode: 'none' | 'read' | 'write' = 'write', delegate = true) {
  const dir = await mkdtemp(join(tmpdir(), 'adport-reddit-catalog-'));dirs.push(dir);const store = new FileRedditCatalogAccessStore(join(dir, 'grants'));if (mode !== 'none') await store.compareAndSet(resource, catalogGrant(resource).hash, mode);if (delegate) await store.compareAndSet(delegation, catalogGrant(delegation).hash, 'create');
  const state = { catalogs: [{ id: C, business_id: B, name: 'Catalog <script>', default_currency: 'EUR', default_language: 'de', event_sources: [P], summary: { products_count: 10 }, created_at: 'volatile', unknown_private: 'PRIVATE-UNKNOWN' }] as Row[], pixels: [{ id: P, ad_account_id: A, script: 'PRIVATE-PIXEL-SCRIPT' }, { id: Q, ad_account_id: A }] as Row[], business: { id: B, name: 'Business QA', phone: 'PRIVATE-PHONE' }, failure: '', receiptId: NEW, mutations: 0 };
  const calls: Array<{ url: URL; init: RequestInit; body?: Row }> = [];
  const client = new RedditAdsClient({ clientId: 'inert-client', clientSecret: 'inert-secret', refreshToken: 'inert-refresh', userAgent: 'desktop:adport:qa (by /u/qa)' }, async (raw, init = {}) => {
    const url = new URL(String(raw));if (url.pathname === '/api/v1/access_token') return Response.json({ access_token: 'inert-access', expires_in: 3600 });const body = init.body ? JSON.parse(String(init.body)) : undefined;calls.push({ url, init, body });const ok = (data: unknown, status = 200) => Response.json({ data }, { status });
    if (init.method === 'GET') {
      if (url.pathname === '/api/v3/businesses/' + B) return ok(state.business);
      if (url.pathname === '/api/v3/ad_accounts/' + A + '/pixels') return ok(state.pixels);
      if (url.pathname.startsWith('/api/v3/product_catalogs/')) {
        if (state.failure === 'readback' && state.mutations || state.failure === 'denied-absence' && !state.catalogs.length) return Response.json({ message: 'PRIVATE-BODY' }, { status: 403 });
        const row = state.catalogs.find(row => row.id === url.pathname.split('/').at(-1));return row ? ok(row) : Response.json({ message: 'Not found' }, { status: 404 });
      }
    }
    if (['POST', 'PATCH', 'DELETE'].includes(init.method!)) {
      state.mutations++;if (state.failure === 'transport') throw new Error('PRIVATE-TRANSPORT');if (state.failure === 'native') return Response.json({ message: 'PRIVATE-BODY' }, { status: 403 });
      if (url.pathname === '/api/v3/businesses/' + B + '/product_catalogs') { const row = { id: state.receiptId, business_id: B, ...body.data };if (state.failure === 'wrong-parent') row.business_id = OTHER;if (state.failure === 'wrong-config') row.default_currency = 'USD';state.catalogs.push(row);if (state.failure === 'revoke') await store.compareAndSet(delegation, (await store.get(delegation)).hash, 'none');return ok(state.failure === 'receipt-shape' ? { id: row.id } : row, 201); }
      const row = state.catalogs.find(row => row.id === url.pathname.split('/').at(-1))!;if (init.method === 'PATCH') { Object.assign(row, body.data);if (state.failure === 'lost-default') row.default_currency = 'USD';return ok(row); }
      if (init.method === 'DELETE') { if (state.failure !== 'remains') state.catalogs = state.catalogs.filter(row => row !== undefined && row.id !== C);return new Response(null, { status: 204 }); }
    }
    throw new Error('Unexpected fixture endpoint');
  });
  const provider = new RedditAdsProvider(client, undefined, store), reads = () => calls.filter(c => c.init.method === 'GET'), writes = () => calls.filter(c => c.init.method !== 'GET');
  const creationArgs = async (ids = [P]) => { const c = await provider.catalogs.creationContext({ account_id: A, business_id: B, event_sources: ids });return { business_id: B, name: 'New catalog', default_language: 'de', default_currency: 'EUR', event_sources: ids, expected_creation_access_hash: c.expected_creation_access_hash, expected_event_sources_hash: c.expected_event_sources_hash, acknowledge_new_catalog_management: true }; };
  const renameArgs = async () => ({ business_id: B, catalog_id: C, name: 'Changed', expected_configuration_hash: (await provider.catalogs.get(scope)).catalog.configuration_hash, acknowledge_shared_effects: true });
  const sourceArgs = async (ids = [Q]) => { const c = await provider.catalogs.sourceContext({ ...scope, event_sources: ids });return { business_id: B, catalog_id: C, event_sources: ids, expected_configuration_hash: c.expected_configuration_hash, expected_event_sources_hash: c.expected_event_sources_hash, acknowledge_shared_effects: true, acknowledge_measurement_effects: true }; };
  const deleteArgs = async () => ({ business_id: B, catalog_id: C, expected_configuration_hash: (await provider.catalogs.get(scope)).catalog.configuration_hash, confirm_catalog_name: 'Catalog <script>', acknowledge_shared_effects: true, acknowledge_delete_contents: true });
  const op = (tool: string, payload: Row): WriteOperation => ({ tool, provider: 'reddit', accountId: A, kind: tool === 'reddit_create_catalog' ? 'create' : tool === 'reddit_delete_catalog' ? 'remove' : 'update', payload });
  return { dir, store, state, client, provider, calls, reads, writes, creationArgs, renameArgs, sourceArgs, deleteArgs, op };
}

describe('Reddit Business catalog scope and configuration', () => {
  it('defines eight public typed workflows once and omits permission administration from normal runtimes', async () => {
    const f = await setup(), tools = redditTools(f.provider);expect(new Set(tools.map(t => t.name)).size).toBe(tools.length);for (const name of ['reddit_catalog_access', 'reddit_get_catalog', 'reddit_catalog_creation_context', 'reddit_catalog_event_source_context', 'reddit_create_catalog', 'reddit_rename_catalog', 'reddit_set_catalog_event_sources', 'reddit_delete_catalog']) expect(tools.find(t => t.name === name)).toBeDefined();expect(tools.find(t => t.name === 'reddit_set_catalog_access')).toBeUndefined();expect(tools.find(t => t.name === 'reddit_create_catalog')!.annotations).toMatchObject({ readOnly: false, destructive: false });expect(tools.find(t => t.name === 'reddit_rename_catalog')!.annotations.destructive).toBe(false);expect(tools.find(t => t.name === 'reddit_set_catalog_event_sources')!.annotations.destructive).toBe(true);
  });
  it('does not infer Business catalog access from enabled-account state or creation delegation', async () => {
    const f = await setup('none');await expect(f.provider.catalogs.get(scope)).rejects.toThrow('access');expect(f.calls).toHaveLength(0);await f.provider.catalogs.creationContext({ account_id: A, business_id: B });expect(f.calls.some(c => c.url.pathname.includes('product_catalogs'))).toBe(false);
  });
  it('accepts the official UUID-shaped Business example without inventing RFC UUID version constraints and strips unknown/private fields', async () => {
    const f = await setup(), result = await f.provider.catalogs.get(scope);expect(result.catalog.business_id).toBe(B);expect(JSON.stringify(result)).not.toContain('PRIVATE-');expect(result.records[0]!.products).toBe(10);delete f.state.catalogs[0]!.summary;expect((await f.provider.catalogs.get(scope)).records[0]!.products).toBeUndefined();
  });
  it('binds configuration hashes to exact scope and configuration, excluding volatile native counts/timestamps', async () => {
    const f = await setup(), first = (await f.provider.catalogs.get(scope)).catalog.configuration_hash;f.state.catalogs[0]!.summary.products_count = 99;f.state.catalogs[0]!.modified_at = 'changed';expect((await f.provider.catalogs.get(scope)).catalog.configuration_hash).toBe(first);f.state.catalogs[0]!.event_sources = [Q];expect((await f.provider.catalogs.get(scope)).catalog.configuration_hash).not.toBe(first);
  });
  it.each([{ business_id: OTHER }, { id: 'other' }, { id: 9007199254740992 }])('rejects mismatched native scope/ID %j', async patch => {
    const f = await setup();Object.assign(f.state.catalogs[0]!, patch);await expect(f.provider.catalogs.get(scope)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('keeps mutation previews unavailable under resource-read-only grants', async () => {
    const f = await setup('read'), args = await f.renameArgs();await expect(f.provider.previewWrite(f.op('reddit_rename_catalog', args), guard)).rejects.toThrow('write access');expect(f.writes()).toHaveLength(0);
  });
  it('uses guarded owner-only grant changes and allows revocation without native credentials', async () => {
    const f = await setup('none', false), tools = redditTools(f.provider, { catalogAccessManagement: true }), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools }] });
    const snapshot = await f.provider.catalogs.snapshot({ account_id: A, business_id: B, resource_kind: 'catalog_creation' }), args = { account_id: A, business_id: B, resource_kind: 'catalog_creation', mode: 'create', expected_access_hash: snapshot.grant.hash }, preview = await runtime.registry.call('reddit_set_catalog_access', args, runtime.ctx) as Row;expect(f.writes()).toHaveLength(0);expect(f.reads().every(c => c.url.pathname === '/api/v3/businesses/' + B)).toBe(true);await runtime.registry.call('reddit_set_catalog_access', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);const granted = await f.store.get(delegation);f.calls.length = 0;
    const revoke = { ...args, mode: 'none', expected_access_hash: granted.hash }, pending = await runtime.registry.call('reddit_set_catalog_access', revoke, runtime.ctx) as Row;await runtime.registry.call('reddit_set_catalog_access', { ...revoke, pending_operation_id: pending.pending_operation_id }, runtime.ctx);expect(f.calls).toHaveLength(0);
  });
  it('rejects catalog/creation permission confusion and unsafe selectors', async () => {
    const f = await setup();for (const change of [{ business_id: 'not-a-business' }, { resource_kind: 'catalog_creation', catalog_id: C }, { resource_kind: 'catalog_creation', mode: 'write' }]) await expect(f.provider.previewWrite(f.op('reddit_set_catalog_access', { business_id: B, mode: 'create', expected_access_hash: 'a'.repeat(64), ...change }), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
});

describe('Reddit catalog creation and exact new-ID adoption', () => {
  it('verifies creation defaults/Pixels and independently reads back before adopting the new native ID', async () => {
    const f = await setup(), args = await f.creationArgs(), op = f.op('reddit_create_catalog', args), preview = await f.provider.previewWrite(op, guard);expect(preview.review?.title).toBe('Create catalog');expect(JSON.stringify(preview)).not.toContain('PRIVATE-');expect(f.writes()).toHaveLength(0);await f.provider.applyWrite(op, guard);expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.url.pathname).toBe('/api/v3/businesses/' + B + '/product_catalogs');expect(f.writes()[0]!.body).toEqual({ data: { name: args.name, default_language: 'de', default_currency: 'EUR', event_sources: [P] } });await expect(requireCatalogAccess(f.store, { ...resource, resourceId: NEW }, true)).resolves.toMatchObject({ mode: 'write', revision: 1 });expect(f.calls.some(c => c.url.pathname === '/api/v3/businesses/' + B + '/product_catalogs' && c.init.method === 'GET')).toBe(false);
  });
  it('supports explicit empty event-source creation without inventing Pixel lookups', async () => {
    const f = await setup(), args = await f.creationArgs([]);f.calls.length = 0;await f.provider.applyWrite(f.op('reddit_create_catalog', args), guard);expect(f.calls.some(c => c.url.pathname.endsWith('/pixels'))).toBe(false);expect(f.writes()[0]!.body!.data.event_sources).toEqual([]);
  });
  it.each(['missing', 'foreign', 'duplicate'])('rejects %s selected-account Pixel proof', async mode => {
    const f = await setup();if (mode === 'missing') f.state.pixels = [];if (mode === 'foreign') f.state.pixels[0]!.ad_account_id = 'a2_other';if (mode === 'duplicate') f.state.pixels.push(f.state.pixels[0]!);await expect(f.creationArgs()).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('does not adopt a pre-existing or tombstoned child grant or retain a revoked delegation', async () => {
    const f = await setup(), newScope = { ...resource, resourceId: NEW };await f.store.compareAndSet(newScope, catalogGrant(newScope).hash, 'none');await expect(f.provider.applyWrite(f.op('reddit_create_catalog', await f.creationArgs()), guard)).rejects.toMatchObject({ details: { resourceIds: [NEW] } });expect((await f.store.get(newScope)).mode).toBe('none');
    const current = await f.store.get(delegation);await f.store.compareAndSet(delegation, current.hash, 'none');await expect(f.provider.catalogs.creationContext({ account_id: A, business_id: B })).rejects.toThrow('delegate');
  });
  it.each(['native', 'transport', 'wrong-parent', 'wrong-config', 'readback', 'revoke', 'receipt-shape'])('never replays or adopts an unconfirmed create: %s', async failure => {
    const f = await setup(), op = f.op('reddit_create_catalog', await f.creationArgs());f.state.failure = failure;let caught: unknown;try { await f.provider.applyWrite(op, guard); } catch (e) { caught = e; }expect(caught).toBeInstanceOf(Error);expect(String(caught)).not.toContain('PRIVATE-');expect(f.writes()).toHaveLength(1);expect((await f.store.get({ ...resource, resourceId: NEW })).mode).toBe('none');if (!['native', 'transport'].includes(failure)) expect(caught).toMatchObject({ details: { resourceIds: [NEW] } });
  });
  it('rejects stale creation delegation before native POST', async () => {
    const f = await setup(), args = await f.creationArgs();await f.store.compareAndSet(delegation, (await f.store.get(delegation)).hash, 'none');await expect(f.provider.applyWrite(f.op('reddit_create_catalog', args), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
});

describe('Reddit catalog rename, source replacement and permanent deletion', () => {
  it('PATCHes only name and independently verifies defaults and event-source preservation', async () => {
    const f = await setup(), op = f.op('reddit_rename_catalog', await f.renameArgs());expect((await f.provider.previewWrite(op, guard)).review?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Name', before: 'Catalog <script>', after: 'Changed' })]));await f.provider.applyWrite(op, guard);expect(f.writes()[0]!.body).toEqual({ data: { name: 'Changed' } });expect(f.state.catalogs[0]!.default_currency).toBe('EUR');expect(f.state.catalogs[0]!.event_sources).toEqual([P]);
  });
  it.each([{ ids: [Q] }, { ids: [] }])('replaces the complete event-source list with %j under selected-account proof', async ({ ids }) => {
    const f = await setup(), args = await f.sourceArgs(ids);await f.provider.applyWrite(f.op('reddit_set_catalog_event_sources', args), guard);expect(f.writes()[0]!.body).toEqual({ data: { event_sources: ids } });expect(f.state.catalogs[0]!.name).toBe('Catalog <script>');
  });
  it('does not infer missing native source configuration as an empty list', async () => {
    const f = await setup();delete f.state.catalogs[0]!.event_sources;expect((await f.provider.catalogs.get(scope)).records[0]!.event_source_count).toBeUndefined();await expect(f.sourceArgs()).rejects.toThrow('unavailable');await expect(f.provider.previewWrite(f.op('reddit_rename_catalog', await f.renameArgs()), guard)).rejects.toThrow('unavailable');expect(f.writes()).toHaveLength(0);
  });
  it('rejects source-context scope confusion and stale catalog snapshots', async () => {
    const f = await setup(), args = await f.sourceArgs();args.expected_event_sources_hash = (await f.provider.catalogs.creationContext({ account_id: A, business_id: B, event_sources: [Q] })).expected_event_sources_hash;await expect(f.provider.previewWrite(f.op('reddit_set_catalog_event_sources', args), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });const rename = await f.renameArgs();f.state.catalogs[0]!.name = 'Other';await expect(f.provider.applyWrite(f.op('reddit_rename_catalog', rename), guard)).rejects.toThrow('changed');expect(f.writes()).toHaveLength(0);
  });
  it('rejects a successful PATCH whose independent preserved defaults differ', async () => {
    const f = await setup(), op = f.op('reddit_rename_catalog', await f.renameArgs());f.state.failure = 'lost-default';await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ details: { resourceIds: [C] } });expect(f.writes()).toHaveLength(1);
  });
  it('requires exact name/contents acknowledgement then verifies DELETE204 and exact GET404 without Business enumeration', async () => {
    const f = await setup(), args = await f.deleteArgs();for (const patch of [{ confirm_catalog_name: 'Other' }, { acknowledge_delete_contents: false }]) await expect(f.provider.previewWrite(f.op('reddit_delete_catalog', { ...args, ...patch }), guard)).rejects.toThrow();const op = f.op('reddit_delete_catalog', args);expect(JSON.stringify(await f.provider.previewWrite(op, guard))).toContain('not enumerated or frozen');await f.provider.applyWrite(op, guard);expect(f.writes()[0]!.init.method).toBe('DELETE');expect(f.writes()[0]!.body).toBeUndefined();expect(f.reads().every(c => c.url.pathname === '/api/v3/product_catalogs/' + C)).toBe(true);expect((await f.store.get(resource)).mode).toBe('write');
  });
  it.each(['remains', 'native', 'transport', 'denied-absence'])('does not turn %s into confirmed deletion or replay', async failure => {
    const f = await setup(), op = f.op('reddit_delete_catalog', await f.deleteArgs());f.state.failure = failure;await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ details: { resourceIds: [C] } });expect(f.writes()).toHaveLength(1);
  });
  it('uses exact shared pending arguments, consumes successful approval once and omits native private fields from audit', async () => {
    const f = await setup(), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: redditTools(f.provider) }] }), args = { account_id: A, ...await f.renameArgs() }, preview = await runtime.registry.call('reddit_rename_catalog', args, runtime.ctx) as Row;expect(preview.preview.review.title).toBe('Rename catalog');await expect(runtime.registry.call('reddit_rename_catalog', { ...args, name: 'Different', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });await runtime.registry.call('reddit_rename_catalog', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);await expect(runtime.registry.call('reddit_rename_catalog', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(f.writes()).toHaveLength(1);const logs = (await Promise.all((await readdir(join(f.dir, 'audit'))).map(file => readFile(join(f.dir, 'audit', file), 'utf8')))).join('\n');expect(logs).not.toContain('PRIVATE-');
  });
});
