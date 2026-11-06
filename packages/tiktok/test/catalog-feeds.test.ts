import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteKind, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTikTokCatalogAccessStore, catalogGrant } from '../src/catalog-access.js';
import { catalogFeedCreate } from '../src/catalog-feeds.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// TikTok-owned v1.3 catalog/feed get/create/update/delete/log and switch docs.
// Current contracts and schedule-status doc1750349624999937 fetched2026-11-05.
const A = '7678335757387513873', B = '111', C = '222', F = '333', NEW = '555';
const input = { account_id: A, bc_id: B, catalog_id: C }, scope = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const };
const uri = 'https://feed.example.test/private/products.csv?signature=SECRET';
const scheduled = { source: { uri, username: 'src-user', password: 'src-password' }, interval_type: 'DAILY', interval_count: 1, timezone: 'Europe/Berlin', hour: 0, minute: 0 };
type Row = { feed_id: string; feed_name: string; feed_type: string; status?: string; last_update_param: Record<string, unknown>; number_of_products: number };
type Call = { url: URL; init: RequestInit; body?: Record<string, unknown> };
type State = { rows: Map<string, Row>; writes: number };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const flatten = (value: Record<string, unknown>) => { const { source, ...rest } = value;return { ...rest, ...(source as Record<string, unknown>), day_of_month: value.interval_type === 'MONTHLY' ? value.day_of_month : null }; };
async function fixture(mode: 'none' | 'read' | 'write' = 'write', override?: (call: Call, state: State) => unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'adport-tiktok-feeds-'));dirs.push(dir);const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));
  if (mode !== 'none') await store.compareAndSet(scope, catalogGrant(scope).hash, mode);
  const parent = { catalog_id: C, catalog_name: 'QA catalog', catalog_type: 'ECOM', bc_info: { bc_id: B }, catalog_conf: { country: 'DE', currency: 'EUR', is_multi_country: true } };
  const state: State = { writes: 0, rows: new Map([F, '444'].map(id => [id, { feed_id: id, feed_name: 'QA <feed> ' + id, feed_type: 'DATA_FEED', status: 'OFF', last_update_param: { ...flatten(scheduled), update_mode: 'INCREMENTAL' }, number_of_products: 2 }])) };
  const calls: Call[] = [];
  const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
    const call: Call = { url: new URL(String(raw)), init, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };calls.push(call);
    const custom = override?.(call, state);if (custom !== undefined) return custom instanceof Response ? custom : Response.json({ code: 0, data: custom });
    const path = call.url.pathname, body = call.body;
    if (path.endsWith('/catalog/get/')) return Response.json({ code: 0, data: { list: [parent] } });
    if (path.endsWith('/catalog/feed/get/')) return Response.json({ code: 0, data: { feed_list: [...state.rows.values()].filter(row => !call.url.searchParams.has('feed_id') || row.feed_id === call.url.searchParams.get('feed_id')) } });
    if (path.endsWith('/catalog/feed/log/')) return Response.json({ code: 0, data: { feed_logs: [{ last_update_status: { add_count: 1, update_count: 2, error_count: 0, remove_count: 3, warn_count: 1, process_status: 'SUCCESS' }, last_update_time: { start_time: '2026-11-05 12:00:00', end_time: '2026-11-05 12:00:30' } }] } });
    if (path.endsWith('/catalog/feed/create/')) { state.writes++;state.rows.set(NEW, { feed_id: NEW, feed_name: String(body!.feed_name), feed_type: String(body!.feed_type ?? 'DATA_FEED'), status: body!.schedule_param ? 'ON' : 'OFF', last_update_param: { ...(body!.schedule_param ? flatten(body!.schedule_param as Record<string, unknown>) : {}), update_mode: body!.update_mode }, number_of_products: 0 });return Response.json({ code: 0, data: { feed_id: NEW } }); }
    const row = body ? state.rows.get(String(body.feed_id)) : undefined;
    if (path.endsWith('/catalog/feed/update/')) { state.writes++;row!.last_update_param = { ...row!.last_update_param, ...(body!.schedule_param ? flatten(body!.schedule_param as Record<string, unknown>) : {}), update_mode: body!.update_mode };return Response.json({ code: 0, data: { feed_id: row!.feed_id } }); }
    if (path.endsWith('/catalog/feed/switch/')) { state.writes++;row!.status = String(body!.status);return Response.json({ code: 0, data: {} }); }
    if (path.endsWith('/catalog/feed/delete/')) { state.writes++;state.rows.delete(String(body!.feed_id));return Response.json({ code: 0, data: { feed_id: Number(body!.feed_id) } }); }
    throw new Error('Unexpected fixture endpoint');
  }), { appId: 'inert', secret: 'inert' }, undefined, store);
  const service = provider.catalogs.feeds;
  const snapshot = async () => (await service.list({ ...input, feed_id: F })).feeds[0]!.configuration_hash;
  const base = async () => ({ bc_id: B, catalog_id: C, feed_id: F, expected_configuration_hash: await snapshot(), acknowledge_shared_effects: true });
  const createArgs = async () => ({ bc_id: B, catalog_id: C, feed_name: 'Created QA feed', update_mode: 'INCREMENTAL', expected_catalog_hash: (await provider.catalogs.get(input)).catalog.configuration_hash, acknowledge_shared_effects: true, acknowledge_automatic_processing: true });
  const op = (tool: string, kind: WriteKind, payload: Record<string, unknown>): WriteOperation => ({ provider: 'tiktok', accountId: A, tool, kind, payload });
  const audit = new AuditLog(join(dir, 'audit'));
  const runtime = () => createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), audit), providerModules: [{ provider, tools: tiktokTools(provider) }] });
  return { dir, store, parent, state, calls, provider, service, snapshot, base, createArgs, op, audit, runtime };
}
const posts = (calls: Call[]) => calls.filter(call => call.init.method === 'POST');
const guard = { forcePausedCreation: true };

describe('TikTok project-scoped catalog feed reads', () => {
  it('requires exact account/BC/catalog grant before any native request', async () => {
    const f = await fixture('none');await expect(f.service.list(input)).rejects.toThrow('read access');expect(f.calls).toHaveLength(0);
    const g = await fixture();for (const patch of [{ account_id: '999' }, { bc_id: '999' }, { catalog_id: '999' }]) await expect(g.service.log({ ...input, ...patch, feed_id: F })).rejects.toThrow('read access');expect(g.calls).toHaveLength(0);
  });
  it('returns only safe feed configuration, not source paths/query values, credentials or unknown native extensions', async () => {
    const f = await fixture('read', call => call.url.pathname.endsWith('/catalog/feed/get/') ? { feed_list: [{ feed_id: F, feed_name: 'QA', feed_type: 'DATA_FEED', status: 'OFF', last_update_param: { ...flatten(scheduled), update_mode: 'INCREMENTAL' }, access_token: 'PRIVATE-extension', unsafe_html: '<script>bad()</script>' }] } : undefined);
    const data = await f.service.list(input), text = JSON.stringify(data);for (const value of [uri, 'SECRET', '/private/products.csv', 'src-user', 'src-password', 'PRIVATE-extension', '<script>']) expect(text).not.toContain(value);
    expect(data.feeds[0]).toMatchObject({ source_origin: 'https://feed.example.test', source_configured: true, source_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), configuration_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(data.records[0]).toMatchObject({ type: 'DATA_FEED', update_mode: 'INCREMENTAL', source: 'https://feed.example.test', frequency: 'Every 1 day · Europe/Berlin · 00:00' });expect(data.records[0]).not.toHaveProperty('feed_name');expect(data.records[0]).not.toHaveProperty('source_fingerprint');
    expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toEqual({ bc_id: B, catalog_id: C });expect(f.calls.at(-1)!.url.pathname).toBe('/open_api/v1.3/catalog/feed/get/');expect(posts(f.calls)).toHaveLength(0);
  });
  it('snapshot-pages the unpaged native list and invalidates config changes while ignoring product counts', async () => {
    const f = await fixture(), first = await f.service.list({ ...input, page_size: 1 });expect(first.next_cursor).toBeDefined();f.state.rows.get('444')!.number_of_products = 99;
    expect((await f.service.list({ ...input, page_size: 1, cursor: first.next_cursor })).feeds[0]!.feed_id).toBe('444');
    f.state.rows.get('444')!.last_update_param.uri = 'https://other.example.test/private?secret=CHANGED';await expect(f.service.list({ ...input, page_size: 1, cursor: first.next_cursor })).rejects.toThrow('configuration or selection changed');
    await expect(f.service.list({ ...input, cursor: 'invalid' })).rejects.toThrow('Invalid feed cursor');
  });
  it.each(['wrong-id', 'wrong-catalog', 'wrong-bc', 'duplicate', 'partial', 'unsafe-id'])('rejects %s native feed responses', async fault => {
    const f = await fixture('read', (call, state) => {
      if (!call.url.pathname.endsWith('/catalog/feed/get/')) return;
      const row = { ...state.rows.get(F)!, ...(fault === 'wrong-id' ? { feed_id: '999' } : {}), ...(fault === 'wrong-catalog' ? { catalog_id: '999' } : {}), ...(fault === 'wrong-bc' ? { bc_id: '999' } : {}), ...(fault === 'unsafe-id' ? { feed_id: Number.MAX_SAFE_INTEGER + 1 } : {}) };
      return { feed_list: fault === 'duplicate' ? [row, row] : [row], ...(fault === 'partial' ? { page_info: { page: 1, total_page: 2 } } : {}) };
    });await expect(f.service.list({ ...input, feed_id: F })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('verifies log membership and clearly bounds history to the latest10 operations', async () => {
    const f = await fixture('read'), data = await f.service.log({ ...input, feed_id: F });expect(data).toMatchObject({ history_scope: 'latest_10_operations_only', more_history_available: null, logs: [{ process_status: 'SUCCESS', remove_count: 3, warn_count: 1 }], records: [{ name: '2026-11-05 12:00:00', status: 'SUCCESS', removed: 3, warnings: 1 }] });expect(data.notes[0]).toContain('not full history');expect(f.calls.at(-2)!.url.searchParams.get('feed_id')).toBe(F);expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toEqual({ bc_id: B, catalog_id: C, feed_id: F });
  });
  it('accepts current log field names but rejects conflicting aliases or secret-bearing timestamps', async () => {
    let fault: '' | 'alias' | 'timestamp' = '';const data = { add_count: 1, update_count: 2, error_count: 0, remove_count: 0, warn_count: 0, process_status: 'PROCESSING' };
    const f = await fixture('read', call => call.url.pathname.endsWith('/catalog/feed/log/') ? { feed_logs: [{ update_status: data, update_time: { start_time: fault === 'timestamp' ? uri : '2026-11-05 12:00:00', end_time: null }, ...(fault === 'alias' ? { last_update_status: { ...data, error_count: 10 } } : {}) }] } : undefined);
    expect((await f.service.log({ ...input, feed_id: F })).logs[0]!.process_status).toBe('PROCESSING');
    for (const value of ['alias', 'timestamp'] as const) { fault = value;await expect(f.service.log({ ...input, feed_id: F })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' }); }
  });
});

describe('TikTok feed schedules and guarded configuration', () => {
  it.each([
    { interval_type: 'HOURLY', interval_count: 24 }, { interval_type: 'MONTHLY', interval_count: 13, day_of_month: 1 },
    { interval_type: 'MONTHLY', interval_count: 1 }, { interval_type: 'DAILY', day_of_month: 3 }, { timezone: 'Invalid/Zone' },
    { source: { uri: 'https://user:password@feed.example.test/x.csv' } }, { source: { uri: 'file:///private/data.csv' } },
  ])('rejects unsupported/ambiguous schedule input %#', patch => {
    expect(catalogFeedCreate.safeParse({ bc_id: B, catalog_id: C, feed_name: 'QA', update_mode: 'INCREMENTAL', expected_catalog_hash: 'a'.repeat(64), acknowledge_shared_effects: true, acknowledge_automatic_processing: true, schedule_param: { ...scheduled, ...patch } }).success).toBe(false);
  });
  it('previews redacted creation, hashes exact private arguments, sends wire JSON once, then reads back the known feed', async () => {
    const f = await fixture(), args = { account_id: A, ...await f.createArgs(), feed_name: `QA ${uri} src-password`, schedule_param: scheduled }, r = await f.runtime();
    const pending = await r.registry.call('tiktok_create_catalog_feed', args, r.ctx) as { pending_operation_id: string };
    for (const secret of [uri, 'src-password', 'src-user']) expect(JSON.stringify(pending)).not.toContain(secret);expect(posts(f.calls)).toHaveLength(0);
    await expect(r.registry.call('tiktok_create_catalog_feed', { ...args, schedule_param: { ...scheduled, source: { ...scheduled.source, password: 'CHANGED' } }, pending_operation_id: pending.pending_operation_id }, r.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const approved = { ...args, pending_operation_id: pending.pending_operation_id };expect(await r.registry.call('tiktok_create_catalog_feed', approved, r.ctx)).toHaveProperty('result.resourceIds', [NEW]);expect(posts(f.calls)[0]!.body).toEqual({ bc_id: B, catalog_id: C, feed_name: args.feed_name, update_mode: 'INCREMENTAL', schedule_param: scheduled });expect(f.calls.at(-1)!.url.searchParams.get('feed_id')).toBe(NEW);
    expect(JSON.stringify(await f.audit.read())).not.toContain('src-password');await expect(r.registry.call('tiktok_create_catalog_feed', approved, r.ctx)).rejects.toThrow();expect(posts(f.calls)).toHaveLength(1);
  });
  it('creates a source-free OFF feed, binds parent config and enforces multi-country eligibility', async () => {
    const f = await fixture(), args = await f.createArgs();expect(await f.provider.applyWrite(f.op('tiktok_create_catalog_feed', 'create', args), guard)).toHaveProperty('resourceIds', [NEW]);expect(f.state.rows.get(NEW)!.status).toBe('OFF');
    f.parent.catalog_conf.currency = 'USD';await expect(f.provider.previewWrite(f.op('tiktok_create_catalog_feed', 'create', args), guard)).rejects.toThrow('Catalog configuration changed');
    f.parent.catalog_conf.is_multi_country = false;await expect(f.provider.previewWrite(f.op('tiktok_create_catalog_feed', 'create', { ...await f.createArgs(), feed_type: 'COUNTRY_FEED' }), guard)).rejects.toThrow('multi-country');expect(posts(f.calls)).toHaveLength(1);
  });
  it('updates native SUPPLEMENT mode without changing source/status and can replace a complete scheduled source', async () => {
    const f = await fixture(), args = { ...await f.base(), update_mode: 'SUPPLEMENT', acknowledge_automatic_processing: true };
    expect(await f.provider.applyWrite(f.op('tiktok_update_catalog_feed', 'update', args), guard)).toHaveProperty('resourceIds', [F]);expect(posts(f.calls)[0]!.body).toEqual({ bc_id: B, catalog_id: C, feed_id: F, update_mode: 'SUPPLEMENT' });expect(f.state.rows.get(F)!.last_update_param.uri).toBe(uri);expect(f.state.rows.get(F)!.status).toBe('OFF');
    const replacement = { ...scheduled, source: { uri: 'sftp://catalog.example.test/private/data.csv', username: 'new-user', password: 'new-password' }, interval_type: 'MONTHLY', interval_count: 2, day_of_month: 28 };
    const operation = f.op('tiktok_update_catalog_feed', 'update', { ...await f.base(), update_mode: 'OVERWRITE', schedule_param: replacement, acknowledge_automatic_processing: true });const preview = await f.provider.previewWrite(operation, guard);expect(JSON.stringify(preview)).not.toContain('new-password');expect(preview.notes!.join(' ')).toContain('remove products');
    expect(await f.provider.applyWrite(operation, guard)).toHaveProperty('resourceIds', [F]);expect(posts(f.calls)[1]!.body).toMatchObject({ schedule_param: replacement });
  });
  it('switches only opposite known schedule state with configured source and independently preserves the configuration', async () => {
    const f = await fixture(), args = { ...await f.base(), status: 'ON', acknowledge_automatic_processing: true };const operation = f.op('tiktok_set_catalog_feed_schedule_status', 'update', args);
    expect(await f.provider.applyWrite(operation, guard)).toHaveProperty('resourceIds', [F]);expect(posts(f.calls)[0]!.body).toEqual({ bc_id: B, catalog_id: C, feed_id: F, status: 'ON' });expect(f.calls.at(-1)!.url.pathname).toBe('/open_api/v1.3/catalog/feed/get/');
    await expect(f.provider.previewWrite(f.op('tiktok_set_catalog_feed_schedule_status', 'update', { ...await f.base(), status: 'ON', acknowledge_automatic_processing: true }), guard)).rejects.toThrow('opposite');
    f.state.rows.get(F)!.status = 'OFF';delete f.state.rows.get(F)!.last_update_param.uri;await expect(f.provider.previewWrite(f.op('tiktok_set_catalog_feed_schedule_status', 'update', { ...await f.base(), status: 'ON', acknowledge_automatic_processing: true }), guard)).rejects.toThrow('configured source');expect(posts(f.calls)).toHaveLength(1);
  });
  it('checks current principal grant and snapshot before applying any write', async () => {
    const f = await fixture(), args = { ...await f.base(), status: 'ON', acknowledge_automatic_processing: true };f.state.rows.get(F)!.last_update_param.uri = 'https://other.example.test/x.csv';await expect(f.provider.applyWrite(f.op('tiktok_set_catalog_feed_schedule_status', 'update', args), guard)).rejects.toThrow('configuration changed');
    const grant = await f.store.get(scope);await f.store.compareAndSet(scope, grant.hash, 'read');await expect(f.provider.applyWrite(f.op('tiktok_delete_catalog_feed', 'remove', await f.base()), guard)).rejects.toThrow('write access');expect(posts(f.calls)).toHaveLength(0);
  });
  it('deletes one exact feed and independently confirms absence without replaying its consumed approval', async () => {
    const f = await fixture(), args = { account_id: A, ...await f.base() }, r = await f.runtime();const pending = await r.registry.call('tiktok_delete_catalog_feed', args, r.ctx) as { pending_operation_id: string };expect(posts(f.calls)).toHaveLength(0);
    const approved = { ...args, pending_operation_id: pending.pending_operation_id };expect(await r.registry.call('tiktok_delete_catalog_feed', approved, r.ctx)).toHaveProperty('result.resourceIds', [F]);await expect(r.registry.call('tiktok_delete_catalog_feed', approved, r.ctx)).rejects.toThrow();expect(posts(f.calls)).toHaveLength(1);expect(f.calls.at(-1)!.url.searchParams.has('feed_id')).toBe(false);expect(f.state.rows.has('444')).toBe(true);
  });
  it.each(['wrong-receipt', 'still-present', 'partial-readback', 'transport'])('keeps known ID after %s, redacts provider errors and never retries', async fault => {
    const f = await fixture('write', (call, state) => {
      if (call.url.pathname.endsWith('/catalog/feed/delete/')) {
        if (fault === 'wrong-receipt') return { feed_id: '999' };
        if (fault === 'still-present') return { feed_id: F };
        if (fault === 'transport') return Response.json({ code: 40000, message: uri + ' src-password', data: { password: 'src-password' } });
      }
      if (state.writes && call.url.pathname.endsWith('/catalog/feed/get/') && fault === 'partial-readback') return { feed_list: [], page_info: { page: 1, total_page: 2 } };
      return undefined;
    });const promise = f.provider.applyWrite(f.op('tiktok_delete_catalog_feed', 'remove', await f.base()), guard);await expect(promise).rejects.toMatchObject({ details: { resource_ids: [F] } });try { await promise; } catch (e) { expect(String(e)).not.toContain('src-password');expect(String(e)).not.toContain(uri); }expect(posts(f.calls)).toHaveLength(1);
  });
});
