import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, verifyMedia, type MediaResolver, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTikTokCatalogAccessStore, catalogGrant } from '../src/catalog-access.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { TikTokClient } from '../src/client.js';
import { tiktokTools } from '../src/tools.js';
import { parseProduct, productShape, type CatalogProductKind } from '../src/catalog-product-shapes.js';

// Current official TikTok product/upload/update/get/delete/log docs fetched 2026-11-05:
// 1740497429681153,1740562287852546,1740564136678402,1740562489236481,1740570027173889.
// Native upload/update are absent from the older official SDK; the current official portal is authoritative here.
// These synthetic responses prove request contracts and safety behavior, not native account eligibility.
const A = '7678335757387513873', B = '111', C = '222', F = '333', P = '9007199254740993', J = '9007199254740994';
const selection = { account_id: A, bc_id: B, catalog_id: C }, selectedFeed = { ...selection, feed_id: F }, grantScope = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const };
const guard = { forcePausedCreation: true }, privateUrl = 'https://images.example/private/path.jpg?token=PRIVATE-CAPABILITY';
type Row = Record<string, any>;
const price = { price: 24.5, currency: 'EUR' }, image = { image_url: privateUrl }, landing = { landing_page: { landing_page_url: 'https://example.com/buy' } }, address = { address: 'Main street', city: 'City', region: 'Region', country: 'DE' };
const fixtures: Record<CatalogProductKind, Row> = {
  ECOM: { sku_id: '00012', title: 'QA shirt', description: 'Cotton', availability: 'IN_STOCK', brand: 'QA', ...image, ...landing, product_detail: { condition: 'NEW' }, price_info: price },
  HOTEL: { hotel_id: 'hotel-1', name: 'QA hotel', brand: 'QA', ...image, address, price_info: price },
  FLIGHT: { origin_airport: 'BER', destination_airport: 'SIN', ...image },
  DESTINATION: { destination_id: 'destination-1', destination_name: 'QA city', description: 'City', ...image, address, types: ['CITY'] },
  ENTERTAINMENT: { media_title_id: 'media-1', title: 'QA film', ...image },
  AUTO_VEHICLE: { vehicle_id: 'vehicle-1', title: 'QA vehicle', description: 'Car', ...image, ...landing, state_of_vehicle: 'NEW', make: 'QA', model: 'Model', year: 2026, mileage: { value: 10, unit: 'KILOMETER' }, body_style: 'SEDAN', exterior_color: 'Black', address: { address: 'Main street', city: 'City', region: 'Region', postal_code: '12345' }, latitude: 52, longitude: 13, price_info: price },
  AUTO_MODEL: { vehicle_id: 'model-1', title: 'QA model', ...image, ...landing, make: 'QA', model: 'Model', year: 2026, exterior_color: 'Black' },
  MINI_SERIES: { series_id: 'series-1', series_name: 'QA series', ...image, recharge: [{ type: 'BY_TIERS', purchase_unit: ['TIER_1'], cost: [1] }], product_detail: { total_episodes: 10, initial_paid_episodes: 2, spoken_language: 'en', subtitle_language: 'en', production_type: 'LOCAL', target_audience: 'MALE', characters: ['OTHER'], genres: ['OTHER'] } },
  GENERIC: { item_id: 'item-1', title: 'QA service', ...image },
  ONLINE_TO_OFFLINE: { listing_id: 'listing-1', title: 'QA burger', description: 'Lunch', availability: 'IN_STOCK', ...image },
};
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(mode: 'none' | 'read' | 'write' = 'write', media?: MediaResolver) {
  const dir = await mkdtemp(join(tmpdir(), 'adport-tiktok-json-products-'));dirs.push(dir);
  const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));if (mode !== 'none') await store.compareAndSet(grantScope, catalogGrant(grantScope).hash, mode);
  const state = { parent: { catalog_id: C, catalog_name: 'QA', catalog_type: 'ECOM' as CatalogProductKind, bc_info: { bc_id: B }, catalog_conf: { currency: 'EUR' } }, feed: { feed_id: F, feed_name: 'JSON feed', feed_type: 'DATA_FEED', status: 'OFF', last_update_param: { update_mode: 'INCREMENTAL' } }, products: [{ product_id: P, ...structuredClone(fixtures.ECOM), audit: { audit_status: 'processing' } }] as Row[], job: { catalog_id: C, feed_id: F, process_status: 'PROCESSING', update_mode: 'INCREASE', error_count: 0 } as Row, receipt: { feed_log_id: J } as Row, failure: '', override: undefined as ((url: URL) => unknown) | undefined };
  const calls: Array<{ url: URL; init: RequestInit; body?: Row }> = [];
  const client = new TikTokClient({ accessToken: 'inert-token' }, async (raw, init = {}) => {
    const url = new URL(String(raw)), body = init.body ? JSON.parse(String(init.body)) : undefined;calls.push({ url, init, body });
    const ok = (data: unknown) => Response.json({ code: 0, data }), override = state.override?.(url);if (override !== undefined) return ok(override);
    if (url.pathname.endsWith('/catalog/get/')) return ok({ list: [state.parent] });
    if (url.pathname.endsWith('/catalog/feed/get/')) return ok({ feed_list: [state.feed] });
    if (url.pathname.endsWith('/catalog/product/get/')) {
      const ids = JSON.parse(url.searchParams.get('product_ids')!), page = Number(url.searchParams.get('page')), rows = state.products.filter(row => ids.includes(String(row.product_id)));
      return ok({ list: rows.slice((page - 1) * 100, page * 100), page_info: { page, page_size: 100, total_number: rows.length, total_page: Math.ceil(rows.length / 100) } });
    }
    if (url.pathname.endsWith('/catalog/product/log/')) { if (state.failure === 'readback') throw new Error(privateUrl);return ok({ product_feed_log: state.job }); }
    if (init.method === 'POST' && /\/catalog\/product\/(upload|update|delete)\/$/.test(url.pathname)) {
      if (state.failure === 'transport') throw new Error(privateUrl);
      if (state.failure === 'native') return Response.json({ code: 40001, message: privateUrl });
      return ok(state.receipt);
    }
    throw new Error('Unexpected fixture endpoint');
  });
  const provider = new TikTokAdsProvider(client, { appId: 'inert', secret: 'inert' }, media, store);
  const hashes = async () => ({ bc_id: B, catalog_id: C, feed_id: F, catalog_type: state.parent.catalog_type, expected_catalog_hash: (await provider.catalogs.get(selection)).catalog.configuration_hash, expected_feed_hash: (await provider.catalogs.feeds.list(selectedFeed)).feeds[0]!.configuration_hash, acknowledge_shared_effects: true, acknowledge_async_processing: true });
  const op = (tool: string, payload: Row): WriteOperation => ({ tool, accountId: A, provider: 'tiktok', kind: tool === 'tiktok_delete_catalog_products' ? 'remove' : 'update', payload });
  const context = () => provider.catalogs.productAuthoring.context({ ...selectedFeed, product_ids: state.products.map(row => String(row.product_id)) });
  return { dir, store, state, calls, provider, hashes, op, context, writes: () => calls.filter(call => call.init.method === 'POST') };
}

describe('TikTok native product structural schemas', () => {
  it.each(Object.keys(fixtures) as CatalogProductKind[])('supports %s without replacing native field structure', type => {
    expect(parseProduct(type, fixtures[type])).toEqual(fixtures[type]);
    expect(productShape(type).safeParse({ ...fixtures[type], unsupported_field: true }).success).toBe(false);
  });
  it('keeps type-specific nested structures, required create fields, enums and numeric precision', () => {
    expect(productShape('ECOM').safeParse({ sku_id: '1', title: 'Incomplete' }).success).toBe(false);
    expect(productShape('ECOM').safeParse({ ...fixtures.ECOM, availability: 'invented' }).success).toBe(false);
    expect(productShape('MINI_SERIES').safeParse({ ...fixtures.MINI_SERIES, recharge: [{ type: 'BY_TIERS', purchase_unit: ['TIER_1'], cost: '1' }] }).success).toBe(false);
    expect(productShape('AUTO_MODEL').safeParse({ ...fixtures.AUTO_MODEL, year: 9007199254740992 }).success).toBe(false);
    expect(parseProduct('ECOM', { price_info: { sale_price: 1.25 } }, true)).toEqual({ price_info: { sale_price: 1.25 } });
    expect(productShape('FLIGHT', true).safeParse({ flight_id: 'native-only' }).success).toBe(false);
  });
});

describe('TikTok scoped product authoring', () => {
  it('defines five specialist workflows once and serves the schema for the actual granted catalog type', async () => {
    const f = await setup(), definitions = tiktokTools(f.provider);
    expect(new Set(definitions.map(tool => tool.name)).size).toBe(definitions.length);
    const names = ['tiktok_catalog_product_schema', 'tiktok_catalog_product_context', 'tiktok_upsert_catalog_products', 'tiktok_update_catalog_products', 'tiktok_delete_catalog_products'];
    for (const name of names) expect(definitions.find(tool => tool.name === name)!.catalog).toEqual({ category: 'creatives', exposure: 'specialist' });
    const result = await f.provider.catalogs.productAuthoring.schema(selection);
    expect(result).toMatchObject({ catalog_type: 'ECOM', native_batch_limit: 5000, schema: { properties: { sku_id: { type: 'string' }, price_info: { type: 'object' } }, required: expect.arrayContaining(['sku_id', 'price_info']) } });
    expect(f.writes()).toHaveLength(0);
  });
  it.each(['none', 'read'] as const)('refuses a write with %s catalog access before any POST', async mode => {
    const f = await setup(mode);
    const args = { ...(mode === 'none' ? { bc_id: B, catalog_id: C, feed_id: F, catalog_type: 'ECOM', expected_catalog_hash: 'a'.repeat(64), expected_feed_hash: 'a'.repeat(64), acknowledge_shared_effects: true, acknowledge_async_processing: true } : await f.hashes()), products: [fixtures.ECOM], acknowledge_replacement: true };
    await expect(f.provider.previewWrite(f.op('tiktok_upsert_catalog_products', args), guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(f.writes()).toHaveLength(0);
    if (mode === 'none') expect(f.calls).toHaveLength(0);
  });
  it('reads exact IDs/configuration, hides source capabilities and ignores volatile audit state in snapshots', async () => {
    const f = await setup('read'), context = await f.context();
    expect(context).toMatchObject({ catalog_type: 'ECOM', selection_complete: true, truncated: false, products: [{ product_id: P, external_identity: { sku_id: '00012' }, image_url: { origin: 'https://images.example', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } }] });
    expect(JSON.stringify(context)).not.toContain('PRIVATE-CAPABILITY');
    f.state.products[0]!.audit = { audit_status: 'approved' };expect((await f.context()).products_hash).toBe(context.products_hash);
    f.state.products[0]!.price_info.price = 30;expect((await f.context()).products_hash).not.toBe(context.products_hash);
    const call = f.calls.find(call => call.url.pathname.endsWith('/catalog/product/get/'))!;
    expect(JSON.parse(call.url.searchParams.get('product_ids')!)).toEqual([P]);expect(call.url.searchParams.get('page_size')).toBe('100');expect(new Headers(call.init.headers).get('content-type')).toBe('application/json');
  });
  it.each([{ product_id: '999' }, { product_id: 9007199254740992 }, { catalog_id: '999' }, { bc_id: '999' }, { feed_id: '999' }])('rejects foreign, unsafe or conflicting selected product data: %j', async change => {
    const f = await setup();f.state.override = url => url.pathname.endsWith('/catalog/product/get/') ? { list: [{ ...f.state.products[0], ...change }] } : undefined;
    await expect(f.context()).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('pages/chunks exact native ID lookups and does not confuse a missing selection with empty catalog inventory', async () => {
    const f = await setup();f.state.products = Array.from({ length: 1001 }, (_, index) => ({ product_id: String(index + 1), ...fixtures.ECOM, sku_id: 'sku-' + index }));
    const result = await f.context();expect(result.products).toHaveLength(1001);
    const requests = f.calls.filter(call => call.url.pathname.endsWith('/catalog/product/get/'));
    expect(requests).toHaveLength(11);expect(JSON.parse(requests[0]!.url.searchParams.get('product_ids')!)).toHaveLength(1000);expect(JSON.parse(requests.at(-1)!.url.searchParams.get('product_ids')!)).toEqual(['1001']);
    await expect(f.provider.catalogs.productAuthoring.context({ ...selectedFeed, product_ids: ['9999'] })).rejects.toThrow('Not every selected');
  });
  it.each(Object.keys(fixtures) as CatalogProductKind[])('submits the exact %s JSON upsert shape once, after a local preview, and returns an accepted task', async type => {
    const f = await setup();f.state.parent.catalog_type = type;
    const args = { ...await f.hashes(), products: [fixtures[type]], acknowledge_replacement: true }, op = f.op('tiktok_upsert_catalog_products', args);
    const preview = await f.provider.previewWrite(op, guard);expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], review: { title: 'Upload catalog products', fields: expect.arrayContaining([{ label: 'Products', after: 1 }]) } });expect(f.writes()).toHaveLength(0);expect(JSON.stringify(preview)).not.toContain('PRIVATE-CAPABILITY');
    expect(await f.provider.applyWrite(op, guard)).toMatchObject({ resourceIds: [J], details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, next_tool: 'tiktok_catalog_product_log', next_arguments: { ...selectedFeed, feed_log_id: J } } });
    expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.url.pathname).toBe('/open_api/v1.3/catalog/product/upload/');
    expect(f.writes()[0]!.body).toEqual({ bc_id: B, catalog_id: C, feed_id: F, products: [fixtures[type]] });expect(new Headers(f.writes()[0]!.init.headers).get('content-type')).toBe('application/json');
  });
  it('requires explicit replacement acknowledgement and rejects duplicate external identities and oversized payloads', async () => {
    const f = await setup(), base = { ...await f.hashes(), products: [fixtures.ECOM] };
    await expect(f.provider.previewWrite(f.op('tiktok_upsert_catalog_products', base), guard)).rejects.toThrow();
    await expect(f.provider.previewWrite(f.op('tiktok_upsert_catalog_products', { ...base, products: [fixtures.ECOM, fixtures.ECOM], acknowledge_replacement: true }), guard)).rejects.toThrow('unique');
    await expect(f.provider.previewWrite(f.op('tiktok_upsert_catalog_products', { ...base, products: Array.from({ length: 300 }, (_, i) => ({ ...fixtures.ECOM, sku_id: String(i), description: 'a'.repeat(10000) })), acknowledge_replacement: true }), guard)).rejects.toThrow('2 MiB');expect(f.writes()).toHaveLength(0);
  });
  it('binds patches to native product snapshots and sends only editable fields plus the verified external identity', async () => {
    const f = await setup(), current = await f.context(), args = { ...await f.hashes(), expected_products_hash: current.products_hash, updates: [{ product_id: P, fields: { title: 'New name', price_info: { sale_price: 12.25 } } }] }, op = f.op('tiktok_update_catalog_products', args);
    expect(await f.provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false, review: { title: 'Edit catalog products' } });expect(f.writes()).toHaveLength(0);
    f.state.products[0]!.title = 'Changed elsewhere';await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.writes()).toHaveLength(0);
    f.state.products[0]!.title = fixtures.ECOM.title;await f.provider.applyWrite(op, guard);
    expect(f.writes()[0]!.body).toEqual({ bc_id: B, catalog_id: C, feed_id: F, products: [{ sku_id: '00012', title: 'New name', price_info: { sale_price: 12.25 } }] });expect(f.writes()[0]!.url.pathname).toBe('/open_api/v1.3/catalog/product/update/');
  });
  it.each([{ sku_id: 'other' }, { product_id: 'other' }, {}, { unsupported_field: 'x' }])('refuses immutable, empty or unsupported product patches: %j', async fields => {
    const f = await setup(), context = await f.context();
    await expect(f.provider.previewWrite(f.op('tiktok_update_catalog_products', { ...await f.hashes(), expected_products_hash: context.products_hash, updates: [{ product_id: P, fields }] }), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('derives flight update identity from the native airport pair and maps deletion to generated flight_ids', async () => {
    const f = await setup();f.state.parent.catalog_type = 'FLIGHT';f.state.products = [{ ...fixtures.FLIGHT, product_id: P, flight_id: 'generated-flight-1' }];
    const context = await f.context(), common = { ...await f.hashes(), expected_products_hash: context.products_hash };
    await f.provider.applyWrite(f.op('tiktok_update_catalog_products', { ...common, updates: [{ product_id: P, fields: { description: 'Changed copy' } }] }), guard);
    expect(f.writes()[0]!.body!.products).toEqual([{ origin_airport: 'BER', destination_airport: 'SIN', description: 'Changed copy' }]);
    await f.provider.applyWrite(f.op('tiktok_delete_catalog_products', { ...common, product_ids: [P], acknowledge_removal: true }), guard);
    expect(f.writes()[1]!.body).toEqual({ bc_id: B, catalog_id: C, feed_id: F, flight_ids: ['generated-flight-1'] });
  });
  it.each([['ECOM', 'sku_ids', '00012'], ['HOTEL', 'hotel_ids', 'hotel-1'], ['DESTINATION', 'destination_ids', 'destination-1'], ['AUTO_VEHICLE', 'vehicle_ids', 'vehicle-1'], ['AUTO_MODEL', 'vehicle_ids', 'model-1'], ['MINI_SERIES', 'series_ids', 'series-1'], ['GENERIC', 'item_ids', 'item-1'], ['ONLINE_TO_OFFLINE', 'listing_ids', 'listing-1']] as const)('uses documented %s deletion selector %s, with exact readback task scope', async (type, selector, externalId) => {
    const f = await setup();f.state.parent.catalog_type = type;f.state.products = [{ product_id: P, ...fixtures[type] }];
    const context = await f.context(), op = f.op('tiktok_delete_catalog_products', { ...await f.hashes(), expected_products_hash: context.products_hash, product_ids: [P], acknowledge_removal: true });
    expect(await f.provider.previewWrite(op, guard)).toMatchObject({ review: { kind: 'remove' }, serverValidated: false });expect(f.writes()).toHaveLength(0);
    await f.provider.applyWrite(op, guard);expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toEqual({ bc_id: B, catalog_id: C, feed_id: F, [selector]: [externalId] });
  });
  it('refuses undocumented Entertainment deletion rather than inventing a media_title_ids selector', async () => {
    const f = await setup();f.state.parent.catalog_type = 'ENTERTAINMENT';f.state.products = [{ ...fixtures.ENTERTAINMENT, product_id: P }];
    const current = await f.context();await expect(f.provider.previewWrite(f.op('tiktok_delete_catalog_products', { ...await f.hashes(), expected_products_hash: current.products_hash, product_ids: [P], acknowledge_removal: true }), guard)).rejects.toThrow('does not document an Entertainment');expect(f.writes()).toHaveLength(0);
  });
  it.each(['native', 'transport', 'readback', 'bad-id', 'wrong-feed', 'failed', 'item-error'])('does not replay an uncertain submission (%s) and preserves known job IDs', async failure => {
    const f = await setup();f.state.failure = failure;
    if (failure === 'bad-id') f.state.receipt.feed_log_id = 9007199254740992;
    if (failure === 'wrong-feed') f.state.job.feed_id = '999';
    if (failure === 'failed') f.state.job.process_status = 'FAILED';
    if (failure === 'item-error') f.state.job.error_count = 1;
    const op = f.op('tiktok_upsert_catalog_products', { ...await f.hashes(), products: [fixtures.ECOM], acknowledge_replacement: true });
    let caught: unknown;try { await f.provider.applyWrite(op, guard); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);expect(String(caught)).not.toContain('PRIVATE-CAPABILITY');expect(f.writes()).toHaveLength(1);
    if (['readback', 'wrong-feed', 'failed', 'item-error'].includes(failure)) expect(caught).toMatchObject({ details: { resourceIds: [J], feed_log_id: J } });
  });
  it('rechecks catalog/feed configuration and revoked grants before writes', async () => {
    const f = await setup(), args = { ...await f.hashes(), products: [fixtures.ECOM], acknowledge_replacement: true }, op = f.op('tiktok_upsert_catalog_products', args);
    f.state.feed.feed_name = 'Changed';await expect(f.provider.previewWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    f.state.feed.feed_name = 'JSON feed';const current = await f.store.get(grantScope);await f.store.compareAndSet(grantScope, current.hash, 'read');await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(f.writes()).toHaveLength(0);
  });
  it('resolves central Adport assets at apply, reuses verified sources and never exposes private grants in previews/results', async () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNDsAAAAASUVORK5CYII=', 'base64'), sha = createHash('sha256').update(bytes).digest('hex'), mediaId = '11111111-1111-4111-8111-111111111111';let reads = 0, grants = 0;
    const media: MediaResolver = { async read(source, options) { reads++;return verifyMedia(bytes, 'QA.png', source.expected_sha256, options); }, async providerUrl() { grants++;return { url: privateUrl, sha256: sha, expires_at: new Date(Date.now() + 3600_000).toISOString() }; } };
    const f = await setup('write', media), { image_url: _image, ...base } = fixtures.ECOM;
    const assets = [0, 1].map(product_index => ({ product_index, field: 'image_url', media_id: mediaId, expected_sha256: sha }));
    const args = { ...await f.hashes(), products: [base, { ...base, sku_id: 'second' }], media_assets: assets, acknowledge_replacement: true }, op = f.op('tiktok_upsert_catalog_products', args);
    const preview = await f.provider.previewWrite(op, guard);expect(reads).toBe(1);expect(grants).toBe(0);expect(JSON.stringify(preview)).toContain(mediaId);expect(JSON.stringify(preview)).not.toContain('adport.invalid');
    const result = await f.provider.applyWrite(op, guard);expect(reads).toBe(3);expect(grants).toBe(1);expect(f.writes()[0]!.body!.products.map((row: Row) => row.image_url)).toEqual([privateUrl, privateUrl]);expect(result).toMatchObject({ details: { source_media_assets: assets } });expect(JSON.stringify({ preview, result })).not.toContain('PRIVATE-CAPABILITY');
  });
  it('supports media-only product patches and refuses stale bytes before any native submission', async () => {
    let bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNDsAAAAASUVORK5CYII=', 'base64');const sha = createHash('sha256').update(bytes).digest('hex');
    const f = await setup('write', { async read(source, options) { return verifyMedia(bytes, 'QA.png', source.expected_sha256, options); }, async providerUrl() { return { url: privateUrl, sha256: sha, expires_at: new Date(Date.now() + 3600_000).toISOString() }; } });
    const context = await f.context(), args = { ...await f.hashes(), expected_products_hash: context.products_hash, updates: [{ product_id: P, fields: {} }], media_assets: [{ product_index: 0, field: 'image_url', media_id: '11111111-1111-4111-8111-111111111111', expected_sha256: sha }] }, op = f.op('tiktok_update_catalog_products', args);
    expect(await f.provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false });bytes = Buffer.concat([bytes, Buffer.from('changed')]);await expect(f.provider.applyWrite(op, guard)).rejects.toThrow('bytes/checksum verification failed');expect(f.writes()).toHaveLength(0);
  });
  it.each(['no-resolver', 'conflict', 'wrong-index', 'duplicate', 'gap', 'bad-grant'])('rejects unsafe project media references (%s)', async failure => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNDsAAAAASUVORK5CYII=', 'base64'), sha = createHash('sha256').update(bytes).digest('hex');
    const f = await setup('write', failure === 'no-resolver' ? undefined : { async read(source, options) { return verifyMedia(bytes, 'QA.png', source.expected_sha256, options); }, async providerUrl() { return { url: 'http://insecure.example/private.png', sha256: sha, expires_at: new Date(Date.now() + 1000).toISOString() }; } });
    const { image_url: _image, ...base } = fixtures.ECOM, asset = { product_index: failure === 'wrong-index' ? 2 : 0, field: failure === 'gap' ? 'additional_image_urls' : 'image_url', ...(failure === 'gap' ? { image_index: 1 } : {}), media_id: '11111111-1111-4111-8111-111111111111', expected_sha256: sha };
    const op = f.op('tiktok_upsert_catalog_products', { ...await f.hashes(), products: [failure === 'conflict' || failure === 'gap' ? fixtures.ECOM : base], media_assets: failure === 'duplicate' ? [asset, asset] : [asset], acknowledge_replacement: true });
    await expect(f.provider.applyWrite(op, guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('uses the shared policy gate, rejects changed arguments, consumes approval once and keeps private URL capabilities out of audit', async () => {
    const f = await setup(), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] });
    const args = { account_id: A, ...await f.hashes(), products: [fixtures.ECOM], acknowledge_replacement: true };
    const preview = await runtime.registry.call('tiktok_upsert_catalog_products', args, runtime.ctx) as Row;expect(preview.applied).toBe(false);expect(f.writes()).toHaveLength(0);
    await expect(runtime.registry.call('tiktok_upsert_catalog_products', { ...args, products: [{ ...fixtures.ECOM, title: 'Other' }], pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await expect(runtime.registry.call('tiktok_upsert_catalog_products', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).resolves.toMatchObject({ applied: true, result: { resourceIds: [J], details: { processed: false } } });
    await expect(runtime.registry.call('tiktok_upsert_catalog_products', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(f.writes()).toHaveLength(1);
    const logs = (await Promise.all((await readdir(join(f.dir, 'audit'))).map(file => readFile(join(f.dir, 'audit', file), 'utf8')))).join('\n');expect(logs).not.toContain('PRIVATE-CAPABILITY');expect(JSON.stringify(preview)).not.toContain('PRIVATE-CAPABILITY');
  });
});
