import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

const account = '7111000000000000001', pixelId = '9007199254740993123';
const source = { pixel_id: pixelId, pixel_name: 'Synthetic Pixel', pixel_code: 'QA_PIXEL_CODE', advanced_matching_fields: { email: false, phone_number: true } };
type Row = Record<string, unknown>;
function fixture(options: { pixels?: Row[]; list?: Row; create?: Row; stats?: Row; ignoreUpdate?: boolean; readbackError?: boolean; readbackBusinessError?: boolean; businessError?: boolean; uncertainCreate?: boolean } = {}) {
  const pixels = new Map((options.pixels ?? [source]).map(value => [String(value.pixel_id), value]));
  const calls: Array<{ url: URL; init: RequestInit; body: Row }> = [];
  let written = false;
  const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert-fixture-token' }, (async (input, init = {}) => {
    const url = new URL(String(input)), body = typeof init.body === 'string' ? JSON.parse(init.body) as Row : {};
    calls.push({ url, init, body });
    if (options.businessError) return Response.json({ code: 40001, message: 'Advertiser permission denied', request_id: 'synthetic-request' });
    let data: unknown;
    if (url.pathname.endsWith('/list/')) {
      if (written && options.readbackBusinessError) return Response.json({ code: 40001, message: 'Readback permission denied', request_id: 'synthetic-readback' });
      if (written && options.readbackError) throw new Error('Unknown readback');
      const filter = url.searchParams.get('pixel_id'), page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('page_size'));
      const rows = [...pixels.values()].filter(value => !filter || String(value.pixel_id) === filter);
      data = options.list ?? { pixels: rows.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_page: Math.ceil(rows.length / size), total_number: rows.length } };
    } else if (url.pathname.endsWith('/create/')) {
      written = true; if (options.uncertainCreate) throw new Error('Connection interrupted');
      const { advertiser_id: _account, ...fields } = body;
      pixels.set(pixelId, { ...source, ...fields }); data = options.create ?? { ...source, ...fields };
    } else if (url.pathname.endsWith('/update/')) {
      written = true; if (!options.ignoreUpdate) pixels.set(pixelId, { ...pixels.get(pixelId), pixel_name: body.pixel_name, advanced_matching_fields: body.advanced_matching_fields });
      data = {};
    } else if (url.pathname.endsWith('/stats/')) data = options.stats ?? { list: [{ pixel_id: pixelId, event: 'ViewContent', count: 0 }] };
    else throw new Error('Unexpected test endpoint');
    return Response.json({ code: 0, message: 'OK', data });
  }) as typeof fetch), { appId: 'inert', secret: 'inert' });
  const tools = tiktokTools(provider);
  const op = (tool: string, input: Row) => {
    const { account_id, ...payload } = tools.find(value => value.name === tool)!.input.parse({ account_id: account, ...input }) as Row;
    return { tool, provider: 'tiktok', accountId: String(account_id), kind: tool.includes('update') ? 'update' as const : 'create' as const, payload };
  };
  return { provider, tools, calls, pixels, op };
}
const guard = { forcePausedCreation: true };

// TikTok-owned SDK f809c396: pixel_{list,create,update,event_stats}.yml request and response rules.
describe('TikTok Pixel management and statistics', () => {
  it('uses native filters, a20-row limit, token header and exact large IDs', async () => {
    const f = fixture();
    await f.provider.measurement.list({ account_id: account, pixel_id: pixelId, code: 'QA', name: 'Synthetic', order_by: 'LATEST_CREATE', filtering: { available_for_catalog_only: true } });
    const c = f.calls[0]!;
    expect(c.url.pathname).toBe('/open_api/v1.3/pixel/list/');
    expect(Object.fromEntries(c.url.searchParams)).toEqual({ advertiser_id: account, pixel_id: pixelId, code: 'QA', name: 'Synthetic', order_by: 'LATEST_CREATE', filtering: '{"available_for_catalog_only":true}', page: '1', page_size: '20' });
    expect(c.init.headers).toMatchObject({ 'Access-Token': 'inert-fixture-token' });expect(c.init.method).toBe('GET');
  });
  it('keeps the existing reader unique and rejects native-invalid page sizes', () => {
    const f = fixture(), tool = f.tools.find(value => value.name === 'tiktok_pixels')!;
    expect(f.tools.filter(value => value.name === tool.name)).toHaveLength(1);
    expect(tool.input.safeParse({ account_id: account, page_size: 21 }).success).toBe(false);
    expect(tool.input.parse({ account_id: account })).toHaveProperty('page_size', 20);
  });
  it('returns stable configuration hashes while ignoring changing diagnostic counters', async () => {
    const f = fixture(), before = (await f.provider.measurement.get(account, pixelId)).pixel;
    f.pixels.set(pixelId, { ...source, latest_event_count: 99 });
    expect((await f.provider.measurement.get(account, pixelId)).pixel.configuration_hash).toBe(before.configuration_hash);
    f.pixels.set(pixelId, { ...source, advanced_matching_fields: { email: true, phone_number: true } });
    expect((await f.provider.measurement.get(account, pixelId)).pixel.configuration_hash).not.toBe(before.configuration_hash);
  });
  it('preserves native pagination certainty and confirms an empty inventory only with paging', async () => {
    const f = fixture({ pixels: [source, { ...source, pixel_id: '123' }] });
    expect(await f.provider.measurement.list({ account_id: account, page_size: 1 })).toMatchObject({ complete: false, next_page: 2, truncated: true });
    expect(await f.provider.measurement.list({ account_id: account, page: 2, page_size: 1 })).toMatchObject({ complete: true, truncated: false });
    expect(await fixture({ pixels: [] }).provider.measurement.list({ account_id: account })).toMatchObject({ pixels: [], complete: true });
  });
  it.each([{ pixels: [] }, { pixels: [source], page_info: { page: 1, page_size: 20, total_page: 0, total_number: 0 } }, { pixels: [], page_info: { page: 1, page_size: 20, total_page: 0, total_number: 1 } }, { pixels: [], page_info: { page: 1, page_size: 20, total_page: 1, total_number: 1 } }])('does not claim completeness from missing or contradictory native paging: %o', async list => {
    expect(await fixture({ list }).provider.measurement.list({ account_id: account })).toMatchObject({ complete: null, truncated: true });
  });
  it.each([{}, { list: [] }, { pixels: [source, source] }, { pixels: [{ ...source, pixel_id: 9007199254740992 }] }, { pixels: [{ ...source, advertiser_id: '123' }] }, { pixels: [source], page_info: { page: 2, page_size: 20, total_page: 2 } }])('rejects unverifiable native rows or page identity: %o', async list => {
    const f = fixture({ list }); await expect(f.provider.measurement.list({ account_id: account })).rejects.toThrow('tiktok:');expect(f.calls.every(value => value.init.method === 'GET')).toBe(true);
  });
  it('rejects ignored ID filters and distinguishes missing data from unknown absence', async () => {
    await expect(fixture({ list: { pixels: [source] } }).provider.measurement.get(account, '404')).rejects.toThrow('does not match');
    await expect(fixture({ list: { pixels: [] } }).provider.measurement.get(account, pixelId)).rejects.toThrow('could not confirm absence');
    await expect(fixture({ pixels: [] }).provider.measurement.get(account, pixelId)).rejects.toThrow('was not found');
  });
  it('previews creation locally, sends only native fields once and independently verifies its ID', async () => {
    const f = fixture({ pixels: [] }), input = { pixel_name: 'QA Pixel', pixel_category: 'ONLINE_STORE', partner_name: 'QA' }, operation = f.op('tiktok_create_pixel', input);
    const preview = await f.provider.previewWrite(operation, guard);
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [] });expect(preview.notes?.join(' ')).toContain('native matching defaults');expect(f.calls).toHaveLength(0);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [pixelId] });
    const write = f.calls[0]!;expect(write.url.pathname).toBe('/open_api/v1.3/pixel/create/');expect(write.body).toEqual({ ...input, advertiser_id: account });expect(write.init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(f.calls[1]!.url.searchParams.get('pixel_id')).toBe(pixelId);expect(f.calls.filter(value => value.init.method === 'POST')).toHaveLength(1);
  });
  it.each([{ create: {} }, { create: { pixel_id: 9007199254740992 } }, { readbackError: true }, { uncertainCreate: true }])('never retries an unconfirmed creation: %o', async options => {
    const f = fixture(options);await expect(f.provider.applyWrite(f.op('tiktok_create_pixel', { pixel_name: 'QA' }), guard)).rejects.toThrow(/unconfirmed|no verified ID/);
    expect(f.calls.filter(value => value.init.method === 'POST')).toHaveLength(1);
  });
  it('preserves both matching flags during a name update and verifies native readback', async () => {
    const f = fixture(), current = (await f.provider.measurement.get(account, pixelId)).pixel;
    const operation = f.op('tiktok_update_pixel', { pixel_id: pixelId, expected_configuration_hash: current.configuration_hash, pixel_name: 'Renamed QA' });
    const preview = await f.provider.previewWrite(operation, guard);expect(f.calls.every(value => value.init.method === 'GET')).toBe(true);
    expect(preview.review?.fields).toEqual([{ label: 'Name', before: source.pixel_name, after: 'Renamed QA' }, { label: 'Email matching', before: false, after: false }, { label: 'Phone matching', before: true, after: true }]);
    expect(JSON.stringify(preview.review)).not.toContain('Protected data');
    expect(await f.provider.applyWrite(operation, guard)).toHaveProperty('applied', true);
    const writes = f.calls.filter(value => value.init.method === 'POST');expect(writes).toHaveLength(1);expect(writes[0]!.url.pathname).toBe('/open_api/v1.3/pixel/update/');
    expect(writes[0]!.body).toEqual({ advertiser_id: account, pixel_id: pixelId, pixel_name: 'Renamed QA', advanced_matching_fields: source.advanced_matching_fields });
  });
  it('supports explicit matching changes while preserving the current name', async () => {
    const f = fixture(), current = (await f.provider.measurement.get(account, pixelId)).pixel;
    await f.provider.applyWrite(f.op('tiktok_update_pixel', { pixel_id: pixelId, expected_configuration_hash: current.configuration_hash, advanced_matching_fields: { email: false, phone_number: false } }), guard);
    expect(f.calls.find(value => value.init.method === 'POST')!.body).toEqual({ advertiser_id: account, pixel_id: pixelId, pixel_name: source.pixel_name, advanced_matching_fields: { email: false, phone_number: false } });
  });
  it('rejects stale configurations before applying any update', async () => {
    const f = fixture(), current = (await f.provider.measurement.get(account, pixelId)).pixel;
    f.pixels.set(pixelId, { ...source, pixel_name: 'Changed elsewhere' });
    await expect(f.provider.applyWrite(f.op('tiktok_update_pixel', { pixel_id: pixelId, expected_configuration_hash: current.configuration_hash, pixel_name: 'QA' }), guard)).rejects.toThrow('configuration changed');expect(f.calls.some(value => value.init.method === 'POST')).toBe(false);
  });
  it('rejects unknown current matching settings rather than resetting omitted flags', async () => {
    const f = fixture({ pixels: [{ pixel_id: pixelId, pixel_name: 'QA' }] }), current = (await f.provider.measurement.get(account, pixelId)).pixel;
    await expect(f.provider.previewWrite(f.op('tiktok_update_pixel', { pixel_id: pixelId, expected_configuration_hash: current.configuration_hash, pixel_name: 'QA new' }), guard)).rejects.toThrow('matching settings could not be verified');expect(f.calls.some(value => value.init.method === 'POST')).toBe(false);
  });
  it.each([{ ignoreUpdate: true }, { readbackError: true }, { readbackBusinessError: true }])('does not report an update as applied without an exact independent readback: %o', async options => {
    const f = fixture(options), current = (await f.provider.measurement.get(account, pixelId)).pixel;
    await expect(f.provider.applyWrite(f.op('tiktok_update_pixel', { pixel_id: pixelId, expected_configuration_hash: current.configuration_hash, pixel_name: 'New QA' }), guard)).rejects.toThrow('outcome unconfirmed');expect(f.calls.filter(value => value.init.method === 'POST')).toHaveLength(1);
  });
  it('encodes event-statistic IDs and date_range as native JSON query parameters', async () => {
    const f = fixture(), input = { account_id: account, pixel_ids: [pixelId], date_range: { start_date: '2026-10-01', end_date: '2026-10-03' } };
    expect(await f.provider.measurement.stats(input)).toMatchObject({ list: [{ count: 0 }], ...{ pixel_ids: input.pixel_ids, date_range: input.date_range } });
    const c = f.calls[0]!;expect(c.url.pathname).toBe('/open_api/v1.3/pixel/event/stats/');expect(c.url.searchParams.get('pixel_ids')).toBe(JSON.stringify(input.pixel_ids));expect(c.url.searchParams.get('date_range')).toBe(JSON.stringify(input.date_range));expect(c.init.method).toBe('GET');
  });
  it.each([{ stats: {} }, { stats: { list: [{ pixel_id: '404' }] } }, { stats: { list: [{ advertiser_id: '404' }] } }, { stats: { list: [{ pixel_id: 9007199254740992 }] } }])('rejects malformed or foreign statistics: %o', async options => {
    await expect(fixture(options).provider.measurement.stats({ account_id: account, pixel_ids: [pixelId], date_range: { start_date: '2026-10-01', end_date: '2026-10-03' } })).rejects.toThrow('statistics response');
  });
  it('rejects invalid dates, duplicate IDs and unapproved write fields before network calls', () => {
    const f = fixture(), stats = f.tools.find(value => value.name === 'tiktok_pixel_event_stats')!, base = { account_id: account, pixel_ids: [pixelId], date_range: { start_date: '2026-10-01', end_date: '2026-10-03' } };
    for (const input of [{ ...base, pixel_ids: [pixelId, pixelId] }, { ...base, date_range: { start_date: '2026-02-30', end_date: '2026-10-03' } }, { ...base, date_range: { start_date: '2026-10-04', end_date: '2026-10-03' } }]) expect(stats.input.safeParse(input).success).toBe(false);
    expect(() => f.op('tiktok_create_pixel', { pixel_name: 'QA', operation_status: 'ENABLE' })).toThrow();
    expect(() => f.op('tiktok_update_pixel', { pixel_id: pixelId, expected_configuration_hash: 'a'.repeat(64), advanced_matching_fields: { email: false } })).toThrow();expect(f.calls).toHaveLength(0);
  });
  it('preserves HTTP200 permission errors without an automatic retry', async () => {
    const f = fixture({ businessError: true });await expect(f.provider.measurement.list({ account_id: account })).rejects.toThrow('40001');expect(f.calls).toHaveLength(1);
  });
  it('uses the shared registry preview/apply token, rejects changed args and consumes it once', async () => {
    const home = await mkdtemp(join(tmpdir(), 'adport-tiktok-pixels-')), previous = process.env.ADPORT_HOME;process.env.ADPORT_HOME = home;
    const f = fixture({ pixels: [] });
    try {
      const runtime = await createContext({ providerModules: [{ provider: f.provider, tools: f.tools }] }), input = { account_id: account, pixel_name: 'Registry QA' };
      const preview = await runtime.registry.call('tiktok_create_pixel', input, runtime.ctx) as { pending_operation_id: string };
      expect(preview.pending_operation_id).toBeTruthy();expect(f.calls).toHaveLength(0);
      await expect(runtime.registry.call('tiktok_create_pixel', { ...input, pixel_name: 'Changed', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.calls).toHaveLength(0);
      expect(await runtime.registry.call('tiktok_create_pixel', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toHaveProperty('applied', true);
      await expect(runtime.registry.call('tiktok_create_pixel', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.calls.filter(value => value.init.method === 'POST')).toHaveLength(1);
    } finally { if (previous === undefined) delete process.env.ADPORT_HOME; else process.env.ADPORT_HOME = previous; await rm(home, { recursive: true, force: true }); }
  });
});
