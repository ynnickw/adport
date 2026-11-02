import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { SpotifyAdsClient, SPOTIFY_TOKEN_URL } from '../src/client.js';
import { SpotifyAdsProvider } from '../src/provider.js';
import { spotifyTools } from '../src/tools.js';

// Request/response shapes checked against Spotify's live v3 api.yaml, 2026-11-03.
const ACCOUNT = '10000000-0000-4000-8000-000000000001', CAMPAIGN = '10000000-0000-4000-8000-000000000002';
const GROUP = '10000000-0000-4000-8000-000000000003', AD = '10000000-0000-4000-8000-000000000004', ASSET = '10000000-0000-4000-8000-000000000005';
const SESSION = '10000000-0000-4000-8000-000000000006';
const campaign = { id: CAMPAIGN, ad_account_id: ACCOUNT, name: 'QA draft', status: 'PAUSED', draft_hierarchy_version: 7 };
const group = { id: GROUP, campaign_id: CAMPAIGN, name: 'QA group', budget: { micro_amount: 100_000_000, type: 'DAILY' }, bid_micro_amount: 10_000_000, targets: { placements: ['MUSIC'], geo_targets: { country_code: 'DE' }, genre_ids: ['rock'] } };
const ad = { id: AD, ad_set_id: GROUP, name: 'QA ad', tagline: 'Original copy', assets: { asset_id: ASSET }, call_to_action: { key: 'LEARN_MORE', clickthrough_url: 'https://example.com' } };
const asset = { id: ASSET, name: 'QA asset', asset_type: 'IMAGE', status: 'WAITING_UPLOAD' };
const guard = { forcePausedCreation: true };
const dirs: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), 'adport-spotify-creative-')); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
type Call = { url: URL; init: RequestInit };
function fixture(handler?: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new SpotifyAdsClient({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === SPOTIFY_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const result = handler?.(call);
    if (result !== undefined) return result instanceof Response ? result : Response.json(result);
    const p = call.url.pathname;
    if (p.endsWith(`/drafts/campaigns/${CAMPAIGN}`)) return Response.json(campaign);
    if (p.endsWith(`/drafts/ad_sets/${GROUP}`)) return Response.json(group);
    if (p.endsWith(`/drafts/ads/${AD}`)) return Response.json(ad);
    if (p.endsWith(`/assets/${ASSET}`)) return Response.json(asset);
    throw new Error(`Unexpected wire request ${init.method} ${p}`);
  });
  return { client, provider: new SpotifyAdsProvider(client), calls };
}
function op(tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation { return { provider: 'spotify', accountId: ACCOUNT, tool, kind, payload }; }
function body(call: Call) { return JSON.parse(String(call.init.body)); }
const writes = (calls: Call[]) => calls.filter(c => ![undefined, 'GET'].includes(c.init.method) && c.url.href !== SPOTIFY_TOKEN_URL);

describe('Spotify draft authoring and scope', () => {
  it('previews child creation using only parent reads, then posts native micros without inventing PAUSED child statuses', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' && call.url.pathname.endsWith('/drafts/ad_sets') ? group : undefined);
    const operation = op('spotify_create_draft_ad_set', { campaign_id: CAMPAIGN, name: 'QA group', budget: group.budget, bid_micro_amount: group.bid_micro_amount, targets: group.targets }, 'create');
    const preview = await provider.previewWrite(operation, guard);
    expect(writes(calls)).toEqual([]);
    expect(preview.budgetDeltas).toEqual([{ target: 'draft ad set QA group DAILY budget', toMicros: 100_000_000 }, { target: 'draft ad set QA group bid', toMicros: 10_000_000 }]);
    expect(await provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [GROUP] });
    expect(body(writes(calls)[0]!)).toEqual(operation.payload);
  });
  it('requires placements and a lifetime end date before creating child drafts', async () => {
    const { provider, calls } = fixture();
    for (const extra of [{ targets: { genre_ids: ['rock'] } }, { budget: { type: 'LIFETIME', micro_amount: 100 } }]) await expect(provider.previewWrite(op('spotify_create_draft_ad_set', { campaign_id: CAMPAIGN, name: 'QA group', ...extra }, 'create'), guard)).rejects.toThrow(/placements|end_time/);
    expect(writes(calls)).toEqual([]);
  });
  it('preserves omitted targeting dimensions when patching a supplied array', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { ...group, targets: body(call).targets } : undefined);
    await provider.applyWrite(op('spotify_update_draft_ad_set', { draft_id: GROUP, targets: { genre_ids: ['jazz'] } }), guard);
    expect(body(writes(calls)[0]!)).toEqual({ targets: { ...group.targets, genre_ids: ['jazz'] } });
  });
  it('retains omitted CTA/asset fields while patching draft copy and verifies every supplied asset', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { ...ad, ...body(call) } : undefined);
    await provider.applyWrite(op('spotify_update_draft_ad', { draft_id: AD, tagline: 'New copy', call_to_action: { key: 'SHOP_NOW' }, assets: { logo_asset_id: ASSET } }), guard);
    expect(body(writes(calls)[0]!)).toEqual({ tagline: 'New copy', call_to_action: { key: 'SHOP_NOW', clickthrough_url: 'https://example.com' }, assets: { asset_id: ASSET, logo_asset_id: ASSET } });
    expect(calls.some(c => c.url.pathname.endsWith(`/assets/${ASSET}`))).toBe(true);
  });
  it('rejects a foreign account response before any draft write', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/drafts/campaigns/${CAMPAIGN}`) ? { ...campaign, ad_account_id: GROUP } : undefined);
    await expect(provider.applyWrite(op('spotify_update_draft_ad', { draft_id: AD, name: 'New name' }), guard)).rejects.toThrow('another account');
    expect(writes(calls)).toEqual([]);
  });
  it('refuses to overwrite an already existing draft', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/campaigns/${CAMPAIGN}`) ? campaign : undefined);
    await expect(provider.previewWrite(op('spotify_create_draft_from_published', { entity: 'campaigns', draft_id: CAMPAIGN }, 'create'), guard)).rejects.toThrow('already exists');
    expect(writes(calls)).toEqual([]);
  });
  it('stages a published resource only after an actual 404, posting no invented body', async () => {
    const { provider, calls } = fixture(call => {
      if (call.url.pathname.endsWith(`/drafts/campaigns/${CAMPAIGN}`)) return Response.json({}, { status: 404 });
      if (call.url.pathname.endsWith(`/campaigns/${CAMPAIGN}`) || call.url.pathname.endsWith(`/campaigns/${CAMPAIGN}/drafts`)) return campaign;
    });
    await provider.applyWrite(op('spotify_create_draft_from_published', { entity: 'campaigns', draft_id: CAMPAIGN }, 'create'), guard);
    expect(writes(calls)[0]!.init.body).toBeUndefined();
  });
  it('treats draft DELETE204 as success without parsing a JSON body', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined);
    await expect(provider.applyWrite(op('spotify_delete_draft', { entity: 'ads', draft_id: AD }, 'remove'), guard)).resolves.toMatchObject({ resourceIds: [AD] });
    expect(writes(calls)[0]!.url.pathname).toContain('/drafts/ads/');
  });
  it('can clean an account-owned orphan ad draft after its parent was deleted', async () => {
    const { provider, calls } = fixture(call => {
      if (call.url.pathname.endsWith(`/drafts/ads/${AD}`)) return call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : ad;
      return Response.json({}, { status: 404 });
    });
    await provider.applyWrite(op('spotify_delete_draft', { entity: 'ads', draft_id: AD }, 'remove'), guard);
    expect(calls.filter(c => c.init.method === 'GET').map(c => c.url.pathname)).toEqual([`/ads/v3/ad_accounts/${ACCOUNT}/drafts/ads/${AD}`]);
  });
  it('encodes atomic bulk draft deletion as repeated query parameters with no body', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined);
    await provider.applyWrite(op('spotify_delete_draft_ads', { draft_ids: [AD] }, 'remove'), guard);
    const call = writes(calls)[0]!;
    expect(call.url.pathname).toBe(`/ads/v3/ad_accounts/${ACCOUNT}/drafts/ads`);
    expect(call.url.searchParams.getAll('ad_draft_ids')).toEqual([AD]); expect(call.init.body).toBeUndefined();
  });
  it('refuses parent draft deletion while child ads remain, preventing native orphan records', async () => {
    const { provider, calls } = fixture(call => {
      if (call.url.pathname.endsWith('/drafts/ad_sets')) return { paging: { offset: 0, total_results: 1 }, ad_set_drafts: [group] };
      if (call.url.pathname.endsWith('/drafts/ads')) return { paging: { offset: 0, total_results: 1 }, ad_drafts: [ad] };
    });
    await expect(provider.previewWrite(op('spotify_delete_draft', { entity: 'campaigns', draft_id: CAMPAIGN }, 'remove'), guard)).rejects.toThrow('delete draft ads before');
    await expect(provider.previewWrite(op('spotify_delete_draft_ad_sets', { draft_ids: [GROUP] }, 'remove'), guard)).rejects.toThrow('delete draft ads before');
    expect(writes(calls)).toEqual([]);
  });
  it('retains native CTA language and drops response-only/null fields when editing its URL', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/drafts/ads/${AD}`) ? { ...ad, call_to_action: { ...ad.call_to_action, language: 'ENGLISH', locale: 'en', clickthrough_uri: null }, ...(call.init.method === 'PATCH' ? body(call) : {}) } : undefined);
    await provider.applyWrite(op('spotify_update_draft_ad', { draft_id: AD, call_to_action: { clickthrough_url: 'https://example.com/new' } }), guard);
    expect(body(writes(calls)[0]!).call_to_action).toEqual({ key: 'LEARN_MORE', language: 'ENGLISH', clickthrough_url: 'https://example.com/new' });
  });
  it('exposes only bounded documented validation fields with credentials redacted', async () => {
    const { provider } = fixture(() => Response.json({ messages: ['Field required; access secret refresh'], error_codes: [{ code: 'INVALID.FIELD' }], debug: 'do-not-expose' }, { status: 400 }));
    try { await provider.creatives.validate(ACCOUNT, CAMPAIGN, 7); throw new Error('Expected error'); }
    catch (error) { const text = JSON.stringify(error); expect(text).toContain('Field required'); expect(text).toContain('[redacted]'); expect(text).not.toContain('do-not-expose'); expect(text).not.toContain('secret'); expect(text).not.toContain('refresh'); }
  });
});

describe('Spotify validation and publication', () => {
  function publisher(options: { status?: string; version?: number; errors?: unknown[] } = {}) {
    return fixture(call => {
      if (call.url.pathname.endsWith(`/drafts/campaigns/${CAMPAIGN}`)) {
        if (call.init.method === 'POST') return { campaign, validation_errors: options.errors ?? [] };
        return { ...campaign, status: options.status ?? 'PAUSED', draft_hierarchy_version: options.version ?? 7 };
      }
      if (call.url.pathname.endsWith('/drafts/ad_sets')) return { paging: { offset: 0, total_results: 1 }, ad_set_drafts: [group] };
      if (call.url.pathname.endsWith(`/ad_sets/${GROUP}`)) return Response.json({}, { status: 404 });
    });
  }
  const operation = op('spotify_publish_draft', { draft_campaign_id: CAMPAIGN, draft_hierarchy_version: 7 }, 'create');
  it('includes the entire child budget/bid and validates the exact approved version before publishing PAUSED', async () => {
    const { provider, calls } = publisher();
    expect((await provider.previewWrite(operation, guard)).budgetDeltas.map(d => d.toMicros)).toEqual([100_000_000, 10_000_000]);
    expect(writes(calls)).toEqual([]);
    await provider.applyWrite(operation, guard);
    expect(writes(calls).map(c => body(c))).toEqual([{ action: 'VALIDATE', draft_hierarchy_version: 7 }, { action: 'PUBLISH', draft_hierarchy_version: 7 }]);
  });
  it('rejects an edited hierarchy version before any validation/publication POST', async () => {
    const { provider, calls } = publisher({ version: 8 });
    await expect(provider.applyWrite(operation, guard)).rejects.toThrow('hierarchy changed');
    expect(writes(calls)).toEqual([]);
  });
  it('does not publish an ACTIVE draft when paused_creation is enabled', async () => {
    const { provider, calls } = publisher({ status: 'ACTIVE' });
    await expect(provider.previewWrite(operation, guard)).rejects.toThrow('PAUSED draft');
    expect(writes(calls)).toEqual([]);
  });
  it('reports native validation errors and never sends PUBLISH after failed validation', async () => {
    const { provider, calls } = publisher({ errors: [{ message: 'Companion image missing' }] });
    await expect(provider.applyWrite(operation, guard)).rejects.toThrow('failed validation');
    expect(writes(calls).map(c => body(c).action)).toEqual(['VALIDATE']);
  });
  it('requires preview/apply approval and budget caps through the one shared registry', async () => {
    const { provider, calls } = publisher();
    const dir = await temp();
    const engine = new PolicyEngine({ ...DEFAULT_POLICY, max_daily_budget_micros: 50_000_000 }, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit')));
    const runtime = await createContext({ engine, providerModules: [{ provider, tools: spotifyTools(provider) }] });
    await expect(runtime.registry.call(operation.tool, { account_id: ACCOUNT, ...operation.payload }, runtime.ctx)).rejects.toThrow(/cap/);
    expect(writes(calls)).toEqual([]);
    const allowed = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'allowed')), new AuditLog(path.join(dir, 'allowed-audit'))), providerModules: [{ provider, tools: spotifyTools(provider) }] });
    const args = { account_id: ACCOUNT, ...operation.payload };
    const pending = await allowed.registry.call(operation.tool, args, allowed.ctx) as { pending_operation_id: string };
    expect(writes(calls)).toEqual([]);
    await expect(allowed.registry.call(operation.tool, { ...args, draft_hierarchy_version: 8, pending_operation_id: pending.pending_operation_id }, allowed.ctx)).rejects.toThrow('differs');
    await allowed.registry.call(operation.tool, { ...args, pending_operation_id: pending.pending_operation_id }, allowed.ctx);
    expect(writes(calls).map(c => body(c).action)).toEqual(['VALIDATE', 'PUBLISH']);
  });
});

describe('Spotify media and gallery', () => {
  it('sends exact approved bytes as native multipart media without a JSON content-type', async () => {
    const file = path.join(await temp(), 'qa.png'), bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]); await writeFile(file, bytes);
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/upload') ? { ...asset, status: 'PROCESSING' } : undefined);
    const operation = op('spotify_upload_asset', { asset_id: ASSET, file_path: file, expected_sha256: createHash('sha256').update(bytes).digest('hex') }, 'create');
    await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]);
    await provider.applyWrite(operation, guard);
    const call = writes(calls)[0]!, form = call.init.body as FormData;
    expect(call.init.headers).toEqual({ authorization: 'Bearer access' });
    expect(form.get('asset_type')).toBe('IMAGE'); expect(Buffer.from(await (form.get('media') as File).arrayBuffer())).toEqual(bytes);
    await writeFile(file, Buffer.concat([bytes, Buffer.from('changed')]));
    await expect(provider.applyWrite(operation, guard)).rejects.toThrow('SHA-256');
    expect(writes(calls)).toHaveLength(1);
  });
  it('refuses to overwrite a READY asset used by existing ads', async () => {
    const { provider, calls } = fixture(() => ({ ...asset, status: 'READY' }));
    await expect(provider.previewWrite(op('spotify_upload_asset', { asset_id: ASSET, file_path: '/unused.png', expected_sha256: 'a'.repeat(64) }, 'create'), guard)).rejects.toThrow('WAITING_UPLOAD');
    expect(writes(calls)).toEqual([]);
  });
  it('uses server chunk sizes, session IDs, one-based sections and asset_type on every transfer and completion', async () => {
    const bytes = Buffer.alloc(20_000_001); bytes.write('ID3'); const file = path.join(await temp(), 'qa.mp3'); await writeFile(file, bytes);
    const { provider, calls } = fixture(call => {
      if (call.url.pathname.endsWith(`/assets/${ASSET}`)) return { ...asset, asset_type: 'AUDIO' };
      if (call.url.pathname.endsWith('/start')) return { upload_session_id: SESSION, max_chunk_size_mb: 10 };
      if (call.url.pathname.endsWith('/transfer')) return { success: true };
      if (call.url.pathname.endsWith('/complete')) return { ...asset, asset_type: 'AUDIO', status: 'PROCESSING' };
    });
    await provider.applyWrite(op('spotify_upload_asset', { asset_id: ASSET, file_path: file, expected_sha256: createHash('sha256').update(bytes).digest('hex') }, 'create'), guard);
    const transfers = writes(calls).filter(c => c.url.pathname.endsWith('/transfer'));
    expect(transfers).toHaveLength(3);
    expect(transfers.map(c => [...(c.init.body as FormData).entries()].filter(([k]) => k !== 'media'))).toEqual([1, 2, 3].map(i => [['asset_type', 'AUDIO'], ['upload_session_id', SESSION], ['upload_section', String(i)]]));
    expect(transfers.map(c => ((c.init.body as FormData).get('media') as File).size)).toEqual([10_000_000, 10_000_000, 1]);
    expect(body(writes(calls).at(-1)!)).toEqual({ asset_type: 'AUDIO', upload_session_id: SESSION, number_of_sections: 3 });
  });
  it('renders actual ad copy and hydrated assets with account-bound draft edit actions', async () => {
    const { provider } = fixture(call => call.url.pathname.endsWith('/drafts/ads') ? { paging: { offset: 0, total_results: 1 }, ad_drafts: [ad] } : call.url.pathname.endsWith(`/assets/${ASSET}`) ? { ...asset, status: 'READY', url: 'https://i.scdn.co/image/qa' } : undefined);
    const result = await provider.creatives.ads({ account_id: ACCOUNT, draft: true, limit: 50, offset: 0 });
    expect(result.creatives[0]).toMatchObject({ descriptions: ['Original copy'], landing_urls: ['https://example.com'], media: [{ type: 'image', url: 'https://i.scdn.co/image/qa' }], actions: [{ tool: 'spotify_update_draft_ad', arguments: { account_id: ACCOUNT, draft_id: AD } }] });
    expect(result.truncated).toBe(false);
  });
  it('uses repeated array query parameters and returns explicit pagination', async () => {
    const { provider, calls } = fixture(() => ({ paging: { offset: 0, total_results: 2 }, ad_set_drafts: [group] }));
    const result = await provider.creatives.drafts({ account_id: ACCOUNT, entity: 'ad_sets', campaign_ids: [CAMPAIGN, AD], limit: 1, offset: 0 });
    expect(calls[1]!.url.searchParams.getAll('campaign_ids')).toEqual([CAMPAIGN, AD]);
    expect(result).toMatchObject({ truncated: true, next_offset: 1 });
  });
});
