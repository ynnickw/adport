import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, verifyMedia, type MediaLibrary, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTikTokCatalogAccessStore, catalogGrant } from '../src/catalog-access.js';
import { catalogProductList } from '../src/catalog-products.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// TikTok-owned catalog/product get/file/log contracts fetched 2026-11-05.
// CSV fixtures exercise structural validation only; provider templates/eligibility are native checks.
const A = '7678335757387513873', B = '111', C = '222', F = '333', J = '9007199254740993', M = '11111111-1111-4111-8111-111111111111';
const selection = { account_id: A, bc_id: B, catalog_id: C }, scope = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const };
const guard = { forcePausedCreation: true }, digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const capability = 'https://store.example/storage/v1/object/sign/creative-media/qa/' + M + '?token=PRIVATE-CAPABILITY';
type Row = Record<string, any>;
type Call = { url: URL; init: RequestInit; body?: Row };
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(mode: 'none' | 'read' | 'write' = 'write') {
  const dir = await mkdtemp(join(tmpdir(), 'adport-tiktok-products-'));directories.push(dir);
  const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));if (mode !== 'none') await store.compareAndSet(scope, catalogGrant(scope).hash, mode);
  const state = {
    parent: { catalog_id: C, catalog_name: 'QA', catalog_type: 'ECOM', bc_info: { bc_id: B }, catalog_conf: { currency: 'EUR' } },
    feed: { feed_id: F, feed_name: 'QA feed', feed_type: 'DATA_FEED' as string | undefined, status: 'ON', last_update_param: { update_mode: 'INCREMENTAL' } },
    products: [{ product_id: J, sku_id: '00012', title: 'QA <product>', description: 'x'.repeat(500), image_url: 'https://images.example/a.png', video_url: 'https://video.example/a.mp4', active_status: 'ACTIVATED', ad_creation_eligible: 'NOT_AVAILABLE', audit: { audit_status: 'processing' }, file_url: capability }, { product_id: '42', sku_id: 'sku-2', title: 'Other', image_url: 'javascript:alert(1)' }] as Row[],
    page: { page: 1, page_size: 20, total_number: 2, total_page: 1 } as Row | undefined,
    job: { catalog_id: C, feed_id: F, process_status: 'PROCESSING', update_mode: 'INCREASE', add_count: 1, update_count: 0, error_count: 0 } as Row,
    receipt: { feed_log_id: J } as Row,
    csv: Buffer.from('template_column_a,template_column_b\r\n00012,Sample\r\n'),
    grant: { url: capability, sha256: '', expires_at: new Date(Date.now() + 3600_000).toISOString() },
    failure: '', readCalls: 0, grantCalls: 0,
  };
  const calls: Call[] = [], tracked: unknown[] = [];
  const media: MediaLibrary = {
    list: async () => ({ assets: [], truncated: false }),
    async read(source, options) { state.readCalls++;return verifyMedia(state.csv, 'Catalog source', source.expected_sha256, options); },
    async providerUrl() { state.grantCalls++;return { ...state.grant, sha256: state.grant.sha256 || digest(state.csv) }; },
    async trackUpload(input, execute) { tracked.push(input);return execute(); },
  };
  const client = new TikTokClient({ accessToken: 'inert-token' }, async (raw, init = {}) => {
    const call = { url: new URL(String(raw)), init, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };calls.push(call);
    const path = call.url.pathname, ok = (data: unknown) => Response.json({ code: 0, data });
    if (path.endsWith('/catalog/get/')) return ok({ list: [state.parent] });
    if (path.endsWith('/catalog/feed/get/')) return ok({ feed_list: [state.feed] });
    if (path.endsWith('/catalog/product/get/')) return ok({ list: state.products, ...(state.page ? { page_info: state.page } : {}) });
    if (path.endsWith('/catalog/product/log/')) {
      if (state.failure === 'readback') throw new Error(capability);
      return ok({ product_feed_log: state.job });
    }
    if (path.endsWith('/catalog/product/file/')) {
      if (state.failure === 'transport') throw new Error(capability);
      if (state.failure === 'native') return Response.json({ code: 40001, message: capability });
      return ok(state.receipt);
    }
    throw new Error('Unexpected fixture endpoint');
  });
  const provider = new TikTokAdsProvider(client, { appId: 'inert', secret: 'inert' }, media, store);
  const args = async () => ({ ...selection, feed_id: F, media_id: M, expected_sha256: digest(state.csv),
    expected_catalog_hash: (await provider.catalogs.get(selection)).catalog.configuration_hash,
    expected_feed_hash: (await provider.catalogs.feeds.list({ ...selection, feed_id: F })).feeds[0]!.configuration_hash,
    update_mode: 'INCREMENTAL' as const, acknowledge_shared_effects: true, acknowledge_async_processing: true,
  });
  const op = (args: Row): WriteOperation => { const { account_id, ...payload } = args;return { provider: 'tiktok', tool: 'tiktok_import_catalog_file', accountId: account_id, kind: 'update', payload }; };
  return { dir, store, state, calls, provider, args, op, media, tracked, writes: () => calls.filter(call => call.init.method === 'POST') };
}

describe('TikTok catalog product browsing', () => {
  it('projects safe exact-ID media summaries and separates audit from ad eligibility', async () => {
    const f = await fixture('read'), result = await f.provider.catalogs.products.list(selection);
    expect(result.products[0]).toMatchObject({ product_id: J, external_id: '00012', audit_status: 'processing', ad_creation_eligible: 'NOT_AVAILABLE', description_truncated: true });
    expect(result.products[0]!.description).toHaveLength(300);expect(JSON.stringify(result)).not.toContain('PRIVATE-CAPABILITY');
    expect(result.creatives[0]).toMatchObject({ id: J, account_id: A, name: 'QA <product>', media: [{ type: 'image', url: 'https://images.example/a.png', alt: 'QA <product>' }, { type: 'video', url: 'https://video.example/a.mp4', alt: 'QA <product>' }] });
    expect(result.creatives[1]!.media).toEqual([]);expect(result.complete).toBe(true);expect(f.writes()).toHaveLength(0);
    const call = f.calls.at(-1)!;expect(Object.fromEntries(call.url.searchParams)).toEqual({ bc_id: B, catalog_id: C, page: '1', page_size: '20' });expect(new Headers(call.init.headers).get('content-type')).toBe('application/json');
  });
  it('encodes native ID filters as arrays and rejects cross-selection rows', async () => {
    const f = await fixture('read');f.state.products = [f.state.products[0]!];f.state.page!.total_number = 1;
    await f.provider.catalogs.products.list({ ...selection, sku_ids: ['00012'] });expect(f.calls.at(-1)!.url.searchParams.get('sku_ids')).toBe('["00012"]');
    await expect(f.provider.catalogs.products.list({ ...selection, product_ids: ['123'] })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    f.state.parent.catalog_type = 'HOTEL';await expect(f.provider.catalogs.products.list({ ...selection, sku_ids: ['00012'] })).rejects.toThrow('E-commerce');
  });
  it.each(['duplicate', 'wrong-parent', 'unsafe-id', 'wrong-page'])('rejects %s native product data', async fault => {
    const f = await fixture('read');
    if (fault === 'duplicate') f.state.products[1] = f.state.products[0]!;
    if (fault === 'wrong-parent') f.state.products[0]!.catalog_id = '999';
    if (fault === 'unsafe-id') f.state.products[0]!.product_id = Number.MAX_SAFE_INTEGER + 1;
    if (fault === 'wrong-page') f.state.page!.page = 2;
    await expect(f.provider.catalogs.products.list(selection)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('does not infer completion from missing totals or fabricate continuation past the native 10,000-result cap', async () => {
    const f = await fixture('read');f.state.page = undefined;
    expect(await f.provider.catalogs.products.list(selection)).toMatchObject({ complete: null, truncated: true });
    f.state.products = Array.from({ length: 100 }, (_, n) => ({ product_id: String(n + 1), title: 'Product' }));
    f.state.page = { page: 100, page_size: 100, total_number: 20_000, total_page: 200 };
    const result = await f.provider.catalogs.products.list({ ...selection, page: 100, page_size: 100 });
    expect(result).toMatchObject({ complete: false, truncated: true, native_limit_reached: true });expect(result).not.toHaveProperty('next_page');
    expect(catalogProductList.safeParse({ ...selection, page: 101, page_size: 100 }).success).toBe(false);
    f.state.page = { page: 1, page_size: 100, total_number: 200, total_page: 2 };
    expect(await f.provider.catalogs.products.list({ ...selection, page_size: 100 })).toMatchObject({ next_page: 2, complete: false });
  });
});

describe('TikTok product import status', () => {
  it('confirms the requested catalog/feed/job and omits error-download capabilities and free-form text', async () => {
    const f = await fixture('read');f.state.job = { feeds_id: 333, process_status: 'SUCCESS', error_count: 2, feed_log_data: { download_path: { en: capability }, error_affected_products: [{ field: 'image_url', affected_product_count: 2, issue: capability, affected_product_item_list: [{ product_url: capability }] }] } };
    const result = await f.provider.catalogs.products.log({ ...selection, feed_id: F, feed_log_id: J });
    expect(result).toMatchObject({ processing_complete: true, log: { feed_id: F, feed_log_id: J, error_count: 2, error_fields: [{ field: 'image_url', affected_product_count: 2 }] } });
    expect(result.records[0]!.status).toBe('Completed with item errors');expect(result.log).not.toHaveProperty('add_count');expect(JSON.stringify(result)).not.toContain('PRIVATE-CAPABILITY');
    expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toEqual({ bc_id: B, catalog_id: C, feed_log_id: J, language: 'en' });
  });
  it.each(['wrong-feed', 'missing-feed', 'conflicting-alias', 'wrong-catalog', 'wrong-job', 'unsafe-feed', 'unknown-status'])('rejects %s processing receipts', async fault => {
    const f = await fixture('read');
    if (fault === 'wrong-feed') f.state.job.feed_id = '999';if (fault === 'missing-feed') delete f.state.job.feed_id;
    if (fault === 'conflicting-alias') f.state.job.feeds_id = '999';if (fault === 'wrong-catalog') f.state.job.catalog_id = '999';
    if (fault === 'wrong-job') f.state.job.feed_log_id = '999';if (fault === 'unsafe-feed') f.state.job.feed_id = Number.MAX_SAFE_INTEGER + 1;
    if (fault === 'unknown-status') f.state.job.process_status = 'DONE';
    await expect(f.provider.catalogs.products.log({ ...selection, feed_id: F, feed_log_id: J })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('bounds diagnostics and keeps missing counters unavailable', async () => {
    const f = await fixture('read');f.state.job = { feed_id: F, process_status: 'WAITING', feed_log_data: { warn_affected_products: Array.from({ length: 51 }, () => ({ field: 'brand', affected_product_count: 1 })) } };
    const result = await f.provider.catalogs.products.log({ ...selection, feed_id: F, feed_log_id: J });
    expect(result.log.warning_fields).toHaveLength(50);expect(result.log.diagnostic_fields_truncated).toBe(true);expect(result.processing_complete).toBe(false);expect(result.log).not.toHaveProperty('error_count');
    f.state.job.feed_log_data = { error_affected_products: [{ field: capability, affected_product_count: 1 }] };
    const unknownField = await f.provider.catalogs.products.log({ ...selection, feed_id: F, feed_log_id: J });
    expect(unknownField.log.error_fields).toEqual([{ field: 'Unrecognized field', affected_product_count: 1 }]);expect(JSON.stringify(unknownField)).not.toContain('PRIVATE-CAPABILITY');
    f.state.job.update_mode = 1;
    expect((await f.provider.catalogs.products.log({ ...selection, feed_id: F, feed_log_id: J })).log).toMatchObject({ update_mode: 1, update_mode_recognized: false });
  });
});

describe('guarded CSV catalog imports', () => {
  it('shares preview/apply, source tracking and exact native JSON while reporting acceptance rather than completed ingestion', async () => {
    const f = await fixture(), args = await f.args(), audit = new AuditLog(join(f.dir, 'audit'));
    const runtime = await createContext({ media: f.media, engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), audit), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] });
    const preview = await runtime.registry.call('tiktok_import_catalog_file', args, runtime.ctx) as { pending_operation_id: string };
    expect(preview.pending_operation_id).toBeTruthy();expect(f.writes()).toHaveLength(0);expect(f.state.grantCalls).toBe(0);
    await expect(runtime.registry.call('tiktok_import_catalog_file', { ...args, update_mode: 'OVERWRITE', acknowledge_overwrite: true, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const applied = await runtime.registry.call('tiktok_import_catalog_file', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    expect(applied).toMatchObject({ result: { resourceIds: [J], details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, feed_log_id: J, next_tool: 'tiktok_catalog_product_log' } } });
    expect(f.writes()).toHaveLength(1);expect(f.state.grantCalls).toBe(1);
    expect(f.writes()[0]!.url.pathname).toBe('/open_api/v1.3/catalog/product/file/');
    expect(f.writes()[0]!.body).toEqual({ bc_id: B, catalog_id: C, feed_id: F, file_url: capability, update_mode: 'INCREMENTAL' });
    expect(new Headers(f.writes()[0]!.init.headers).get('Access-Token')).toBe('inert-token');
    expect(f.tracked).toEqual([{ media_id: M, expected_sha256: args.expected_sha256, provider: 'tiktok', account_id: A, tool: 'tiktok_import_catalog_file' }]);
    expect(JSON.stringify({ preview, applied })).not.toContain('PRIVATE-CAPABILITY');
    const logs = await Promise.all((await readdir(join(f.dir, 'audit'))).map(name => readFile(join(f.dir, 'audit', name), 'utf8')));expect(logs.join('')).not.toContain('PRIVATE-CAPABILITY');
  });
  it('requires explicit overwrite acknowledgement and rechecks the file, parent/feed snapshots and grants', async () => {
    const f = await fixture(), args = await f.args();
    await expect(f.provider.previewWrite(f.op({ ...args, update_mode: 'OVERWRITE' }), guard)).rejects.toThrow();
    await f.provider.previewWrite(f.op({ ...args, update_mode: 'OVERWRITE', acknowledge_overwrite: true }), guard);
    f.state.feed.feed_name = 'Changed';await expect(f.provider.applyWrite(f.op(args), guard)).rejects.toThrow('configuration changed');
    f.state.feed.feed_name = 'QA feed';f.state.csv = Buffer.from('a,b\nx,y\n');await expect(f.provider.applyWrite(f.op(args), guard)).rejects.toThrow('SHA-256');
    const other = await fixture(), next = await other.args(), grant = await other.store.get(scope);await other.store.compareAndSet(scope, grant.hash, 'read');
    await expect(other.provider.applyWrite(other.op(next), guard)).rejects.toThrow('write access');expect(f.writes()).toHaveLength(0);expect(other.writes()).toHaveLength(0);
  });
  it.each(['a,a\nx,y\n', 'a,b\nx\n', 'a,b\n', 'a,b\n,\n'])('rejects invalid/empty CSV %# before staging a provider URL', async csv => {
    const f = await fixture();f.state.csv = Buffer.from(csv);const args = await f.args();
    await expect(f.provider.previewWrite(f.op(args), guard)).rejects.toMatchObject({ code: 'INVALID_INPUT' });expect(f.state.grantCalls).toBe(0);expect(f.writes()).toHaveLength(0);
  });
  it.each(['expired', 'wrong-hash', 'http', 'credentials'])('rejects %s source capabilities before a provider write', async fault => {
    const f = await fixture(), args = await f.args();
    if (fault === 'expired') f.state.grant.expires_at = new Date(Date.now() - 1000).toISOString();
    if (fault === 'wrong-hash') f.state.grant.sha256 = '0'.repeat(64);
    if (fault === 'http') f.state.grant.url = 'http://store.example/private.csv';
    if (fault === 'credentials') f.state.grant.url = 'https://user:secret@store.example/private.csv';
    await expect(f.provider.applyWrite(f.op(args), guard)).rejects.toThrow('download grant');expect(f.writes()).toHaveLength(0);
  });
  it.each(['transport', 'native', 'readback', 'wrong-feed', 'wrong-mode', 'numeric-mode', 'failed-job', 'item-errors'])('never replays %s and retains known task IDs', async fault => {
    const f = await fixture(), args = await f.args();
    if (['transport', 'native', 'readback'].includes(fault)) f.state.failure = fault;
    if (fault === 'wrong-feed') f.state.job.feed_id = '999';
    if (fault === 'wrong-mode') f.state.job.update_mode = 'REPLACE';
    if (fault === 'numeric-mode') f.state.job.update_mode = 1;
    if (fault === 'failed-job') f.state.job.process_status = 'FAILED';
    if (fault === 'item-errors') { f.state.job.process_status = 'SUCCESS';f.state.job.error_count = 2; }
    const error = await f.provider.applyWrite(f.op(args), guard).catch(error => error);
    expect(error.code).toBe('PROVIDER_ERROR');expect(f.writes()).toHaveLength(1);expect(JSON.stringify(error.toJSON())).not.toContain('PRIVATE-CAPABILITY');
    if (!['transport', 'native'].includes(fault)) expect(error.details).toMatchObject({ resource_ids: [J], feed_log_id: J });
  });
  it('denies missing catalog grants before native reads and does not add local file-path or arbitrary-URL fallbacks', async () => {
    const f = await fixture('none');await expect(f.provider.catalogs.products.list(selection)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(f.calls).toHaveLength(0);
    const local = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async () => { throw new Error('Unexpected native call'); }), { appId: 'inert', secret: 'inert' });
    await expect(local.previewWrite({ provider: 'tiktok', accountId: A, kind: 'update', tool: 'tiktok_import_catalog_file', payload: { bc_id: B, catalog_id: C, feed_id: F, media_id: M, expected_sha256: '0'.repeat(64), expected_catalog_hash: '0'.repeat(64), expected_feed_hash: '0'.repeat(64), update_mode: 'INCREMENTAL', acknowledge_shared_effects: true, acknowledge_async_processing: true } }, guard)).rejects.toThrow('hosted project media library');
  });
});
