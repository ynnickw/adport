import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, withProjectRouting, type MediaResolver, type WriteOperation } from '@adport/core';
import { describe, expect, it, vi } from 'vitest';
import { MetaGraphClient } from '../src/client.js';
import { MetaAdsProvider } from '../src/provider.js';
import { metaTools } from '../src/tools.js';

// Wire shapes verified against Meta's official Business SDK at efd8423a2e59:
// adaccount.py create_ad/create_ad_creative/create_ad_image/create_ad_video,
// adcreative.py api_update; creative content is immutable.
const account = '1234', guard = { forcePausedCreation: true };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const hash = createHash('sha256').update(png).digest('hex');
function setup(respond: (url: URL, init: RequestInit) => unknown, media?: MediaResolver) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    return Response.json(respond(url, init));
  });
  const provider = new MetaAdsProvider(new MetaGraphClient({ accessToken: 'test' }, 'v25.0', fetcher as typeof fetch), undefined, media);
  return { provider, calls };
}
const operation = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'meta', accountId: account, kind, payload });
const fields = (init: RequestInit) => new URLSearchParams(String(init.body));

describe('Meta creative lifecycle', () => {
  it('never forwards the account token to an external pagination URL', async () => {
    const { provider, calls } = setup(() => ({ data: [], paging: { next: 'https://untrusted.example/next' } }));
    await expect(provider.creatives.library('images', { account_id: account, limit: 3 })).rejects.toThrow('pagination destination');
    expect(calls).toHaveLength(1);
  });
  it('presents account image/video libraries with real preview and playback URLs', async () => {
    const { provider } = setup(url => ({ data: url.pathname.endsWith('/adimages')
      ? [{ hash: 'image-hash', name: 'Image', url: 'https://scontent.xx.fbcdn.net/image.jpg', width: 1200, height: 628 }]
      : [{ id: '70', title: 'Video', source: 'https://video.xx.fbcdn.net/ad.mp4' }] }));
    const image = await provider.creatives.library('images', { account_id: account, limit: 3 });
    const video = await provider.creatives.library('videos', { account_id: account, limit: 3 });
    const definitions = metaTools(provider);
    expect(definitions.find(tool => tool.name === 'meta_list_images')!.output!.safeParse(image).success).toBe(true);
    expect(definitions.find(tool => tool.name === 'meta_list_videos')!.output!.safeParse(video).success).toBe(true);
    expect('creatives' in video && video.creatives[0]?.media[0]).toMatchObject({ type: 'video', url: 'https://video.xx.fbcdn.net/ad.mp4' });
  });
  it('lists actual nested creative copy/media and binds actions to the selected ad/account', async () => {
    const { provider, calls } = setup(() => ({ data: [{ id: '10', account_id: account, name: 'Ad', status: 'PAUSED', campaign_id: '20', adset_id: '30', creative: {
      id: '40', name: 'Creative', image_url: 'https://scontent.xx.fbcdn.net/image.jpg', object_story_spec: { page_id: '50', link_data: { image_hash: 'abc', link: 'https://example.com', name: 'Headline', message: 'Actual copy', description: 'Details', call_to_action: { type: 'LEARN_MORE' } } },
    } }] }));
    const result = await provider.creatives.listAds({ account_id: account, campaign_id: '20', limit: 50 });
    expect(result.creatives[0]).toMatchObject({ id: '10', account_id: account, headlines: ['Headline'], descriptions: ['Actual copy', 'Details'], media: [{ type: 'image', url: 'https://scontent.xx.fbcdn.net/image.jpg' }] });
    expect(result.creatives[0]?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'meta_set_ad_status', arguments: { account_id: account, ad_id: '10' } }),
      expect.objectContaining({ tool: 'meta_update_ad', arguments: { account_id: account, ad_id: '10' } }),
    ]));
    expect(calls[0]?.url.searchParams.get('filtering')).toBe('[{"field":"campaign.id","operator":"EQUAL","value":"20"}]');
    expect(calls[0]?.url.searchParams.get('fields')).toContain('creative{id,account_id');
    const schema = metaTools(provider).find(tool => tool.name === 'meta_list_ads')!.output!;
    expect(schema.safeParse(result).success).toBe(true);
  });

  it('creates an immutable image creative using accessible Page identity and documented link_data', async () => {
    const { provider, calls } = setup((url) => url.pathname.endsWith('/me/accounts') ? { data: [{ id: '50', name: 'Page' }] } : { id: '40' });
    const op = operation('meta_create_link_creative', { name: 'New copy', page_id: '50', image_hash: 'abc', link: 'https://example.com', message: 'Primary', headline: 'Title', description: 'Detail', call_to_action: 'SHOP_NOW' }, 'create');
    await expect(provider.previewWrite(op, guard)).resolves.toMatchObject({ serverValidated: true });
    const body = fields(calls[1]!.init);
    expect(calls[1]!.url.pathname).toBe('/v25.0/act_1234/adcreatives');
    expect(JSON.parse(body.get('object_story_spec')!)).toEqual({ page_id: '50', link_data: { image_hash: 'abc', link: 'https://example.com', message: 'Primary', name: 'Title', description: 'Detail', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://example.com' } } } });
    expect(body.get('execution_options')).toBe('["validate_only"]');
    await provider.applyWrite(op, guard);
    expect(fields(calls.at(-1)!.init).has('execution_options')).toBe(false);
  });

  it('rejects an inaccessible Page without a creative POST', async () => {
    const { provider, calls } = setup(() => ({ data: [] }));
    await expect(provider.previewWrite(operation('meta_create_creative', { name: 'No', object_story_id: '50_60' }, 'create'), guard)).rejects.toThrow('Facebook Page');
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });

  it('verifies both parent and creative ownership and forces a new ad paused', async () => {
    const { provider, calls } = setup((url, init) => init.method === 'GET' ? { id: url.pathname.split('/').at(-1), account_id: account } : { id: '10' });
    const op = operation('meta_create_ad', { name: 'New ad', ad_set_id: '30', creative_id: '40', status: 'ACTIVE' }, 'create');
    const preview = await provider.previewWrite(op, guard);
    expect(preview.coercions).toEqual(['status coerced to PAUSED by policy (paused_creation)']);
    const body = fields(calls.at(-1)!.init);
    expect(body.get('adset_id')).toBe('30'); expect(body.get('creative')).toBe('{"creative_id":"40"}'); expect(body.get('status')).toBe('PAUSED');
    expect(body.get('execution_options')).toBe('["validate_only"]');
  });

  it.each(['meta_set_ad_status', 'meta_update_ad', 'meta_update_targeting', 'meta_set_ad_set_bidding', 'meta_set_budget', 'meta_set_campaign_status', 'meta_set_lifetime_budget'])('rejects cross-account %s before any POST', async tool => {
    const { provider, calls } = setup((url) => ({ id: url.pathname.split('/').at(-1), account_id: '9999', daily_budget: '100', lifetime_budget: '100' }));
    await expect(provider.previewWrite(operation(tool, { ad_id: '10', object_id: '10', campaign_id: '10', ad_set_id: '10', status: 'ACTIVE', targeting: { geo_locations: { countries: ['US'] } }, bid_strategy: 'COST_CAP', bid_amount: 5, daily_budget_cents: 100, lifetime_budget_cents: 100 }), guard)).rejects.toThrow('selected ad account');
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });

  it('replaces only ad name/creative and reports the current serving state', async () => {
    const { provider, calls } = setup((url, init) => init.method === 'GET' ? { id: url.pathname.split('/').at(-1), account_id: account, name: 'Old', status: 'ACTIVE', creative: { id: '39' } } : { success: true });
    const preview = await provider.previewWrite(operation('meta_update_ad', { ad_id: '10', creative_id: '40', name: 'New' }), guard);
    expect(preview.changes.join(' ')).toContain('Serving status remains ACTIVE');
    const body = fields(calls.at(-1)!.init);
    expect(body.get('creative')).toBe('{"creative_id":"40"}'); expect(body.get('name')).toBe('New'); expect(body.has('status')).toBe(false);
  });

  it('replaces targeting without sending unrelated budget or delivery fields', async () => {
    const { provider, calls } = setup((url, init) => init.method === 'GET' ? { id: '30', account_id: account, targeting: { geo_locations: { countries: ['DE'] } } } : { success: true });
    await provider.previewWrite(operation('meta_update_targeting', { ad_set_id: '30', targeting: { geo_locations: { countries: ['US'] }, age_min: 21 } }), guard);
    expect(Object.fromEntries(fields(calls.at(-1)!.init))).toEqual({ targeting: '{"geo_locations":{"countries":["US"]},"age_min":21}', execution_options: '["validate_only"]' });
  });

  it('does not mutate a creative during a rename preview because that API lacks validate_only', async () => {
    const { provider, calls } = setup(() => ({ id: '40', account_id: account }));
    await expect(provider.previewWrite(operation('meta_rename_creative', { creative_id: '40', name: 'Renamed' }), guard)).resolves.toMatchObject({ serverValidated: false });
    expect(calls).toHaveLength(1);
    await provider.applyWrite(operation('meta_rename_creative', { creative_id: '40', name: 'Renamed' }), guard);
    expect(Object.fromEntries(fields(calls.at(-1)!.init))).toEqual({ name: 'Renamed' });
  });

  it('uploads exact approved image bytes only on apply and rejects changed file bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adport-meta-'));
    try {
      const file = join(directory, 'image.png'); await writeFile(file, png);
      const { provider, calls } = setup(() => ({ images: { 'image.png': { hash: 'image-hash' } } }));
      const op = operation('meta_upload_image', { file_path: file, expected_sha256: hash }, 'create');
      await expect(provider.previewWrite(op, guard)).resolves.toMatchObject({ serverValidated: false }); expect(calls).toHaveLength(0);
      await expect(provider.applyWrite(op, guard)).resolves.toMatchObject({ resourceIds: ['image-hash'] });
      expect(fields(calls[0]!.init).get('bytes')).toBe(png.toString('base64'));
      await writeFile(file, Buffer.concat([png, Buffer.from('change')]));
      await expect(provider.applyWrite(op, guard)).rejects.toThrow('SHA-256 mismatch'); expect(calls).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('only deletes an account-scoped image hash after preview, using the documented DELETE edge', async () => {
    const { provider, calls } = setup((url, init) => init.method === 'GET' ? { data: [{ hash: 'image-hash', name: 'QA' }] } : { success: true });
    const op = operation('meta_delete_image', { image_hash: 'image-hash' }, 'remove');
    await expect(provider.previewWrite(op, guard)).resolves.toMatchObject({ serverValidated: false });
    expect(calls).toHaveLength(1); expect(calls[0]!.url.searchParams.get('hashes')).toBe('["image-hash"]');
    await provider.applyWrite(op, guard);
    expect(calls.at(-1)!.url.pathname).toBe('/v25.0/act_1234/adimages'); expect(calls.at(-1)!.init.method).toBe('DELETE');
    expect(Object.fromEntries(fields(calls.at(-1)!.init))).toEqual({ hash: 'image-hash' });
  });

  it('uses scoped media IDs and multipart source for video uploads without setting a boundary header', async () => {
    const bytes = Buffer.from([0, 0, 0, 20, ...Buffer.from('ftypisom'), 0, 0, 0, 0]);
    const read = vi.fn(async () => ({ bytes, name: 'ad.mp4', contentType: 'video/mp4', sha256: 'a'.repeat(64) }));
    const { provider, calls } = setup(() => ({ id: '70' }), { read });
    const op = operation('meta_upload_video', { media_id: '00000000-0000-4000-8000-000000000001', expected_sha256: 'a'.repeat(64), title: 'Video' }, 'create');
    await provider.previewWrite(op, guard); expect(calls).toHaveLength(0);
    await provider.applyWrite(op, guard);
    expect(read).toHaveBeenCalledTimes(2);
    const form = calls[0]!.init.body as FormData;
    expect(form.get('title')).toBe('Video'); expect((form.get('source') as File).type).toBe('video/mp4');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('preserves payload refinements through guarded and project-routed schemas', async () => {
    const { provider } = setup(() => ({}));
    const tool = metaTools(provider).find(tool => tool.name === 'meta_create_creative')!;
    expect(tool.input.safeParse({ account_id: account, name: 'Invalid' }).success).toBe(false);
    const runtime = await createContext({ providerModules: [{ provider, tools: [tool] }] });
    const routed = withProjectRouting(runtime, { list: async () => [], resolve: async () => runtime });
    expect(routed.registry.get(tool.name).input.safeParse({ account_id: account, name: 'Invalid', project_id: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
  });

  it('enforces preview, exact-argument binding and one-time apply through the shared registry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adport-meta-policy-'));
    const previous = process.env.ADPORT_HOME; process.env.ADPORT_HOME = directory;
    try {
      const { provider, calls } = setup((url, init) => init.method === 'GET' ? { id: '10', account_id: account, name: 'Ad', status: 'PAUSED' } : { success: true });
      const runtime = await createContext({ providerModules: [{ provider, tools: metaTools(provider) }] });
      const args = { account_id: account, ad_id: '10', status: 'PAUSED' };
      const preview = await runtime.registry.call('meta_set_ad_status', args, runtime.ctx) as { pending_operation_id: string };
      expect(calls.filter(call => call.init.method === 'POST').every(call => fields(call.init).has('execution_options'))).toBe(true);
      await expect(runtime.registry.call('meta_set_ad_status', { ...args, status: 'ACTIVE', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();
      await expect(runtime.registry.call('meta_set_ad_status', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).resolves.toMatchObject({ applied: true });
      expect(fields(calls.at(-1)!.init).has('execution_options')).toBe(false);
      await expect(runtime.registry.call('meta_set_ad_status', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();
    } finally { if (previous === undefined) delete process.env.ADPORT_HOME; else process.env.ADPORT_HOME = previous; await rm(directory, { recursive: true, force: true }); }
  });
});
