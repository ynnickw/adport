import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTikTokCatalogAccessStore, catalogGrant } from '../src/catalog-access.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// Fresh official contracts 2026-11-05: eventsource_bind/get 1740492531343362,
// eventsource/{bind,unbind} 1740492491200513/1740492512449538,
// app/{list,info} 1740859313270786/1740859272887297 and pixel/list 1740858697598978.
const A = '7111000000000000001', B = '111', C = '222', APP = '9007199254740993', PIXEL = 'C_NATIVE_PIXEL', OLD = '666';
const scope = { account_id: A, bc_id: B, catalog_id: C }, grantScope = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const }, selected = { app_id: APP, pixel_code: PIXEL }, guard = { forcePausedCreation: true };
type Row = Record<string, any>;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(mode: 'none' | 'read' | 'write' = 'write') {
  const dir = await mkdtemp(join(tmpdir(), 'adport-catalog-event-'));dirs.push(dir);const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));if (mode !== 'none') await store.compareAndSet(grantScope, catalogGrant(grantScope).hash, mode);
  const state = { parent: { catalog_id: C, catalog_name: 'Catalog QA', catalog_type: 'ECOM', bc_info: { bc_id: B }, catalog_conf: { currency: 'EUR' } }, bindings: [{ app_id: OLD, pixel_code: null, event_source_name: 'Existing app' }] as Row[],
    apps: [APP, OLD, '777'].map(id => ({ app_id: id, advertiser_id: A, app_name: 'App <script>' + id, app_platform_id: 'com.example.' + id, platform: 'ANDROID', partner: { partner_token: 'PRIVATE-PARTNER' }, tracking_url: { click_url: 'https://tracking.example/?token=PRIVATE-TRACKING' } })) as Row[],
    pixel: { pixel_id: '42', pixel_code: PIXEL, pixel_name: 'Pixel QA', advertiser_id: A, asset_ownership: { asset_relation_status: 'SHARED', ownership_status: false, owner_bc_id: null, updated_at: 22 }, advanced_matching_fields: { email: true, phone_number: false }, pixel_script: '<script>PRIVATE-SCRIPT</script>', events: [{ rules: [{ value: 'PRIVATE-RULE' }] }] } as Row,
    pixelPage: { page: 1, page_size: 20, total_page: 1, total_number: 1 } as Row | undefined, failure: '', override: undefined as ((url: URL, body: Row | undefined) => unknown) | undefined };
  const calls: Array<{ url: URL; init: RequestInit; body?: Row }> = [], writes = () => calls.filter(c => c.init.method === 'POST');
  const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert-token' }, async (raw, init = {}) => {
    const url = new URL(String(raw)), body = init.body ? JSON.parse(String(init.body)) : undefined;calls.push({ url, init, body });const ok = (data: unknown) => Response.json({ code: 0, data }), override = state.override?.(url, body);if (override !== undefined) return override instanceof Response ? override : ok(override);
    if (state.failure === 'denied') return Response.json({ code: 40001, message: 'PRIVATE-PROVIDER-BODY', request_id: 'request_qa' });
    if (url.pathname.endsWith('/catalog/get/')) return ok({ list: [state.parent] });
    if (url.pathname.endsWith('/catalog/eventsource_bind/get/')) { if (state.failure === 'readback' && writes().length) throw new Error('PRIVATE-URL');return ok({ catalog_id: C, event_sources: state.bindings }); }
    if (url.pathname.endsWith('/app/list/')) { const filter = url.searchParams.has('app_platform_ids') ? JSON.parse(url.searchParams.get('app_platform_ids')!) : undefined;return ok({ apps: state.apps.filter(row => !filter || filter.includes(row.app_platform_id)) }); }
    if (url.pathname.endsWith('/app/info/')) return ok({ app: state.apps.find(row => row.app_id === url.searchParams.get('app_id')) });
    if (url.pathname.endsWith('/pixel/list/')) return ok({ pixels: state.failure === 'missing-pixel' ? [] : [state.pixel], ...(state.pixelPage ? { page_info: state.pixelPage } : {}) });
    if (init.method === 'POST') {
      if (state.failure === 'transport') throw new Error('PRIVATE-PROVIDER-BODY');if (state.failure === 'native') return Response.json({ code: 40001, message: 'PRIVATE-PROVIDER-BODY', request_id: 'request_qa' });
      if (state.failure !== 'no-change') {
        if (url.pathname.endsWith('/catalog/eventsource/bind/')) { if (body.app_id) state.bindings.push({ app_id: body.app_id, pixel_code: null, event_source_name: 'New app' });if (body.pixel_code && state.failure !== 'partial') state.bindings.push({ app_id: null, pixel_code: body.pixel_code, event_source_name: 'New Pixel' }); }
        else if (url.pathname.endsWith('/catalog/eventsource/unbind/')) state.bindings = state.bindings.flatMap(row => { const next = { ...row };if (row.app_id === body.app_id) next.app_id = null;if (row.pixel_code === body.pixel_code && state.failure !== 'partial') next.pixel_code = null;return next.app_id || next.pixel_code ? [next] : []; });
        else throw new Error('Unexpected fixture mutation');
        if (state.failure === 'lost-other') state.bindings = state.bindings.filter(row => row.app_id !== OLD);
      }
      return ok(state.failure === 'bad-receipt' ? [] : {});
    }
    throw new Error('Unexpected fixture endpoint');
  }), { appId: 'inert', secret: 'inert' }, undefined, store);
  const context = (purpose: 'bind' | 'unbind' = 'bind', sources = selected) => provider.catalogs.eventSources.context({ ...scope, ...sources, purpose });
  const args = async (purpose: 'bind' | 'unbind' = 'bind', sources = selected) => { const c = await context(purpose, sources);return { bc_id: B, catalog_id: C, ...sources, expected_catalog_hash: c.expected_catalog_hash, expected_bindings_hash: c.expected_bindings_hash, expected_sources_hash: c.expected_sources_hash, acknowledge_shared_effects: true, acknowledge_measurement_effects: true }; };
  const op = (purpose: 'bind' | 'unbind', payload: Row): WriteOperation => ({ tool: purpose === 'bind' ? 'tiktok_bind_catalog_event_sources' : 'tiktok_unbind_catalog_event_sources', provider: 'tiktok', accountId: A, kind: purpose === 'bind' ? 'update' : 'remove', payload });
  const addSelected = () => state.bindings.push({ app_id: APP, pixel_code: PIXEL, event_source_name: 'Grouped native row' });
  return { dir, store, state, provider, calls, writes, context, args, op, addSelected };
}

describe('TikTok catalog source discovery and scope', () => {
  it('defines five specialist tools once with typed read/write hints', async () => {
    const f = await setup(), tools = tiktokTools(f.provider), names = ['tiktok_catalog_event_sources', 'tiktok_catalog_event_source_apps', 'tiktok_catalog_event_source_context', 'tiktok_bind_catalog_event_sources', 'tiktok_unbind_catalog_event_sources'];expect(new Set(tools.map(t => t.name)).size).toBe(tools.length);
    for (const name of names) expect(tools.find(t => t.name === name)!.catalog).toEqual({ category: 'measurement', exposure: 'specialist' });
    for (const name of names.slice(3)) expect(tools.find(t => t.name === name)!.annotations).toMatchObject({ readOnly: false, destructive: true });
  });
  it('reads catalog-level bindings with the native underscore path and hashes scoped identities', async () => {
    const f = await setup(), first = await f.provider.catalogs.eventSources.list(scope);expect(first).toMatchObject({ event_sources: [{ type: 'APP', id: OLD }], complete: true, truncated: false, total_in_response: 1 });const url = f.calls.at(-1)!.url;expect(url.pathname).toBe('/open_api/v1.3/catalog/eventsource_bind/get/');expect(Object.fromEntries(url.searchParams)).toEqual({ bc_id: B, catalog_id: C });
    f.state.bindings[0]!.event_source_name = 'Rename';expect((await f.provider.catalogs.eventSources.list(scope)).configuration_hash).toBe(first.configuration_hash);expect(f.writes()).toHaveLength(0);
  });
  it('normalizes a native row containing both source kinds without confusing App IDs and Pixel codes', async () => {
    const f = await setup();f.addSelected();const result = await f.provider.catalogs.eventSources.list(scope);expect(result.event_sources.map(row => [row.type, row.id])).toEqual([['APP', OLD], ['APP', APP], ['PIXEL', PIXEL]]);
  });
  it.each([{ catalog_id: '999' }, { catalog_id: 9007199254740992 }, { bc_id: '999' }, { event_sources: [{ app_id: null, pixel_code: null }] }, { event_sources: [{ app_id: OLD }, { app_id: OLD }] }, { event_sources: [{ app_id: -2 }] }])('rejects unsafe/foreign/ambiguous binding responses: %j', async changes => {
    const f = await setup();f.state.override = url => url.pathname.endsWith('/catalog/eventsource_bind/get/') ? { catalog_id: C, event_sources: f.state.bindings, ...changes } : undefined;await expect(f.provider.catalogs.eventSources.list(scope)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it.each(['none', 'read'] as const)('keeps %s resource grants from native writes', async mode => {
    const f = await setup(mode);if (mode === 'none') { await expect(f.provider.catalogs.eventSources.list(scope)).rejects.toThrow('access');expect(f.calls).toHaveLength(0); } else { const args = await f.args();await expect(f.provider.previewWrite(f.op('bind', args), guard)).rejects.toThrow('write access');expect(f.writes()).toHaveLength(0); }
  });
  it('discovers safe advertiser app summaries, exact platform-ID filters and locally bounded pagination', async () => {
    const f = await setup(), result = await f.provider.catalogs.eventSources.apps({ ...scope, page_size: 1 });expect(result).toMatchObject({ complete: false, truncated: true, total_in_response: 3 });expect(result.apps[0]!.app_id).toBe(OLD);expect(JSON.stringify(result)).not.toContain('PRIVATE-');expect(result).not.toHaveProperty('partner');
    const next = await f.provider.catalogs.eventSources.apps({ ...scope, page_size: 1, cursor: result.next_cursor });expect(next.apps[0]!.app_id).toBe('777');
    const filter = ['com.example.' + APP], filtered = await f.provider.catalogs.eventSources.apps({ ...scope, app_platform_ids: filter });expect(filtered.apps).toHaveLength(1);expect(JSON.parse(f.calls.at(-1)!.url.searchParams.get('app_platform_ids')!)).toEqual(filter);expect(f.calls.at(-1)!.url.searchParams.has('app_id')).toBe(false);
    f.state.apps[0]!.app_name = 'Changed';await expect(f.provider.catalogs.eventSources.apps({ ...scope, page_size: 1, cursor: result.next_cursor })).rejects.toThrow('first page');
  });
  it('binds local cursors to catalog/advertiser/filter and rejects malformed cursors', async () => {
    const f = await setup();f.addSelected();const page = await f.provider.catalogs.eventSources.list({ ...scope, page_size: 1 });for (const input of [{ ...scope, catalog_id: '333' }, scope]) { if (input.catalog_id !== C) f.state.parent.catalog_id = '333';else f.state.parent.catalog_id = C;await expect(f.provider.catalogs.eventSources.list({ ...input, cursor: input.catalog_id === C ? 'invalid' : page.next_cursor })).rejects.toThrow(); }
  });
  it.each([{ advertiser_id: '999' }, { app_id: 9007199254740992 }, { app_platform_id: '' }])('rejects foreign/unsafe app inventory fields: %j', async change => {
    const f = await setup();Object.assign(f.state.apps[0]!, change);await expect(f.provider.catalogs.eventSources.apps(scope)).rejects.toThrow();
  });
  it('scrubs native provider error bodies on discovery', async () => {
    const f = await setup();f.state.override = url => url.pathname.endsWith('/catalog/eventsource_bind/get/') ? Response.json({ code: 40001, message: 'PRIVATE-PROVIDER-BODY', request_id: 'request_qa' }) : undefined;let caught: unknown;try { await f.context(); } catch (e) { caught = e; }expect(caught).toMatchObject({ code: 'PROVIDER_ERROR', details: { provider_code: 40001, request_id: 'request_qa' } });expect(String(caught)).not.toContain('PRIVATE-');
  });
});

describe('TikTok catalog binding snapshots and native changes', () => {
  it('verifies native App IDs, advertiser Pixel code and catalog availability without returning tracking material', async () => {
    const f = await setup(), context = await f.context();expect(context.selected_sources.map(row => row.type)).toEqual(['APP', 'PIXEL']);expect(JSON.stringify(context)).not.toContain('PRIVATE-');
    const pixel = f.calls.find(c => c.url.pathname.endsWith('/pixel/list/'))!.url;expect(Object.fromEntries(pixel.searchParams)).toEqual({ advertiser_id: A, code: PIXEL, page: '1', page_size: '20', filtering: JSON.stringify({ available_for_catalog_only: true }) });
    expect(f.calls.find(c => c.url.pathname.endsWith('/app/info/'))!.url.searchParams.get('app_id')).toBe(APP);expect(f.writes()).toHaveLength(0);
  });
  it.each(['app-account', 'app-id', 'pixel-account', 'pixel-code', 'unbound', 'missing-pixel', 'ambiguous-page', 'zero-page'])('rejects unverified selected source %s', async mode => {
    const f = await setup();if (mode === 'app-account') f.state.apps[0]!.advertiser_id = '999';if (mode === 'app-id') f.state.apps[0]!.app_id = '999';if (mode === 'pixel-account') f.state.pixel.advertiser_id = '999';if (mode === 'pixel-code') f.state.pixel.pixel_code = 'OTHER';if (mode === 'unbound') f.state.pixel.asset_ownership.asset_relation_status = 'UNBOUND';if (mode === 'missing-pixel') f.state.failure = mode;if (mode === 'ambiguous-page') f.state.pixelPage!.total_page = 2;if (mode === 'zero-page') f.state.pixelPage!.total_page = 0;
    await expect(f.context()).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('requires explicit selectors/acknowledgements and rejects routing-field injection', async () => {
    const f = await setup(), args = await f.args();for (const change of [{ app_id: undefined, pixel_code: undefined }, { acknowledge_measurement_effects: undefined }, { acknowledge_shared_effects: false }, { advertiser_id: '999' }, { purpose: 'unbind' }, { pixel_code: 'space code' }]) await expect(f.provider.previewWrite(f.op('bind', { ...args, ...change }), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('binds app and Pixel together with one native write and preserves unrelated identities', async () => {
    const f = await setup(), op = f.op('bind', await f.args());expect(await f.provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false, review: { title: 'Bind catalog event sources', kind: 'update' } });expect(f.writes()).toHaveLength(0);
    expect(await f.provider.applyWrite(op, guard)).toMatchObject({ resourceIds: [C, APP, PIXEL] });expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.url.pathname).toBe('/open_api/v1.3/catalog/eventsource/bind/');expect(f.writes()[0]!.body).toEqual({ advertiser_id: A, bc_id: B, catalog_id: C, app_id: APP, pixel_code: PIXEL });expect(f.state.bindings.some(row => row.app_id === OLD)).toBe(true);
  });
  it('unbinds explicit sources while retaining unrelated bindings and checking Pixel access without the bind-only eligibility filter', async () => {
    const f = await setup();f.addSelected();const op = f.op('unbind', await f.args('unbind'));expect(await f.provider.previewWrite(op, guard)).toMatchObject({ review: { kind: 'remove' } });await f.provider.applyWrite(op, guard);
    expect(f.writes()[0]!.url.pathname).toBe('/open_api/v1.3/catalog/eventsource/unbind/');expect(f.state.bindings.map(row => row.app_id)).toEqual([OLD]);expect(f.calls.filter(c => c.url.pathname.endsWith('/pixel/list/')).every(c => !c.url.searchParams.has('filtering'))).toBe(true);
  });
  it.each([{ app_id: APP }, { pixel_code: PIXEL }])('supports single-source changes without synthesizing the other selector: %j', async sources => {
    const f = await setup(), context = await f.provider.catalogs.eventSources.context({ ...scope, ...sources });const args = { bc_id: B, catalog_id: C, ...sources, expected_catalog_hash: context.expected_catalog_hash, expected_bindings_hash: context.expected_bindings_hash, expected_sources_hash: context.expected_sources_hash, acknowledge_shared_effects: true, acknowledge_measurement_effects: true };await f.provider.applyWrite(f.op('bind', args), guard);expect(f.writes()[0]!.body).toEqual({ advertiser_id: A, bc_id: B, catalog_id: C, ...sources });
  });
  it('rejects no-ops, absent unbind targets and a context prepared for another purpose', async () => {
    const f = await setup();await expect(f.context('unbind')).rejects.toThrow('already be bound');const args = await f.args();f.addSelected();await expect(f.context()).rejects.toThrow('already bound');await expect(f.provider.applyWrite(f.op('unbind', args), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.writes()).toHaveLength(0);
  });
  it.each(['catalog', 'binding', 'source', 'grant'])('rechecks %s state before any native write', async mode => {
    const f = await setup(), op = f.op('bind', await f.args());if (mode === 'catalog') f.state.parent.catalog_name = 'Changed';if (mode === 'binding') f.state.bindings.push({ app_id: '888' });if (mode === 'source') f.state.pixel.advanced_matching_fields.email = false;if (mode === 'grant') await f.store.compareAndSet(grantScope, (await f.store.get(grantScope)).hash, 'read');await expect(f.provider.applyWrite(op, guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it.each(['transport', 'native', 'readback', 'lost-other', 'partial', 'no-change', 'bad-receipt'])('retains known IDs and never replays an unconfirmed bind (%s)', async failure => {
    const f = await setup(), op = f.op('bind', await f.args());f.state.failure = failure;let caught: unknown;try { await f.provider.applyWrite(op, guard); } catch (e) { caught = e; }expect(caught).toMatchObject({ details: { resourceIds: [C, APP, PIXEL] } });expect(String(caught)).not.toContain('PRIVATE-');expect(f.writes()).toHaveLength(1);
  });
  it.each(['partial', 'lost-other', 'native', 'readback'])('does not claim unbind success after %s', async failure => {
    const f = await setup();f.addSelected();const op = f.op('unbind', await f.args('unbind'));f.state.failure = failure;await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ details: { resourceIds: [C, APP, PIXEL] } });expect(f.writes()).toHaveLength(1);
  });
  it('consumes shared approval once, rejects argument drift and keeps private native fields out of audit', async () => {
    const f = await setup(), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] }), args = { account_id: A, ...await f.args() };
    const preview = await runtime.registry.call('tiktok_bind_catalog_event_sources', args, runtime.ctx) as Row;expect(f.writes()).toHaveLength(0);await expect(runtime.registry.call('tiktok_bind_catalog_event_sources', { ...args, pixel_code: 'OTHER', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await runtime.registry.call('tiktok_bind_catalog_event_sources', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);await expect(runtime.registry.call('tiktok_bind_catalog_event_sources', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(f.writes()).toHaveLength(1);
    const logs = (await Promise.all((await readdir(join(f.dir, 'audit'))).map(file => readFile(join(f.dir, 'audit', file), 'utf8')))).join('\n');expect(logs).not.toContain('PRIVATE-');
  });
});
