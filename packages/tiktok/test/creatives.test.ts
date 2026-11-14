import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

function fixture(records: Record<string, unknown> = {}) {
  const calls: Array<{ url: URL; init: RequestInit; body: Record<string, unknown> }> = [];
  const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'test-token' }, (async (url: string | URL, init: RequestInit = {}) => {
    const parsed = new URL(String(url)), path = parsed.pathname.replace('/open_api/v1.3/', '').replace(/\/$/, '');
    calls.push({ url: parsed, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : {} });
    const result = records[path] ?? (path.endsWith('/get') ? { list: [] } : {});
    return Response.json({ code: 0, message: 'OK', data: result });
  }) as typeof fetch), { appId: 'test', secret: 'test' });
  const tools = tiktokTools(provider);
  const op = (tool: string, input: Record<string, unknown>, kind: 'create' | 'update' = 'update') => {
    const { account_id, ...payload } = tools.find(definition => definition.name === tool)!.input.parse({ account_id: '1', ...input }) as Record<string, unknown>;
    return { tool, provider: 'tiktok', accountId: String(account_id), kind, payload };
  };
  return { provider, calls, tools, op };
}

// Wire contracts: official tiktok-business-api-sdk f809c396, including multipart file_api.py and OpenAPI targeting specs.
describe('TikTok child authoring and edits', () => {
  const guard = { forcePausedCreation: true };
  const group = { adgroup_id: '2', advertiser_id: '1', campaign_id: '3', adgroup_name: 'Test', operation_status: 'DISABLE', budget: 50, bid_price: 1 };
  const ad = { ad_id: '4', advertiser_id: '1', adgroup_id: '2', ad_name: 'Creative', ad_text: 'Actual copy', operation_status: 'DISABLE', ad_format: 'SINGLE_VIDEO' };
  it('creates ad groups with flat native targeting, paused status and policy-reported whole-currency money', async () => {
    const { provider, calls, op } = fixture({ 'campaign/get': { list: [{ campaign_id: '3', advertiser_id: '1' }] }, 'adgroup/create': { adgroup_id: '2', advertiser_id: '1' } });
    const input = op('tiktok_create_ad_group', { campaign_id: '3', adgroup_name: 'QA', promotion_type: 'WEBSITE', placement_type: 'PLACEMENT_TYPE_NORMAL', placements: ['PLACEMENT_TIKTOK'], budget: 50, budget_mode: 'BUDGET_MODE_DAY', optimization_goal: 'CLICK', billing_event: 'CPC', bid_type: 'BID_TYPE_CUSTOM', bid_price: 1, pacing: 'PACING_MODE_SMOOTH', schedule_type: 'SCHEDULE_FROM_NOW', schedule_start_time: '2026-11-03 00:00:00', targeting: { location_ids: ['6252001'], age_groups: ['AGE_25_34'] }, operation_status: 'ENABLE' }, 'create');
    const preview = await provider.previewWrite(input, guard);
    expect(preview.budgetDeltas.map(delta => delta.toMicros)).toEqual([50_000_000, 1_000_000]);
    expect(preview.coercions).toHaveLength(1);
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
    expect(await provider.applyWrite(input, guard)).toEqual({ applied: true, resourceIds: ['2'] });
    expect(calls.at(-1)!.body).toMatchObject({ advertiser_id: '1', campaign_id: '3', budget: 50, bid_price: 1, location_ids: ['6252001'], age_groups: ['AGE_25_34'], operation_status: 'DISABLE' });
    expect(calls.at(-1)!.body.targeting).toBeUndefined();
  });
  it('creates all ad creatives paused and extracts only created ad IDs', async () => {
    const { provider, calls, op } = fixture({ 'adgroup/get': { list: [group] }, 'ad/create': { ad_ids: ['4', '5'], advertiser_id: '1', adgroup_id: '2' } });
    const input = op('tiktok_create_ads', { ad_group_id: '2', creatives: [{ ad_name: 'QA', ad_format: 'SINGLE_VIDEO', ad_text: 'Copy', video_id: 'video1', identity_type: 'TT_USER', identity_id: 'identity1', operation_status: 'ENABLE' }] }, 'create');
    expect((await provider.previewWrite(input, guard)).coercions).toHaveLength(1);
    // adgroup_id is a parent in this response, not a newly created resource.
    const result = await provider.applyWrite(input, guard);
    expect(result.resourceIds).toEqual(['4', '5']);
    expect(calls.at(-1)!.body).toMatchObject({ advertiser_id: '1', adgroup_id: '2', creatives: [{ operation_status: 'DISABLE', identity_id: 'identity1' }] });
  });
  it('accepts Spark source posts without forcing an ad-text override', async () => {
    const { provider, calls, op } = fixture({ 'adgroup/get': { list: [group] }, 'ad/create': { ad_ids: ['4'] } });
    await provider.applyWrite(op('tiktok_create_ads', { ad_group_id: '2', creatives: [{ ad_name: 'Authorized post', ad_format: 'SINGLE_VIDEO', identity_type: 'AUTH_CODE', identity_id: 'authorized-identity', tiktok_item_id: '12345' }] }, 'create'), guard);
    expect(calls.at(-1)!.body.creatives).toEqual([{ ad_name: 'Authorized post', ad_format: 'SINGLE_VIDEO', identity_type: 'AUTH_CODE', identity_id: 'authorized-identity', tiktok_item_id: '12345', operation_status: 'DISABLE' }]);
  });
  it('patches copy with native creatives and patch_update, preserving omitted serving settings', async () => {
    const { provider, calls, op } = fixture({ 'ad/get': { list: [ad] }, 'adgroup/get': { list: [group] } });
    await provider.applyWrite(op('tiktok_update_ad', { ad_group_id: '2', ad_id: '4', ad_text: 'Edited copy' }), guard);
    expect(calls.at(-1)).toMatchObject({ init: { method: 'POST' }, body: { advertiser_id: '1', adgroup_id: '2', patch_update: true, creatives: [{ ad_id: '4', ad_text: 'Edited copy' }] } });
    expect(calls.at(-1)!.url.pathname).toBe('/open_api/v1.3/ad/update/');
    expect(calls.at(-1)!.body.operation_status).toBeUndefined();
    await expect(provider.previewWrite(op('tiktok_update_ad', { ad_group_id: '9', ad_id: '4', ad_text: 'Wrong parent' }), guard)).rejects.toThrow('selected ad group');
  });
  it('uses separate child-status endpoints and rejects every missing or foreign-account target', async () => {
    const { provider, calls, op } = fixture({ 'ad/get': { list: [ad] }, 'adgroup/get': { list: [group] } });
    await provider.applyWrite(op('tiktok_set_ad_group_status', { ad_group_ids: ['2'], operation_status: 'DISABLE' }), guard);
    expect(calls.at(-1)!.body).toEqual({ advertiser_id: '1', adgroup_ids: ['2'], operation_status: 'DISABLE', allow_partial_success: false });
    await provider.applyWrite(op('tiktok_set_ad_status', { ad_ids: ['4'], operation_status: 'ENABLE' }), guard);
    expect(calls.at(-1)!.body).toEqual({ advertiser_id: '1', ad_ids: ['4'], operation_status: 'ENABLE' });
    await expect(provider.previewWrite(op('tiktok_set_ad_status', { ad_ids: ['4', '9'], operation_status: 'ENABLE' }), guard)).rejects.toThrow('not found');
    const foreign = fixture({ 'ad/get': { list: [{ ...ad, advertiser_id: '9' }] } });
    await expect(foreign.provider.previewWrite(op('tiktok_set_ad_status', { ad_ids: ['4'], operation_status: 'ENABLE' }), guard)).rejects.toThrow('selected advertiser');
    expect(foreign.calls.some(call => call.init.method === 'POST')).toBe(false);
  });
  it('checks current budgets/bids in micros and sends only supplied targeting arrays', async () => {
    const { provider, calls, op } = fixture({ 'adgroup/get': { list: [group] } });
    expect((await provider.previewWrite(op('tiktok_set_ad_group_budget', { ad_group_id: '2', budget: 60 }), guard)).budgetDeltas).toEqual([{ target: 'ad group 2 budget', fromMicros: 50_000_000, toMicros: 60_000_000 }]);
    expect((await provider.previewWrite(op('tiktok_set_ad_group_bidding', { ad_group_id: '2', bid_price: 1.2 }), guard)).budgetDeltas[0]).toMatchObject({ fromMicros: 1_000_000, toMicros: 1_200_000 });
    await provider.applyWrite(op('tiktok_update_targeting', { ad_group_id: '2', targeting: { age_groups: ['AGE_35_44'], audience_ids: [] } }), guard);
    expect(calls.at(-1)!.body).toEqual({ advertiser_id: '1', adgroup_id: '2', age_groups: ['AGE_35_44'], audience_ids: [] });
  });
  it('coerces missing child statuses on generic creates and rejects monetary generic updates', async () => {
    const { provider, calls } = fixture({ 'ad/create': { ad_ids: ['4'] } });
    const input = { tool: 'tiktok_api_create', provider: 'tiktok', accountId: '1', kind: 'create' as const, payload: { path: 'ad/create', body: { adgroup_id: '2', creatives: [{ ad_name: 'Default status' }] } } };
    expect((await provider.previewWrite(input, guard)).coercions).toContain('creatives[0].operation_status set to DISABLE by policy (paused_creation)');
    await provider.applyWrite(input, guard);
    expect(calls.at(-1)!.body.creatives).toEqual([{ ad_name: 'Default status', operation_status: 'DISABLE' }]);
    await expect(provider.previewWrite({ tool: 'tiktok_api_update', provider: 'tiktok', accountId: '1', kind: 'update', payload: { path: 'adgroup/update', body: { adgroup_id: '2', bid_price: 999 } } }, guard)).rejects.toThrow('typed budget tool');
  });
  it('returns configuration and safe creative actions with correct pagination; POST search is read-only', async () => {
    const { provider, calls, tools } = fixture({ 'ad/get': { list: [ad], page_info: { total_page: 2 } } });
    const tool = tools.find(tool => tool.name === 'tiktok_ads')!;
    const result = await tool.handler(tool.input.parse({ account_id: '1' }) as never, {} as never);
    expect(tool.output!.parse(result)).toMatchObject({ ads: [ad], truncated: true, creatives: [{ descriptions: ['Actual copy'], actions: expect.arrayContaining([expect.objectContaining({ tool: 'tiktok_update_ad', arguments: { account_id: '1', ad_group_id: '2', ad_id: '4' } })]) }] });
    const search = tools.find(tool => tool.name === 'tiktok_search_targeting')!;
    await search.handler(search.input.parse({ account_id: '1', keywords: ['Germany'], placements: ['PLACEMENT_TIKTOK'], objective_type: 'TRAFFIC', promotion_type: 'WEBSITE' }) as never, {} as never);
    expect(search.annotations.readOnly).toBe(true);
    expect(calls.at(-1)!.body).toMatchObject({ advertiser_id: '1', keywords: ['Germany'], search_type: 'FUZZY_SEARCH' });
    expect(calls.at(-1)!.url.pathname).toBe('/open_api/v1.3/tool/targeting/search/');
  });
  it('uploads the checksum-approved bytes as multipart with MD5, and rejects bytes changed after preview', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-tiktok-media-'));
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
    const path = join(dir, 'qa.png'); await writeFile(path, bytes);
    try {
      const { provider, calls, op } = fixture({ 'file/image/ad/upload': { image_id: 'image-1' } });
      const input = op('tiktok_upload_image', { file_path: path, expected_sha256: createHash('sha256').update(bytes).digest('hex') }, 'create');
      await provider.previewWrite(input, guard); expect(calls).toHaveLength(0);
      await writeFile(path, Buffer.concat([bytes, Buffer.from('changed')]));
      await expect(provider.applyWrite(input, guard)).rejects.toThrow('SHA-256 mismatch'); expect(calls).toHaveLength(0);
      await writeFile(path, bytes); expect((await provider.applyWrite(input, guard)).resourceIds).toEqual(['image-1']);
      const call = calls[0]!, form = call.init.body as FormData;
      expect(call.url.pathname).toBe('/open_api/v1.3/file/image/ad/upload/');
      expect(call.init.headers).toEqual({ 'Access-Token': 'test-token' });
      expect(form.get('upload_type')).toBe('UPLOAD_BY_FILE');
      expect(form.get('image_signature')).toBe(createHash('md5').update(bytes).digest('hex'));
      expect(Buffer.from(await (form.get('image_file') as Blob).arrayBuffer())).toEqual(bytes);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
