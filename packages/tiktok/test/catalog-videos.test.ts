import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, verifyMedia, type MediaLibrary, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTikTokCatalogAccessStore, catalogGrant } from '../src/catalog-access.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// Wire contracts: official catalog/video file,log,get,delete docs refreshed 2026-11-05:
// 1803655037415489,1803655061642242,1803655082498050,1803655103069185.
// Current official SDK f809c396520d also confirms composite video-ID array filters and POST deletion.
// CSV column facts use the official parameter table; public template cells/native eligibility are not live-verified.
const A = '7111000000000000001', B = '111', C = '222', J = '9007199254740993', M = '11111111-1111-4111-8111-111111111111';
const V = '1234567891234567891_1234567891234567891_12345678912345_12345678-a12b-34cd-ef56-7gh89i1j2k3l';
const selection = { account_id: A, bc_id: B, catalog_id: C }, grantScope = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const }, guard = { forcePausedCreation: true };
const csvUrl = 'https://storage.example/private.csv?token=PRIVATE-CSV-GRANT', videoUrl = 'https://source.example/clip.mp4?token=PRIVATE-VIDEO-SOURCE', previewUrl = 'https://v16-tiktokcdn-com.akamaized.net/native-catalog.mp4';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Row = Record<string, any>;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(mode: 'none' | 'read' | 'write' = 'write') {
  const dir = await mkdtemp(join(tmpdir(), 'adport-catalog-video-'));dirs.push(dir);
  const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));if (mode !== 'none') await store.compareAndSet(grantScope, catalogGrant(grantScope).hash, mode);
  const state = { parent: { catalog_id: C, catalog_name: 'QA', catalog_type: 'ECOM', bc_info: { bc_id: B }, catalog_conf: { currency: 'EUR', is_multi_country: false as boolean | undefined } },
    videos: [{ catalog_video_id: V, video_name: 'Clip <script>', video_link: videoUrl, sku_id_list: ['00012', 'sku-2'], status: 'SUCCESS', active_status: 'ACTIVATED', video_id: 'v10044g5000native', preview_url: previewUrl, description: 'QA copy', video_signature: 'a'.repeat(32), create_time: '2026-11-05 00:00:00' }, { catalog_video_id: 'second-composite_id', video_name: 'Extracting', video_link: videoUrl, sku_id_list: ['00012'], status: 'PENDING', active_status: 'DEACTIVATED', preview_url: previewUrl }] as Row[],
    products: [{ sku_id: '00012', product_id: '9007199254740994', ad_creation_eligible: 'AVAILABLE' }, { sku_id: 'sku-2', product_id: '42', ad_creation_eligible: 'AVAILABLE' }] as Row[],
    csv: Buffer.from('video_name,video_link,sku_id_list\r\n"Clip, QA",' + videoUrl + ',"00012,sku-2"\r\n'),
    job: { catalog_id: C, feed_id: '333', process_status: 'PROCESSING', add_count: 1, error_count: 0 } as Row, diagnostics: undefined as Row | undefined, receipt: { feed_log_id: J } as Row,
    failure: '', grant: { url: csvUrl, sha256: '', expires_at: new Date(Date.now() + 3600_000).toISOString() }, grantCalls: 0, mediaReads: 0, tracked: [] as unknown[], accountCopies: [V], override: undefined as ((url: URL, init: RequestInit) => unknown) | undefined };
  const calls: Array<{ url: URL; init: RequestInit; body?: Row }> = [];
  const media: MediaLibrary = { list: async () => ({ assets: [], truncated: false }), async read(source, options) { state.mediaReads++;if (state.failure === 'media') throw new Error(csvUrl);return verifyMedia(state.csv, 'Catalog videos.csv', source.expected_sha256, options); }, async providerUrl() { state.grantCalls++;if (state.failure === 'staging') throw new Error(csvUrl);return { ...state.grant, sha256: state.grant.sha256 || sha(state.csv) }; }, async trackUpload(input, execute) { state.tracked.push(input);return execute(); } };
  const client = new TikTokClient({ accessToken: 'inert-token' }, async (raw, init = {}) => {
    const url = new URL(String(raw)), body = init.body ? JSON.parse(String(init.body)) : undefined;calls.push({ url, init, body });const ok = (data: unknown) => Response.json({ code: 0, data });
    const override = state.override?.(url, init);if (override !== undefined) return override instanceof Response ? override : ok(override);
    if (url.pathname.endsWith('/catalog/get/')) return ok({ list: [state.parent] });
    if (url.pathname.endsWith('/catalog/video/get/')) {
      if (state.failure === 'delete-readback' && !state.videos.length) throw new Error(csvUrl);
      const ids = url.searchParams.has('catalog_video_ids') ? JSON.parse(url.searchParams.get('catalog_video_ids')!) : undefined, page = Number(url.searchParams.get('page') ?? 1), size = Number(url.searchParams.get('page_size') ?? 20);
      return ok(ids ? { videos: state.videos.filter(row => ids.includes(row.catalog_video_id)) } : { videos: state.videos.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_number: state.videos.length, total_page: Math.ceil(state.videos.length / size) } });
    }
    if (url.pathname.endsWith('/catalog/product/get/')) {
      const ids = JSON.parse(url.searchParams.get('sku_ids')!), page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('page_size')), rows = state.products.filter(row => ids.includes(row.sku_id));
      return ok({ list: rows.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_page: Math.ceil(rows.length / size), total_number: rows.length } });
    }
    if (url.pathname.endsWith('/catalog/video/log/')) { if (state.failure === 'readback') throw new Error(csvUrl);return ok({ video_feed_log: state.job, ...(state.diagnostics ? { feed_log_data: state.diagnostics } : {}) }); }
    if (init.method === 'POST') {
      if (state.failure === 'transport') throw new Error(csvUrl);if (state.failure === 'native') return Response.json({ code: 40001, message: csvUrl, request_id: 'request_qa' });
      if (url.pathname.endsWith('/catalog/video/file/')) return ok(state.receipt);
      if (url.pathname.endsWith('/catalog/video/delete/')) { if (state.failure !== 'delete-remains') state.videos = state.videos.filter(row => !body.catalog_video_ids.includes(row.catalog_video_id));return ok({}); }
    }
    throw new Error('Unexpected fixture endpoint');
  });
  const provider = new TikTokAdsProvider(client, { appId: 'inert', secret: 'inert' }, media, store), source = () => ({ ...selection, media_id: M, expected_sha256: sha(state.csv) });
  const context = () => provider.catalogs.videos.importContext(source());
  const args = async () => { const current = await context();return { bc_id: B, catalog_id: C, media_id: M, expected_sha256: sha(state.csv), expected_catalog_hash: current.expected_catalog_hash, expected_associations_hash: current.expected_associations_hash, acknowledge_shared_effects: true, acknowledge_possible_delivery: true, acknowledge_async_processing: true }; };
  const op = (tool: string, payload: Row): WriteOperation => ({ tool, provider: 'tiktok', accountId: A, kind: tool === 'tiktok_upload_catalog_videos' ? 'create' : 'remove', payload });
  const deleteArgs = async () => ({ bc_id: B, catalog_id: C, catalog_video_id: V, expected_configuration_hash: (await provider.catalogs.videos.list({ ...selection, catalog_video_ids: [V] })).videos[0]!.configuration_hash, acknowledge_shared_effects: true });
  return { dir, state, store, media, calls, provider, source, context, args, op, deleteArgs, writes: () => calls.filter(call => call.init.method === 'POST') };
}

describe('TikTok catalog video gallery and task reads', () => {
  it('defines five specialist workflows once, distinguishing reads from shared destructive changes', async () => {
    const f = await setup(), definitions = tiktokTools(f.provider), names = ['tiktok_catalog_videos', 'tiktok_catalog_video_log', 'tiktok_catalog_video_import_context', 'tiktok_upload_catalog_videos', 'tiktok_delete_catalog_video'];
    expect(new Set(definitions.map(tool => tool.name)).size).toBe(definitions.length);
    for (const name of names) expect(definitions.find(tool => tool.name === name)!.catalog).toEqual({ category: 'creatives', exposure: 'specialist' });
    expect(definitions.find(tool => tool.name === 'tiktok_upload_catalog_videos')!.annotations).toMatchObject({ readOnly: false, destructive: true });
    const gallery = await f.provider.catalogs.videos.list(selection);expect(definitions.find(tool => tool.name === 'tiktok_catalog_videos')!.output!.safeParse(gallery).success).toBe(true);
  });
  it('keeps composite IDs, native extraction/activation states and safe preview media without exposing original sources', async () => {
    const f = await setup(), result = await f.provider.catalogs.videos.list(selection);
    expect(result.videos[0]).toMatchObject({ catalog_video_id: V, status: 'SUCCESS', active_status: 'ACTIVATED', preview_url: previewUrl, source: { origin: 'https://source.example' } });
    expect(result.creatives[0]).toMatchObject({ id: V, type: 'catalog_video', status: 'SUCCESS · ACTIVATED', media: [{ type: 'video', url: previewUrl }], actions: [{ tool: 'tiktok_delete_catalog_video', arguments: { ...selection, catalog_video_id: V } }] });
    expect(result.creatives[1]!.media).toEqual([]);expect(result.creatives[0]!.actions[0]!.arguments).not.toHaveProperty('pending_operation_id');expect(JSON.stringify(result)).not.toContain('PRIVATE-VIDEO-SOURCE');expect(f.writes()).toHaveLength(0);
  });
  it('hides mutation actions for resource-read-only grants', async () => {
    const f = await setup('read'), result = await f.provider.catalogs.videos.list(selection);expect(result.creatives.every(row => !row.actions.length)).toBe(true);
  });
  it('encodes fixed-ID filters as arrays, ignores all pagination and reports missing IDs as a filtered view', async () => {
    const f = await setup();f.state.override = url => url.pathname.endsWith('/catalog/video/get/') ? { videos: [f.state.videos[0]], page_info: { page: 0, page_size: 9999, total_page: 'ignored' } } : undefined;
    const result = await f.provider.catalogs.videos.list({ ...selection, catalog_video_ids: [V, 'missing-id'], page: 90, page_size: 1 });
    expect(result).toMatchObject({ complete: true, truncated: false, missing_ids: ['missing-id'] });expect(result).not.toHaveProperty('next_page');
    const url = f.calls.at(-1)!.url;expect(JSON.parse(url.searchParams.get('catalog_video_ids')!)).toEqual([V, 'missing-id']);expect(url.searchParams.has('page')).toBe(false);expect(url.searchParams.has('page_size')).toBe(false);
  });
  it('uses native pagination, and leaves missing/contradictory completeness unknown', async () => {
    const f = await setup(), first = await f.provider.catalogs.videos.list({ ...selection, page_size: 1 });expect(first).toMatchObject({ complete: false, next_page: 2, truncated: true });
    for (const page_info of [undefined, { page: 1, page_size: 20, total_number: 200, total_page: 1 }]) {
      f.state.override = url => url.pathname.endsWith('/catalog/video/get/') ? { videos: f.state.videos, ...(page_info ? { page_info } : {}) } : undefined;
      const result = await f.provider.catalogs.videos.list(selection);expect(result.complete).toBeNull();expect(result.truncated).toBe(true);expect(result).not.toHaveProperty('next_page');
    }
  });
  it.each([{ catalog_video_id: 9007199254740992 }, { catalog_video_id: 'other-id' }, { catalog_id: '999' }, { bc_id: '999' }])('rejects conflicting exact-ID scope: %j', async change => {
    const f = await setup();f.state.override = url => url.pathname.endsWith('/catalog/video/get/') ? { videos: [{ ...f.state.videos[0], ...change }] } : undefined;
    await expect(f.provider.catalogs.videos.list({ ...selection, catalog_video_ids: [V] })).rejects.toThrow();
  });
  it('does not upgrade unsafe preview URLs and rejects duplicate video rows', async () => {
    const f = await setup();f.state.videos[0]!.preview_url = 'http://insecure.example/movie.mp4';expect((await f.provider.catalogs.videos.list(selection)).creatives[0]!.media).toEqual([]);
    f.state.videos = [f.state.videos[0]!, f.state.videos[0]!];await expect(f.provider.catalogs.videos.list(selection)).rejects.toThrow('unexpected');
  });
  it('keeps expiring preview/extraction changes out of edit snapshots and binds actual configuration', async () => {
    const f = await setup(), initial = await f.deleteArgs();
    Object.assign(f.state.videos[0]!, { preview_url: previewUrl + '?new=1', status: 'PENDING', video_id: 'new-extraction-id', video_signature: 'b'.repeat(32), create_time: '' });expect((await f.deleteArgs()).expected_configuration_hash).toBe(initial.expected_configuration_hash);
    f.state.videos[0]!.active_status = 'DEACTIVATED';expect((await f.deleteArgs()).expected_configuration_hash).not.toBe(initial.expected_configuration_hash);
  });
  it('reads native task states and bounded diagnostic field counts without source links, samples or invented counters', async () => {
    const f = await setup();f.state.diagnostics = { download_path: { en: csvUrl }, error_affected_videos: Array.from({ length: 52 }, (_, i) => ({ field: i ? 'video_link' : videoUrl, affected_video_count: 1, issue: csvUrl, suggestion: videoUrl, affected_video_item_list: [{ video_link: videoUrl }] })) };
    delete f.state.job.error_count;f.state.job.process_status = 'SUCCESS';const result = await f.provider.catalogs.videos.log({ ...selection, feed_log_id: J });
    expect(result).toMatchObject({ processing_complete: true, has_item_errors: null, log: { feed_log_id: J, diagnostic_fields_truncated: true } });expect(result.log.error_fields).toHaveLength(50);expect(result.log.error_fields![0]).toEqual({ field: 'Unrecognized field', affected_video_count: 1 });expect(result.log.error_count).toBeUndefined();expect(JSON.stringify(result)).not.toContain('PRIVATE-');
    const url = f.calls.at(-1)!.url;expect(Object.fromEntries(url.searchParams)).toEqual({ bc_id: B, catalog_id: C, feed_log_id: J, language: 'en' });expect(url.pathname).toBe('/open_api/v1.3/catalog/video/log/');
  });
  it.each([{ catalog_id: '999' }, { bc_id: '999' }, { feed_log_id: '999' }])('rejects a task with conflicting scope: %j', async value => {
    const f = await setup();Object.assign(f.state.job, value);await expect(f.provider.catalogs.videos.log({ ...selection, feed_log_id: J })).rejects.toThrow('unexpected');
  });
  it('bounds large gallery metadata while keeping full values bound to deletion snapshots', async () => {
    const f = await setup();f.state.videos[0]!.custom_label_0 = 'x'.repeat(1200);const first = await f.provider.catalogs.videos.list({ ...selection, catalog_video_ids: [V] });
    expect(first.videos[0]!.custom_label_0).toHaveLength(1000);expect(first.videos[0]!.metadata_truncated_fields).toEqual(['custom_label_0']);f.state.videos[0]!.custom_label_0 += 'changed';const second = await f.provider.catalogs.videos.list({ ...selection, catalog_video_ids: [V] });expect(second.videos[0]!.configuration_hash).not.toBe(first.videos[0]!.configuration_hash);
  });
});

describe('TikTok catalog video import context and writes', () => {
  it('validates exact CSV bytes and every eligible SKU, retaining leading zeros and keeping source URLs private', async () => {
    const f = await setup(), context = await f.context();
    expect(context).toMatchObject({ source_media_id: M, source_sha256: sha(f.state.csv), video_rows: 1, unique_skus: 2, records: [{ name: 'Clip, QA', sku_ids: ['00012', 'sku-2'] }] });expect(JSON.stringify(context)).not.toContain('PRIVATE-');expect(f.state.grantCalls).toBe(0);expect(f.writes()).toHaveLength(0);
    const request = f.calls.find(call => call.url.pathname.endsWith('/catalog/product/get/'))!;expect(JSON.parse(request.url.searchParams.get('sku_ids')!)).toEqual(['00012', 'sku-2']);expect(request.url.searchParams.get('page_size')).toBe('500');
  });
  it.each(['none', 'read'] as const)('rejects upload with %s resource access before any POST', async mode => {
    const f = await setup(mode), args = mode === 'none' ? { bc_id: B, catalog_id: C, media_id: M, expected_sha256: sha(f.state.csv), expected_catalog_hash: 'a'.repeat(64), expected_associations_hash: 'a'.repeat(64), acknowledge_shared_effects: true, acknowledge_possible_delivery: true, acknowledge_async_processing: true } : await f.args();
    await expect(f.provider.previewWrite(f.op('tiktok_upload_catalog_videos', args), guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(f.writes()).toHaveLength(0);if (mode === 'none') expect(f.calls).toHaveLength(0);
  });
  it.each(['HOTEL', 'MULTI_COUNTRY'])('refuses documented ineligible catalog type %s', async type => {
    const f = await setup();if (type === 'HOTEL') f.state.parent.catalog_type = type;else f.state.parent.catalog_conf.is_multi_country = true;await expect(f.context()).rejects.toThrow('single-country E-commerce');expect(f.state.mediaReads).toBe(0);
  });
  it.each([
    'video_name,video_link\nName,https://example.com/a.mp4\n',
    'video_name,video_link,sku_id_list,video_name\nName,https://example.com/a.mp4,00012,Again\n',
    'video_name,video_link,sku_id_list,active_status\nName,https://example.com/a.mp4,00012,ACTIVATED\n',
    'video_name,video_link,sku_id_list\n',
    'video_name,video_link,sku_id_list\nName,javascript:alert(1),00012\n',
    'video_name,video_link,sku_id_list\nName,https://user:pass@example.com/a.mp4,00012\n',
    'video_name,video_link,sku_id_list\nName,https://example.com/a.mp4,"00012,00012"\n',
    'video_name,video_link,sku_id_list\nName,https://example.com/a.mp4,"00012, sku-2"\n',
    'video_name,video_link,sku_id_list\nName,https://example.com/a.mp4,"' + Array.from({ length: 21 }, (_, i) => 's' + i).join(',') + '"\n',
    'video_name,video_link,sku_id_list,description\nName,https://example.com/a.mp4,00012,' + 'a'.repeat(501) + '\n',
  ])('rejects malformed/unsupported video CSV before SKU reads: %s', async csv => {
    const f = await setup();f.state.csv = Buffer.from(csv);await expect(f.context()).rejects.toThrow();expect(f.calls.some(call => call.url.pathname.endsWith('/catalog/product/get/'))).toBe(false);expect(f.writes()).toHaveLength(0);
  });
  it.each(['missing', 'ineligible', 'foreign', 'unsafe'])('does not certify invalid SKU associations (%s)', async failure => {
    const f = await setup();if (failure === 'missing') f.state.products.pop();if (failure === 'ineligible') f.state.products[0]!.ad_creation_eligible = 'NOT_AVAILABLE';if (failure === 'foreign') f.state.products[0]!.catalog_id = '999';if (failure === 'unsafe') f.state.products[0]!.product_id = 9007199254740992;await expect(f.context()).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('chunks SKU verification and pages at the documented 500-row limit for large imports', async () => {
    const f = await setup();f.state.products = Array.from({ length: 1001 }, (_, i) => ({ sku_id: 'sku-' + i, product_id: String(i + 1), ad_creation_eligible: 'AVAILABLE' }));f.state.csv = Buffer.from('video_name,video_link,sku_id_list\n' + f.state.products.map((row, i) => `Clip${i},https://example.com/${i}.mp4,${row.sku_id}\n`).join(''));
    const result = await f.context();expect(result).toMatchObject({ video_rows: 1001, unique_skus: 1001, truncated: true });expect(result.records).toHaveLength(20);expect(f.calls.filter(call => call.url.pathname.endsWith('/catalog/product/get/'))).toHaveLength(3);
  });
  it('previews locally, stages only at apply, sends the documented file request and returns acceptance with sync unconfirmed', async () => {
    const f = await setup(), op = f.op('tiktok_upload_catalog_videos', await f.args());const preview = await f.provider.previewWrite(op, guard);expect(preview).toMatchObject({ serverValidated: false, coercions: [], budgetDeltas: [], review: { title: 'Upload catalog videos', fields: expect.arrayContaining([{ label: 'Ad-account copy requested', after: 'No' }]) } });expect(f.state.grantCalls).toBe(0);expect(f.writes()).toHaveLength(0);
    const result = await f.provider.applyWrite(op, guard);expect(result).toMatchObject({ resourceIds: [J], details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, advertiser_sync_requested: false, advertiser_sync_confirmed: false, next_tool: 'tiktok_catalog_video_log', next_arguments: { ...selection, feed_log_id: J } } });expect(f.state.grantCalls).toBe(1);expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0]!.url.pathname).toBe('/open_api/v1.3/catalog/video/file/');expect(f.writes()[0]!.body).toEqual({ bc_id: B, catalog_id: C, file_url: csvUrl });expect(new Headers(f.writes()[0]!.init.headers).get('content-type')).toBe('application/json');expect(JSON.stringify({ preview, result })).not.toContain('PRIVATE-');
  });
  it('requires copy acknowledgement and scopes optional sync to the selected advertiser only', async () => {
    const f = await setup(), args = { ...await f.args(), sync_to_selected_account: true };
    await expect(f.provider.previewWrite(f.op('tiktok_upload_catalog_videos', args), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
    await f.provider.applyWrite(f.op('tiktok_upload_catalog_videos', { ...args, acknowledge_account_copy: true }), guard);expect(f.writes()[0]!.body!.advertiser_ids).toEqual([A]);
    await expect(f.provider.previewWrite(f.op('tiktok_upload_catalog_videos', { ...args, acknowledge_account_copy: true, advertiser_ids: ['foreign'] }), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(1);
  });
  it('rechecks mutable catalog/SKU snapshots and immutable media bytes at apply', async () => {
    const f = await setup(), args = await f.args(), op = f.op('tiktok_upload_catalog_videos', args);
    f.state.parent.catalog_name = 'Changed';await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });f.state.parent.catalog_name = 'QA';
    f.state.products[0]!.product_id = '99';await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });f.state.products[0]!.product_id = '9007199254740994';
    f.state.csv = Buffer.concat([f.state.csv, Buffer.from('changed')]);await expect(f.provider.applyWrite(op, guard)).rejects.toThrow('bytes/checksum');expect(f.writes()).toHaveLength(0);expect(f.state.grantCalls).toBe(0);
  });
  it.each(['wrong-sha', 'http', 'credentials', 'expired', 'staging'])('rejects unverified private staging (%s) without native submission', async failure => {
    const f = await setup(), op = f.op('tiktok_upload_catalog_videos', await f.args());
    if (failure === 'wrong-sha') f.state.grant.sha256 = 'a'.repeat(64);if (failure === 'http') f.state.grant.url = 'http://storage.example/a.csv';if (failure === 'credentials') f.state.grant.url = 'https://user:pass@storage.example/a.csv';if (failure === 'expired') f.state.grant.expires_at = new Date(Date.now() + 1000).toISOString();if (failure === 'staging') f.state.failure = failure;
    await expect(f.provider.applyWrite(op, guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it.each(['native', 'transport', 'bad-id', 'readback', 'wrong-catalog', 'failed', 'item-errors'])('never replays uncertain upload (%s), preserving a known job ID', async failure => {
    const f = await setup(), op = f.op('tiktok_upload_catalog_videos', await f.args());f.state.failure = failure;if (failure === 'bad-id') f.state.receipt.feed_log_id = 9007199254740992;if (failure === 'wrong-catalog') f.state.job.catalog_id = '999';if (failure === 'failed') f.state.job.process_status = 'FAILED';if (failure === 'item-errors') f.state.job.error_count = 1;
    let caught: unknown;try { await f.provider.applyWrite(op, guard); } catch (error) { caught = error; }expect(caught).toBeInstanceOf(Error);expect(String(caught)).not.toContain('PRIVATE-');expect(f.writes()).toHaveLength(1);
    if (['readback', 'wrong-catalog', 'failed', 'item-errors'].includes(failure)) expect(caught).toMatchObject({ details: { resourceIds: [J] } });if (failure === 'native') expect(caught).toMatchObject({ details: { provider_code: 40001 } });
  });
});

describe('TikTok catalog video removal and shared policy', () => {
  it('removes exactly one composite ID, verifies filtered absence and preserves advertiser copies', async () => {
    const f = await setup(), op = f.op('tiktok_delete_catalog_video', await f.deleteArgs());expect(await f.provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false, review: { kind: 'remove', subject: 'Clip <script>' } });expect(f.writes()).toHaveLength(0);
    expect(await f.provider.applyWrite(op, guard)).toMatchObject({ resourceIds: [V], details: { deletion_readback: 'ABSENT_FROM_FILTERED_CATALOG_VIEW', synced_copies_may_remain: true } });expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toEqual({ bc_id: B, catalog_id: C, catalog_video_ids: [V] });expect(f.writes()[0]!.url.pathname).toBe('/open_api/v1.3/catalog/video/delete/');expect(f.state.accountCopies).toEqual([V]);
  });
  it('rejects stale removal metadata and revoked resource access before a write', async () => {
    const f = await setup(), op = f.op('tiktok_delete_catalog_video', await f.deleteArgs());f.state.videos[0]!.video_name = 'Changed';await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });f.state.videos[0]!.video_name = 'Clip <script>';
    const grant = await f.store.get(grantScope);await f.store.compareAndSet(grantScope, grant.hash, 'read');await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(f.writes()).toHaveLength(0);
  });
  it.each(['delete-remains', 'delete-readback', 'native', 'transport'])('keeps removal unconfirmed on %s without replaying', async failure => {
    const f = await setup();f.state.videos = [f.state.videos[0]!];const op = f.op('tiktok_delete_catalog_video', await f.deleteArgs());f.state.failure = failure;
    await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ details: { resourceIds: [V] } });expect(f.writes()).toHaveLength(1);
  });
  it('uses the shared preview/token/audit path, rejects argument drift, tracks the source CSV and consumes approval once', async () => {
    const f = await setup(), runtime = await createContext({ media: f.media, engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] });
    const args = { account_id: A, ...await f.args() }, preview = await runtime.registry.call('tiktok_upload_catalog_videos', args, runtime.ctx) as Row;expect(preview.applied).toBe(false);expect(f.writes()).toHaveLength(0);
    await expect(runtime.registry.call('tiktok_upload_catalog_videos', { ...args, sync_to_selected_account: true, acknowledge_account_copy: true, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await expect(runtime.registry.call('tiktok_upload_catalog_videos', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).resolves.toMatchObject({ applied: true, result: { resourceIds: [J], details: { processed: false } } });expect(f.state.tracked).toEqual([{ media_id: M, expected_sha256: args.expected_sha256, provider: 'tiktok', account_id: A, tool: 'tiktok_upload_catalog_videos' }]);
    await expect(runtime.registry.call('tiktok_upload_catalog_videos', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(f.writes()).toHaveLength(1);
    const logs = (await Promise.all((await readdir(join(f.dir, 'audit'))).map(file => readFile(join(f.dir, 'audit', file), 'utf8')))).join('\n');expect(logs).not.toContain('PRIVATE-');expect(JSON.stringify(preview)).not.toContain('PRIVATE-');
  });
});
