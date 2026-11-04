import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

const account = '7678335757387513873', audienceId = '9007199254740993123';
const source = { saved_audience_id: audienceId, saved_audience_name: 'Synthetic QA', location_ids: ['6252001'], gender: 'GENDER_UNLIMITED' };
type Row = Record<string, unknown>;
function fixture(options: { page?: Row; records?: Row[]; create?: Row; persistDelete?: boolean; readbackError?: boolean; businessError?: boolean } = {}) {
  const records = new Map((options.records ?? [source]).map(item => [String(item.saved_audience_id), item]));
  const calls: Array<{ url: URL; init: RequestInit; body: Row }> = [];
  let written = false;
  const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert-fixture-token' }, (async (input, init = {}) => {
    const url = new URL(String(input)), body = typeof init.body === 'string' ? JSON.parse(init.body) as Row : {};
    calls.push({ url, init, body });
    if (options.businessError) return Response.json({ code: 40001, message: 'Advertiser permission denied', request_id: 'synthetic-request' });
    let data: unknown;
    if (url.pathname.endsWith('/list/')) {
      if (written && options.readbackError) throw new Error('Unknown readback');
      const ids = url.searchParams.get('saved_audience_ids'), filter = ids ? JSON.parse(ids) as string[] : undefined;
      const page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('page_size'));
      const rows = [...records.values()].filter(item => !filter || filter.includes(String(item.saved_audience_id)));
      data = options.page ?? { saved_audiences: rows.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_page: Math.ceil(rows.length / size), total_number: rows.length } };
    } else if (url.pathname.endsWith('/create/')) {
      written = true; const { advertiser_id: _advertiser, ...fields } = body;
      records.set(audienceId, { ...fields, saved_audience_id: audienceId }); data = options.create ?? { saved_audience_id: audienceId };
    } else if (url.pathname.endsWith('/delete/')) {
      written = true; if (!options.persistDelete) for (const id of body.saved_audience_ids as string[]) records.delete(id); data = {};
    } else throw new Error('Unexpected test endpoint');
    return Response.json({ code: 0, message: 'OK', data });
  }) as typeof fetch), { appId: 'inert', secret: 'inert' });
  const tools = tiktokTools(provider);
  const op = (tool: string, input: Row) => {
    const { account_id, ...payload } = tools.find(item => item.name === tool)!.input.parse({ account_id: account, ...input }) as Row;
    return { tool, provider: 'tiktok', accountId: String(account_id), kind: tool.includes('delete') ? 'remove' as const : 'create' as const, payload };
  };
  return { provider, tools, calls, records, op };
}

// Official TikTok SDK f809c396 and yml_files/dmp_saved_audience_{list,create,delete}.yml.
describe('TikTok saved targeting templates', () => {
  it('uses native ID-filtered list fields and JSON array queries without rounding large IDs', async () => {
    const f = fixture(), result = await f.provider.audiences.get(account, audienceId), call = f.calls[0]!;
    expect(call.url.pathname).toBe('/open_api/v1.3/dmp/saved_audience/list/');
    expect(call.url.searchParams.get('advertiser_id')).toBe(account);
    expect(call.url.searchParams.get('saved_audience_ids')).toBe(JSON.stringify([audienceId]));
    expect(call.init.headers).toMatchObject({ 'Access-Token': 'inert-fixture-token' });
    expect(call.url.searchParams.has('Access-Token')).toBe(false);
    expect(result.audience).toMatchObject(source); expect(result.audience.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('reports confirmed paging, partial pages and empty inventories accurately', async () => {
    const f = fixture({ records: [source, { ...source, saved_audience_id: '123' }] });
    const first = await f.provider.audiences.list({ account_id: account, page: 1, page_size: 1 });
    expect(first).toMatchObject({ complete: false, truncated: true, next_page: 2 });
    expect(await f.provider.audiences.list({ account_id: account, page: 2, page_size: 1 })).toMatchObject({ complete: true, truncated: false });
    expect(await fixture({ records: [] }).provider.audiences.list({ account_id: account })).toMatchObject({ saved_audiences: [], complete: true });
  });
  it.each([{ saved_audiences: [source] }, { saved_audiences: [source], page_info: { page: 1, page_size: 10, total_page: 0, total_number: 0 } }])('does not invent completeness when paging is absent or contradictory: %o', async page => {
    expect(await fixture({ page }).provider.audiences.list({ account_id: account })).toMatchObject({ complete: null, truncated: true });
  });
  it.each([
    {}, { list: [] }, { saved_audiences: [{ ...source, saved_audience_id: 9007199254740992 }] },
    { saved_audiences: [{ ...source, advertiser_id: 'foreign' }] },
    { saved_audiences: [source, source] },
    { saved_audiences: [source], page_info: { page: 2, page_size: 10, total_page: 2 } },
  ])('rejects malformed, duplicate, unsafe or foreign data before it can authorize a write', async page => {
    const f = fixture({ page }); await expect(f.provider.audiences.list({ account_id: account })).rejects.toThrow('tiktok:');
    expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });
  it('rejects filtered IDs that the provider did not honor', async () => {
    await expect(fixture({ page: { saved_audiences: [source] } }).provider.audiences.get(account, '123')).rejects.toThrow('does not match');
  });
  it('previews locally, then creates exact native targeting and verifies the returned template', async () => {
    const f = fixture({ records: [] }), payload = { saved_audience_name: 'Synthetic template', location_ids: ['6252001'], gender: 'GENDER_UNLIMITED', languages: [], interest_category_ids: ['123'] };
    const operation = f.op('tiktok_create_saved_audience', payload), guard = { forcePausedCreation: true };
    const preview = await f.provider.previewWrite(operation, guard);
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [] });
    expect(preview.notes?.join(' ')).toContain('No automatic write retry');expect(f.calls).toHaveLength(0);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [audienceId] });
    const create = f.calls.find(call => call.init.method === 'POST')!;
    expect(create.url.pathname).toBe('/open_api/v1.3/dmp/saved_audience/create/');
    expect(create.body).toEqual({ ...payload, advertiser_id: account });
    expect(create.init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(create.body).not.toHaveProperty('operation_status');expect(f.calls.at(-1)!.url.pathname).toContain('/list/');
  });
  it('reports native action-period coercions and sends only the coerced creator period', async () => {
    const f = fixture({ records: [] }), operation = f.op('tiktok_create_saved_audience', { saved_audience_name: 'Creator actions', location_ids: ['6252001'], actions: [{ action_category_ids: ['3'], action_scene: 'CREATOR_RELATED', action_period: 7, video_user_actions: ['FOLLOWING'] }] });
    expect((await f.provider.previewWrite(operation, { forcePausedCreation: true })).coercions).toEqual(['actions[0].action_period coerced to 0 for CREATOR_RELATED by TikTok']);
    await f.provider.applyWrite(operation, { forcePausedCreation: true });expect(f.calls.find(call => call.init.method === 'POST')!.body.actions).toMatchObject([{ action_period: 0 }]);
  });
  it.each([
    { saved_audience_name: 'Emoji 😀' }, { location_ids: [] }, { advertiser_id: 'foreign' }, { budget: 50 }, { operation_status: 'ENABLE' },
    { device_model_ids: ['1'], device_price_ranges: [0, 100] }, { operating_systems: ['IOS', 'ANDROID'] },
    { actions: [{ action_category_ids: ['1'], action_scene: 'HASHTAG_RELATED', action_period: 0, video_user_actions: ['LIKED'] }] },
  ])('validates native targeting and rejects unrelated mutation fields: %o', invalid => {
    const f = fixture();expect(() => f.op('tiktok_create_saved_audience', { saved_audience_name: 'Valid', location_ids: ['1'], ...invalid })).toThrow();expect(f.calls).toHaveLength(0);
  });
  it.each([{ create: {} }, { create: { saved_audience_id: 9007199254740992 } }, { readbackError: true }])('never retries uncertain creation or fabricates a created ID: %o', async options => {
    const f = fixture(options);await expect(f.provider.applyWrite(f.op('tiktok_create_saved_audience', { saved_audience_name: 'QA', location_ids: ['1'] }), { forcePausedCreation: true })).rejects.toThrow('tiktok:');
    expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
  });
  it('binds every deleted ID to its current snapshot and independently confirms absence', async () => {
    const f = fixture(), current = (await f.provider.audiences.get(account, audienceId)).audience;
    const operation = f.op('tiktok_delete_saved_audiences', { targets: [{ saved_audience_id: audienceId, expected_snapshot_hash: current.snapshot_hash }] });
    const preview = await f.provider.previewWrite(operation, { forcePausedCreation: true });expect(preview.summary).toContain('Permanently delete');expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
    expect(await f.provider.applyWrite(operation, { forcePausedCreation: true })).toEqual({ applied: true, resourceIds: [audienceId] });
    expect(f.calls.find(call => call.init.method === 'POST')).toMatchObject({ body: { advertiser_id: account, saved_audience_ids: [audienceId] } });
    expect(f.calls.at(-1)!.init.method).toBe('GET');
  });
  it('rejects a changed or missing batch member before sending any deletion', async () => {
    const f = fixture(), current = (await f.provider.audiences.get(account, audienceId)).audience;
    f.records.set(audienceId, { ...source, saved_audience_name: 'Changed' });
    await expect(f.provider.applyWrite(f.op('tiktok_delete_saved_audiences', { targets: [{ saved_audience_id: audienceId, expected_snapshot_hash: current.snapshot_hash }] }), { forcePausedCreation: true })).rejects.toThrow('missing or changed');
    await expect(f.provider.previewWrite(f.op('tiktok_delete_saved_audiences', { targets: [{ saved_audience_id: audienceId, expected_snapshot_hash: current.snapshot_hash }, { saved_audience_id: '404', expected_snapshot_hash: current.snapshot_hash }] }), { forcePausedCreation: true })).rejects.toThrow('missing or changed');
    expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });
  it('does not label an accepted deletion as confirmed while an approved record remains', async () => {
    const f = fixture({ persistDelete: true }), current = (await f.provider.audiences.get(account, audienceId)).audience;
    await expect(f.provider.applyWrite(f.op('tiktok_delete_saved_audiences', { targets: [{ saved_audience_id: audienceId, expected_snapshot_hash: current.snapshot_hash }] }), { forcePausedCreation: true })).rejects.toThrow('deletion readback unconfirmed');
    expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
  });
  it('preserves HTTP200 business permission errors without an automatic retry', async () => {
    const f = fixture({ businessError: true });await expect(f.provider.audiences.list({ account_id: account })).rejects.toThrow('40001');expect(f.calls).toHaveLength(1);
  });
  it('uses the real guarded registry preview/apply token and consumes it once', async () => {
    const home = await mkdtemp(join(tmpdir(), 'adport-tiktok-audiences-')), previous = process.env.ADPORT_HOME;process.env.ADPORT_HOME = home;
    const f = fixture({ records: [] });
    try {
      const runtime = await createContext({ providerModules: [{ provider: f.provider, tools: f.tools }] }), input = { account_id: account, saved_audience_name: 'Registry QA', location_ids: ['6252001'] };
      const preview = await runtime.registry.call('tiktok_create_saved_audience', input, runtime.ctx) as { pending_operation_id: string };
      expect(preview.pending_operation_id).toBeTruthy();expect(f.calls).toHaveLength(0);
      await expect(runtime.registry.call('tiktok_create_saved_audience', { ...input, saved_audience_name: 'Changed', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
      expect(await runtime.registry.call('tiktok_create_saved_audience', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toHaveProperty('applied', true);
      await expect(runtime.registry.call('tiktok_create_saved_audience', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();
      expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
    } finally {if(previous===undefined) delete process.env.ADPORT_HOME;else process.env.ADPORT_HOME=previous;await rm(home,{recursive:true,force:true});}
  });
});
