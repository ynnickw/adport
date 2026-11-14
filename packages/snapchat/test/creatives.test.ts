import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, creativesOutput, verifyMedia, type MediaResolver, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { SnapchatAdsClient, SNAPCHAT_TOKEN_URL } from '../src/client.js';
import { SnapchatAdsProvider } from '../src/provider.js';
import { snapchatTools } from '../src/tools.js';

// Wire fixtures follow current Snap-owned v1 docs (reviewed2026-11-03):
// /Ads-API/{ad-squads,ads,creatives,media,targeting}, and Public-Profile-API/ProfileAssetManagement.
const A = 'account-1', C = 'campaign-1', G = 'squad-1', AD = 'ad-1', CR = 'creative-1', M = 'media-1';
const campaign = { id: C, ad_account_id: A, status: 'PAUSED', name: 'QA parent' };
const group = { id: G, campaign_id: C, status: 'PAUSED', name: 'QA squad', daily_budget_micro: '100000000', delivery_constraint: 'DAILY_BUDGET', bid_strategy: 'TARGET_COST', bid_micro: '1000000', targeting: { geos: [{ country_code: 'us' }], demographics: [{ min_age: '21' }], devices: [{ os_type: 'iOS' }] } };
const ad = { id: AD, ad_squad_id: G, creative_id: CR, type: 'REMOTE_WEBPAGE', status: 'PAUSED', name: 'QA ad' };
const creative = { id: CR, ad_account_id: A, name: 'QA creative', headline: 'A headline', brand_name: 'QA brand', type: 'WEB_VIEW', top_snap_media_id: M, web_view_properties: { url: 'https://example.com', block_preload: true, future_server_field: 'preserved' } };
const media = { id: M, ad_account_id: A, name: 'QA media', type: 'IMAGE', media_status: 'READY', download_link: 'https://storage.googleapis.com/ad-manager-creatives-production/test.png' };
const guard = { forcePausedCreation: true };
type Call = { url: URL; init: RequestInit };
const body = (call: Call) => JSON.parse(String(call.init.body));
function envelope(entity: string, singular: string, rows: unknown[]) { return { request_status: 'SUCCESS', [entity]: rows.map(row => ({ sub_request_status: 'SUCCESS', [singular]: row })) }; }
function fixture(handler?: (call: Call) => unknown | Response, resolver?: MediaResolver) {
  const calls: Call[] = [];
  const client = new SnapchatAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === SNAPCHAT_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (init.method === 'GET') {
      const defaults: Record<string, unknown> = {
        [`/v1/campaigns/${C}`]: envelope('campaigns', 'campaign', [campaign]),
        [`/v1/adsquads/${G}`]: envelope('adsquads', 'adsquad', [group]),
        [`/v1/ads/${AD}`]: envelope('ads', 'ad', [ad]),
        [`/v1/creatives/${CR}`]: envelope('creatives', 'creative', [creative]),
        [`/v1/media/${M}`]: envelope('media', 'media', [media]),
        [`/v1/adaccounts/${A}/ads`]: envelope('ads', 'ad', [ad]),
        [`/v1/adaccounts/${A}/creatives`]: envelope('creatives', 'creative', [creative]),
        [`/v1/adaccounts/${A}/sharing_policies`]: { request_status: 'SUCCESS', sharing_policies: [{ sharing_policy_id: 'policy-1', source: { resource_type: 'public_profiles', resource_id: 'profile-1' } }] },
      };
      if (defaults[call.url.pathname]) return Response.json(defaults[call.url.pathname]);
    }
    throw new Error(`Unexpected request ${init.method} ${call.url.href}`);
  });
  return { provider: new SnapchatAdsProvider(client, resolver), client, calls };
}
const writes = (calls: Call[]) => calls.filter(c => c.init.method !== 'GET' && c.url.href !== SNAPCHAT_TOKEN_URL);
function op(tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation { return { provider: 'snapchat', accountId: A, tool, kind, payload }; }
const groupInput = { campaign_id: C, name: 'QA new squad', optimization_goal: 'SWIPES', bid_strategy: 'TARGET_COST', bid_micro: 2_000_000, daily_budget_micro: 100_000_000, targeting: { geos: [{ country_code: 'us' }] }, status: 'ACTIVE' };
function applyPatch(current: Record<string, unknown>, patch: Array<{ path: string; value: unknown }>) { const next = structuredClone(current); for (const p of patch) { const keys = p.path.slice(1).split('/'); let value = next; for (const key of keys.slice(0, -1)) value = value[key] as Record<string, unknown>; value[keys.at(-1)!] = p.value; } return next; }
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('Snapchat child hierarchy and guarded writes', () => {
  it('constructs one lazy, serializable catalog without provider access', () => {
    const proxy = new Proxy({} as SnapchatAdsProvider, { get() { throw new Error('Eager provider access'); } });
    const tools = snapchatTools(proxy); expect(new Set(tools.map(t => t.name)).size).toBe(tools.length);
    expect(tools.map(t => t.name)).toContain('snapchat_create_creative');
    for (const tool of tools) expect(() => z.toJSONSchema(tool.input)).not.toThrow();
  });
  it('creates paused ad squads with native billing/placement/budget units and surfaces server coercion warnings', async () => {
    const warning = { code: 'CONVERSION_WINDOW_NULL_AUTO_SET', message: 'Warning, ConversionWindow is null, auto-set to 28/1.' };
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { ...envelope('adsquads', 'adsquad', [{ id: G, ...body(call).adsquads[0] }]), adsquads: [{ sub_request_status: 'SUCCESS', sub_request_warnings: [warning], adsquad: { id: G, ...body(call).adsquads[0] } }] } : undefined);
    const operation = op('snapchat_create_adsquad', groupInput, 'create'), preview = await provider.previewWrite(operation, guard);
    expect(writes(calls)).toEqual([]); expect(preview.serverValidated).toBe(false); expect(preview.coercions).toContain('status coerced to PAUSED by policy (paused_creation)');
    expect(preview.budgetDeltas.map(d => d.toMicros)).toEqual([100_000_000, 2_000_000]);
    const result = await provider.applyWrite(operation, guard); expect(result.details).toEqual({ warnings: [JSON.stringify(warning)] });
    const call = writes(calls)[0]!; expect(call.url.pathname).toBe(`/v1/campaigns/${C}/adsquads`);
    expect(body(call)).toEqual({ adsquads: [{ ...groupInput, status: 'PAUSED', type: 'SNAP_ADS', billing_event: 'IMPRESSION', placement_v2: { config: 'AUTOMATIC' }, delivery_constraint: 'DAILY_BUDGET' }] });
  });
  it('patches only selected targeting dimensions without replacing other targeting', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? envelope('adsquads', 'adsquad', [applyPatch(group, body(call))]) : undefined);
    await provider.applyWrite(op('snapchat_update_targeting', { ad_squad_id: G, targeting: { demographics: [{ min_age: '25', max_age: '34' }] } }), guard);
    const call = writes(calls)[0]!; expect(call.url.pathname).toBe(`/v1/campaigns/${C}/adsquads/${G}`); expect(call.init.headers).toMatchObject({ 'content-type': 'application/json-patch+json' });
    expect(body(call)).toEqual([{ op: 'replace', path: '/targeting/demographics', value: [{ min_age: '25', max_age: '34' }] }]);
  });
  it.each(['snapchat_set_adsquad_budget', 'snapchat_set_adsquad_bidding'])('checks current string monetary values for %s and patches micro integers', async tool => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? envelope('adsquads', 'adsquad', [applyPatch(group, body(call))]) : undefined);
    const operation = op(tool, tool.endsWith('budget') ? { ad_squad_id: G, budget_micros: 110_000_000 } : { ad_squad_id: G, bid_micros: 1_100_000 });
    const preview = await provider.previewWrite(operation, guard); expect(preview.budgetDeltas[0]).toMatchObject({ fromMicros: tool.endsWith('budget') ? 100_000_000 : 1_000_000, toMicros: tool.endsWith('budget') ? 110_000_000 : 1_100_000 });
    await provider.applyWrite(operation, guard); expect(body(writes(calls)[0]!)).toHaveLength(1);
  });
  it('refuses a foreign parent before changing a child', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v1/campaigns/${C}` ? envelope('campaigns', 'campaign', [{ ...campaign, ad_account_id: 'foreign' }]) : undefined);
    await expect(provider.applyWrite(op('snapchat_set_ad_status', { ad_id: AD, status: 'PAUSED' }), guard)).rejects.toThrow('ownership'); expect(writes(calls)).toEqual([]);
  });
  it('validates native ad/creative format mapping and sends only a paused ad', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? envelope('ads', 'ad', [{ id: AD, ...body(call).ads[0] }]) : undefined);
    await expect(provider.previewWrite(op('snapchat_create_ad', { ad_squad_id: G, creative_id: CR, name: 'New ad', type: 'SNAP_AD' }, 'create'), guard)).rejects.toThrow('incompatible');
    await provider.applyWrite(op('snapchat_create_ad', { ad_squad_id: G, creative_id: CR, name: 'New ad', type: 'REMOTE_WEBPAGE', status: 'ACTIVE' }, 'create'), guard);
    expect(writes(calls)[0]!.url.pathname).toBe(`/v1/adsquads/${G}/ads`); expect(body(writes(calls)[0]!).ads[0].status).toBe('PAUSED');
  });
  it.each([{ targeting: { geos: [] } }, { targeting: { geos: [{ country_code: 'us' }, { country_code: 'ca' }] } }, { daily_budget_micro: 4_000_000 }, { lifetime_budget_micro: 20_000_000 }, { bid_strategy: 'MIN_ROAS' }])('rejects invalid, ambiguous or deprecated configuration before a mutation: %j', async overrides => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('snapchat_create_adsquad', { ...groupInput, ...overrides }, 'create'), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it.each(['ACTIVE', 'FOREIGN', 'WRONG_PARENT'])('rejects unsafe create receipts while preserving created IDs: %s', async failure => {
    const { provider } = fixture(call => call.init.method === 'POST' ? envelope('adsquads', 'adsquad', [{ id: G, ...body(call).adsquads[0], ...(failure === 'ACTIVE' ? { status: 'ACTIVE' } : failure === 'FOREIGN' ? { ad_account_id: 'foreign' } : { campaign_id: 'foreign' }) }]) : undefined);
    await expect(provider.applyWrite(op('snapchat_create_adsquad', groupInput, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [G] } });
  });
  it('retains successful batch IDs on a partial native failure without claiming applied success', async () => {
    const { client } = fixture(call => call.init.method === 'POST' ? { request_status: 'PARTIAL', ads: [{ sub_request_status: 'SUCCESS', ad }, { sub_request_status: 'ERROR', sub_request_error_reason: 'secret access rejected' }] } : undefined);
    try { await client.mutation(`adsquads/${G}/ads`, 'POST', {}, 'ads', 'ad', z.object({ id: z.string() })); throw new Error('Expected failure'); }
    catch (error) { expect(error).toMatchObject({ details: { resource_ids: [AD], errors: [{ sub_request_error_reason: '[redacted] [redacted] rejected' }] } }); }
  });
  it('deletes a verified child with native DELETE and an empty successful envelope', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'DELETE' ? { request_status: 'SUCCESS', ads: [] } : undefined);
    const operation = op('snapchat_delete_entity', { entity: 'ads', resource_id: AD }, 'remove'); expect((await provider.previewWrite(operation, guard)).changes[0]).toContain('cannot be undone'); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [AD] }); expect(writes(calls)[0]!.url.pathname).toBe(`/v1/ads/${AD}`);
  });
  it('enforces exact approval arguments, protected accounts and monetary caps through the shared registry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'snap-child-')); dirs.push(dir);
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? envelope('adsquads', 'adsquad', [applyPatch(group, body(call))]) : undefined);
    const audit = new AuditLog(path.join(dir, 'audit')), engine = new PolicyEngine({ ...DEFAULT_POLICY, max_budget_delta_pct: 20 }, new PendingStore(path.join(dir, 'pending')), audit);
    const rt = await createContext({ engine, providerModules: [{ provider, tools: snapchatTools(provider) }] });
    const args = { account_id: A, ad_squad_id: G, budget_micros: 110_000_000 };
    const pending = await rt.registry.call('snapchat_set_adsquad_budget', args, rt.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]);
    await expect(rt.registry.call('snapchat_set_adsquad_budget', { ...args, budget_micros: 111_000_000, pending_operation_id: pending.pending_operation_id }, rt.ctx)).rejects.toThrow('differs');
    await rt.registry.call('snapchat_set_adsquad_budget', { ...args, pending_operation_id: pending.pending_operation_id }, rt.ctx); expect(writes(calls)).toHaveLength(1);
    await expect(rt.registry.call('snapchat_set_adsquad_budget', { ...args, budget_micros: 200_000_000 }, rt.ctx)).rejects.toThrow('budget-delta cap');
    const blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(dir, 'blocked')), audit);
    await expect(blocked.validate(provider, op('snapchat_set_ad_status', { ad_id: AD, status: 'PAUSED' }))).rejects.toThrow('protected');
  });
});

describe('Snapchat creative copy, media and pagination', () => {
  it('creates a reusable creative only from an available profile and READY owned media', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? envelope('creatives', 'creative', [{ id: CR, ...body(call).creatives[0] }]) : undefined);
    const operation = op('snapchat_create_creative', { name: 'QA new creative', headline: 'Shop now', type: 'WEB_VIEW', profile_id: 'profile-1', top_snap_media_id: M, web_view_properties: { url: 'https://example.com' } }, 'create');
    await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]); await provider.applyWrite(operation, guard);
    expect(body(writes(calls)[0]!)).toMatchObject({ creatives: [{ ad_account_id: A, profile_properties: { profile_id: 'profile-1' } }] }); expect(body(writes(calls)[0]!).creatives[0]).not.toHaveProperty('profile_id');
    const profile = calls.find(call => call.url.hostname === 'businessapi.snapchat.com')!; expect(profile.url.pathname).toBe(`/v1/adaccounts/${A}/sharing_policies`); expect(profile.url.searchParams.get('shared_resource_types')).toBe('public_profiles');
  });
  it.each(['profile', 'media'])('rejects foreign %s before creating a creative', async kind => {
    const { provider, calls } = fixture(call => kind === 'media' && call.url.pathname === `/v1/media/${M}` ? envelope('media', 'media', [{ ...media, ad_account_id: 'foreign' }]) : undefined);
    await expect(provider.previewWrite(op('snapchat_create_creative', { name: 'New', headline: 'New', type: 'SNAP_AD', profile_id: kind === 'profile' ? 'foreign' : 'profile-1', top_snap_media_id: M }, 'create'), guard)).rejects.toThrow(/available|ownership/); expect(writes(calls)).toEqual([]);
  });
  it('warns about shared creative edits and patches nested copy without resending attachment defaults', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? envelope('creatives', 'creative', [applyPatch(creative, body(call))]) : undefined);
    const operation = op('snapchat_update_creative', { creative_id: CR, headline: 'New headline', web_view_properties: { url: 'https://example.com/new' } });
    expect((await provider.previewWrite(operation, guard)).changes[0]).toContain('all 1 linked ad(s)'); await provider.applyWrite(operation, guard);
    expect(body(writes(calls)[0]!)).toEqual([{ op: 'replace', path: '/headline', value: 'New headline' }, { op: 'replace', path: '/web_view_properties/url', value: 'https://example.com/new' }]);
  });
  it('refuses media replacement on a creative linked to any ad', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('snapchat_update_creative', { creative_id: CR, top_snap_media_id: M }), guard)).rejects.toThrow('unused creative'); expect(writes(calls)).toEqual([]);
  });
  it.each([{ call_to_action: 'INSTALL_NOW' }, { app_install_properties: { app_name: 'Wrong attachment' } }])('rejects copy/attachment fields incompatible with the native creative type: %j', async fields => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('snapchat_update_creative', { creative_id: CR, ...fields }), guard)).rejects.toThrow(/not supported|does not match/); expect(writes(calls)).toEqual([]);
  });
  it('refuses a Lens package as Top Snap media before creating a creative', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v1/media/${M}` ? envelope('media', 'media', [{ ...media, type: 'LENS_PACKAGE' }]) : undefined);
    await expect(provider.previewWrite(op('snapchat_create_creative', { name: 'New', headline: 'New', profile_id: 'profile-1', top_snap_media_id: M, type: 'SNAP_AD' }, 'create'), guard)).rejects.toThrow('IMAGE or VIDEO'); expect(writes(calls)).toEqual([]);
  });
  it('renders actual copy and native media with account-bound preview actions', async () => {
    const { provider } = fixture(), result = await provider.creatives.gallery({ account_id: A, limit: 20 });
    expect(creativesOutput.safeParse(result).success).toBe(true); expect(result.creatives[0]).toMatchObject({ id: CR, headlines: ['A headline'], landing_urls: ['https://example.com'], media: [{ type: 'image', url: media.download_link }], actions: [{ arguments: { account_id: A, creative_id: CR } }] });
  });
  it('keeps copy visible and reports denied media hydration accurately', async () => {
    const { provider } = fixture(call => call.url.pathname === `/v1/media/${M}` ? Response.json({}, { status: 403 }) : undefined);
    const result = await provider.creatives.gallery({ account_id: A, limit: 20 }); expect(result.creatives[0]!.headlines).toEqual(['A headline']); expect(result.creatives[0]!.media).toEqual([]); expect(result.warnings[0]!.message).toContain('403');
  });
  it('returns the next cursor and validates page scope before exposing it', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v1/adaccounts/${A}/media` ? { ...envelope('media', 'media', [media]), paging: { next_link: `https://adsapi.snapchat.com/v1/adaccounts/${A}/media?cursor=page2&limit=3` } } : undefined);
    expect(await provider.creatives.page({ account_id: A, limit: 3, cursor: 'page1' }, 'media')).toMatchObject({ truncated: true, next_cursor: 'page2' }); expect(calls.at(-1)!.url.searchParams.get('cursor')).toBe('page1');
    const unsafe = fixture(call => call.url.pathname.endsWith('/media') ? { ...envelope('media', 'media', [media]), paging: { next_link: 'https://evil.example/v1/media?cursor=page2' } } : undefined);
    await expect(unsafe.provider.creatives.page({ account_id: A, limit: 3 }, 'media')).rejects.toThrow('invalid API URL');
  });
  it('uses plural native languages path and reports native dimension status failures', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/v1/targeting/demographics/languages' ? { request_status: 'SUCCESS', targeting_dimensions: [{ sub_request_status: 'SUCCESS', language: { id: 'en', name: 'English' } }] } : undefined);
    expect((await provider.creatives.targetingOptions({ account_id: A, dimension: 'language', limit: 5 })).items).toHaveLength(1); expect(calls.at(-1)!.url.searchParams.get('limit')).toBe('5');
  });
  it('sends the selected country and HCE filter for native lifestyle categories', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/v1/targeting/v1/interests/scls' ? { request_status: 'SUCCESS', targeting_dimensions: [] } : undefined);
    await provider.creatives.targetingOptions({ account_id: A, dimension: 'scls', country_code: 'US', is_hec: true, limit: 50 });
    expect(calls.at(-1)!.url.searchParams.get('country_code')).toBe('us'); expect(calls.at(-1)!.url.searchParams.get('is_hec')).toBe('true');
  });
  it('does not expose malformed JSON response bodies or automatically replay failed uploads', async () => {
    const { client, calls } = fixture(call => call.init.method === 'POST' ? new Response('sensitive provider body', { status: 200 }) : undefined);
    try { await client.request('media/media-1/upload', 'POST', z.object({ request_status: z.string() }), new FormData()); throw new Error('Expected failure'); } catch (error) { expect((error as Error).message).toBe('snapchat: malformed API envelope'); }
    expect(writes(calls)).toHaveLength(1);
  });
  it('refuses sharing-policy pagination to another account or resource type without forwarding authorization', async () => {
    const { client, calls } = fixture(call => call.url.hostname === 'businessapi.snapchat.com' ? { request_status: 'SUCCESS', sharing_policies: [], paging: { next_link: 'https://evil.example/v1/adaccounts/other/sharing_policies?shared_resource_types=public_profiles' } } : undefined);
    await expect(client.sharingPolicies(A, 'public_profiles')).rejects.toThrow('changed scope'); expect(calls.some(call => call.url.hostname === 'evil.example')).toBe(false);
  });
});

describe('Snapchat checksum-bound multipart uploads', () => {
  function source(video = false, length = 20) { const bytes = new Uint8Array(length); bytes.set(video ? [0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50] : [137, 80, 78, 71, 13, 10, 26, 10]); const sha = createHash('sha256').update(bytes).digest('hex'); const resolver: MediaResolver = { read: async (input, options) => verifyMedia(bytes, video ? 'qa.mp4' : 'qa.png', input.expected_sha256, options) }; return { bytes, sha, resolver }; }
  it('uploads exactly approved bytes using multipart file and verifies native result ownership', async () => {
    const src = source(), { provider, calls } = fixture(call => call.url.pathname === `/v1/media/${M}` ? envelope('media', 'media', [{ ...media, media_status: 'PENDING_UPLOAD' }]) : call.init.method === 'POST' ? { request_status: 'SUCCESS', result: media } : undefined, src.resolver);
    const operation = op('snapchat_upload_media', { snapchat_media_id: M, file_path: '/qa.png', expected_sha256: src.sha });
    await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]); const result = await provider.applyWrite(operation, guard); expect(result).toMatchObject({ resourceIds: [M], details: { media_status: 'READY', sha256: src.sha } });
    const call = writes(calls)[0]!; expect(call.url.pathname).toBe(`/v1/media/${M}/upload`); expect(call.init.headers).not.toHaveProperty('content-type');
    const form = call.init.body as FormData, file = form.get('file') as File; expect(file.name).toBe('qa.png'); expect(new Uint8Array(await file.arrayBuffer())).toEqual(src.bytes);
  });
  it.each(['READY', 'FOREIGN', 'HASH'])('rejects %s uploads before any upload call', async reason => {
    const src = source(), { provider, calls } = fixture(call => call.url.pathname === `/v1/media/${M}` ? envelope('media', 'media', [{ ...media, media_status: reason === 'READY' ? 'READY' : 'PENDING_UPLOAD', ad_account_id: reason === 'FOREIGN' ? 'other' : A }]) : undefined, src.resolver);
    await expect(provider.previewWrite(op('snapchat_upload_media', { snapchat_media_id: M, file_path: '/qa.png', expected_sha256: reason === 'HASH' ? '0'.repeat(64) : src.sha }), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it('follows native INIT/ADD/FINALIZE for a large video with exact multipart fields', async () => {
    const src = source(true, 32_000_001), video = { ...media, type: 'VIDEO' };
    const { provider, calls } = fixture(call => {
      if (call.init.method === 'GET' && call.url.pathname === `/v1/media/${M}`) return envelope('media', 'media', [{ ...video, media_status: 'PENDING_UPLOAD' }]);
      if (call.url.searchParams.get('action') === 'INIT') return { request_status: 'SUCCESS', upload_id: 'upload-1', add_path: `/us/v1/media/${M}/multipart-upload-v2?action=ADD`, finalize_path: `/v1/media/${M}/multipart-upload-v2?action=FINALIZE` };
      if (call.url.searchParams.get('action') === 'ADD') return { request_status: 'SUCCESS' };
      if (call.url.searchParams.get('action') === 'FINALIZE') return { request_status: 'SUCCESS', result: video };
    }, src.resolver);
    await provider.applyWrite(op('snapchat_upload_media', { snapchat_media_id: M, file_path: '/qa.mp4', expected_sha256: src.sha }), guard);
    const mutations = writes(calls); expect(mutations.map(c => c.url.searchParams.get('action'))).toEqual(['INIT', 'ADD', 'ADD', 'FINALIZE']);
    expect(Object.fromEntries(mutations[0]!.init.body as FormData)).toEqual({ file_name: 'qa.mp4', file_size: '32000001', number_of_parts: '2' });
    expect(mutations.slice(1, 3).map(c => (c.init.body as FormData).get('part_number'))).toEqual(['1', '2']); expect(mutations.slice(1, 3).map(c => ((c.init.body as FormData).get('file') as File).size)).toEqual([32_000_000, 1]);
    expect((mutations[3]!.init.body as FormData).get('upload_id')).toBe('upload-1');
  });
  it.each(['https://evil.example/v1/media/media-1/multipart-upload-v2?action=ADD', '/us/v1/media/foreign/multipart-upload-v2?action=ADD', '/us/v1/media/media-1/multipart-upload-v2?action=FINALIZE'])('rejects unsafe native chunk paths before forwarding bytes: %s', async unsafe => {
    const src = source(true, 32_000_001), { provider, calls } = fixture(call => call.init.method === 'GET' && call.url.pathname === `/v1/media/${M}` ? envelope('media', 'media', [{ ...media, type: 'VIDEO', media_status: 'PENDING_UPLOAD' }]) : call.url.searchParams.get('action') === 'INIT' ? { request_status: 'SUCCESS', upload_id: 'up-1', add_path: unsafe, finalize_path: `/v1/media/${M}/multipart-upload-v2?action=FINALIZE` } : undefined, src.resolver);
    await expect(provider.applyWrite(op('snapchat_upload_media', { snapchat_media_id: M, file_path: '/qa.mp4', expected_sha256: src.sha }), guard)).rejects.toThrow('changed media/action scope'); expect(writes(calls)).toHaveLength(1);
  });
});
