import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, creativesOutput, verifyMedia, type MediaResolver, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { RedditAdsClient, REDDIT_TOKEN_URL } from '../src/client.js';
import { RedditAdsProvider } from '../src/provider.js';
import { redditTools } from '../src/tools.js';

// Outgoing shapes follow Reddit-owned current v3 OpenAPI (fetched2026-11-03).
const A = 'a2_test', C = 'campaign-1', G = 'group-1', AD = 'ad-1', P = 'profile-1', POST = 't3_post1', IMAGE = 'image-1';
const campaign = { id: C, ad_account_id: A, name: 'Campaign', type: 'MANUAL', is_campaign_budget_optimization: false, configured_status: 'PAUSED' };
const group = { id: G, ad_account_id: A, campaign_id: C, name: 'Group', type: 'MANUAL', configured_status: 'PAUSED', goal_type: 'DAILY_SPEND', goal_value: 10_000_000, bid_value: 100_000, bid_strategy: 'MAXIMIZE_VOLUME', bid_type: 'CPC', targeting: { geolocations: ['US'], communities: ['t5_example'], expand_targeting: false } };
const ad = { id: AD, ad_account_id: A, ad_group_id: G, campaign_id: C, post_id: POST, name: 'Ad', configured_status: 'PAUSED' };
const profile = { id: P, reddit_user_id: 't2_author', name: 'Adport QA' };
const asset = { id: IMAGE, type: 'IMAGE', name: 'Owned image', status: 'ACTIVE', media: { url: 'https://i.redd.it/image.png', permanent_url: 'https://i.redd.it/permanent.png', width: 640, height: 640 } };
const post = { id: POST, profile_id: 't2_author', allow_comments: false, creative: { type: 'IMAGE', headline: 'Actual headline', body: 'Existing body', text_format: 'PLAIN_TEXT', destination: { type: 'URL', url: 'https://example.com' }, image: { id: 'read-only-media-id', media: { type: 'URL', url: 'https://i.redd.it/image.png' } } } };
const guard = { forcePausedCreation: true };
type Call = { url: URL; init: RequestInit };
const body = (call: Call) => JSON.parse(String(call.init.body));
const writes = (calls: Call[]) => calls.filter(c => c.init.method !== 'GET' && c.url.href !== REDDIT_TOKEN_URL);
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'reddit', accountId: A, tool, payload, kind });
function fixture(handler?: (call: Call) => unknown, media?: MediaResolver) {
  const calls: Call[] = [];
  const client = new RedditAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', userAgent: 'desktop:adport.test:v0.7 (by /u/adporttest)' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === REDDIT_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (init.method === 'GET') {
      const responses: Record<string, unknown> = { [`/api/v3/campaigns/${C}`]: campaign, [`/api/v3/ad_groups/${G}`]: group, [`/api/v3/ads/${AD}`]: ad, [`/api/v3/structured_posts/${POST}`]: post, [`/api/v3/ad_accounts/${A}/profiles`]: [profile], [`/api/v3/ad_accounts/${A}/ads`]: [ad], [`/api/v3/ad_accounts/${A}/ad_groups`]: [group], [`/api/v3/profiles/${P}/creative_assets`]: [{ result: asset }], [`/api/v3/profiles/${P}/structured_posts`]: [post], [`/api/v3/ad_accounts/${A}/custom_audiences`]: [{ id: 'audience-1', ad_account_id: A }] };
      if (responses[call.url.pathname]) return Response.json({ data: responses[call.url.pathname], pagination: {} });
    }
    throw new Error(`Unexpected fixture request ${init.method} ${call.url.pathname}`);
  });
  return { calls, client, provider: new RedditAdsProvider(client, media) };
}
const groupInput = { campaign_id: C, name: 'New group', targeting: { geolocations: ['US'] }, bid_strategy: 'MAXIMIZE_VOLUME', bid_type: 'CPC', bid_micros: 100_000, budget_type: 'DAILY_SPEND', budget_micros: 10_000_000, configured_status: 'ACTIVE' };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('Reddit named children and policy gates', () => {
  it('uses the account-profile endpoint maximum of 100 and follows its exact continuation URL', async () => {
    const endpoint = `/api/v3/ad_accounts/${A}/profiles`;
    const next = `https://ads-api.reddit.com${endpoint}?page.size=100&page.token=second`;
    const second = { id: 'profile-2', reddit_user_id: 't2_second' };
    const { provider, calls } = fixture(call => call.url.pathname === endpoint
      ? call.url.searchParams.has('page.token') ? { data: [second] } : { data: [profile], pagination: { next_url: next } }
      : undefined);
    expect(await provider.creatives.profiles(A)).toEqual([profile, second]);
    const pages = calls.filter(call => call.url.pathname === endpoint);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.url.searchParams.get('page.size')).toBe('100');
    expect(pages[1]!.url.href).toBe(next);
  });

  it('builds one lazy, serializable catalog without reading a provider', () => {
    const provider = new Proxy({} as RedditAdsProvider, { get() { throw new Error('Eager provider access'); } });
    const tools = redditTools(provider); expect(new Set(tools.map(t => t.name)).size).toBe(tools.length); for (const tool of tools) expect(() => z.toJSONSchema(tool.input)).not.toThrow();
  });
  it('creates a paused manual ad group with exact native micro fields and explicit expansion off', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: { id: G, ad_account_id: A, ...body(call).data } } : undefined);
    const operation = op('reddit_create_ad_group', groupInput, 'create'), preview = await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]); expect(preview.coercions).toContain('configured_status coerced to PAUSED by policy (paused_creation)'); expect(preview.budgetDeltas.map(d => d.toMicros)).toEqual([10_000_000, 100_000]);
    await provider.applyWrite(operation, guard); expect(writes(calls)[0]!.url.pathname).toBe(`/api/v3/ad_accounts/${A}/ad_groups`); expect(body(writes(calls)[0]!)).toEqual({ data: { campaign_id: C, name: 'New group', targeting: { expand_targeting: false, geolocations: ['US'] }, bid_strategy: 'MAXIMIZE_VOLUME', bid_type: 'CPC', configured_status: 'PAUSED', type: 'MANUAL', goal_type: 'DAILY_SPEND', goal_value: 10_000_000, bid_value: 100_000 } });
  });
  it('inherits CBO money/bidding with native null fields and rejects child overrides', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/api/v3/campaigns/${C}` ? { data: { ...campaign, is_campaign_budget_optimization: true } } : call.init.method === 'POST' ? { data: { id: G, ad_account_id: A, ...body(call).data } } : undefined);
    await expect(provider.previewWrite(op('reddit_create_ad_group', groupInput, 'create'), guard)).rejects.toThrow('CBO ad groups inherit');
    await provider.applyWrite(op('reddit_create_ad_group', { campaign_id: C, name: 'Inherited', targeting: { geolocations: ['US'] }, bid_strategy: null, bid_type: null }, 'create'), guard);
    expect(body(writes(calls)[0]!).data).toMatchObject({ goal_value: null, goal_type: null, bid_value: null, bid_strategy: null, bid_type: null, configured_status: 'PAUSED' });
    await expect(provider.previewWrite(op('reddit_set_ad_group_budget', { ad_group_id: G, budget_micros: 11_000_000 }), guard)).rejects.toThrow('parent campaign');
  });
  it('keeps omitted targeting and native device dimensions while replacing supplied arrays', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { data: { ...group, ...body(call).data } } : undefined);
    await provider.applyWrite(op('reddit_update_targeting', { ad_group_id: G, targeting: { communities: ['t5_new'], devices: [{ type: 'MOBILE', os: 'IOS', min_version: '14' }] } }), guard);
    expect(body(writes(calls)[0]!).data.targeting).toEqual({ ...group.targeting, communities: ['t5_new'], devices: [{ type: 'MOBILE', os: 'IOS', min_version: '14' }] });
  });
  it.each(['budget', 'bidding'])('reads current micros for child %s and patches native values only', async kind => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { data: { ...group, ...body(call).data } } : undefined);
    const operation = op(`reddit_set_ad_group_${kind}`, kind === 'budget' ? { ad_group_id: G, budget_micros: 11_000_000 } : { ad_group_id: G, bid_micros: 110_000 });
    expect((await provider.previewWrite(operation, guard)).budgetDeltas[0]).toMatchObject({ fromMicros: kind === 'budget' ? 10_000_000 : 100_000, toMicros: kind === 'budget' ? 11_000_000 : 110_000 }); await provider.applyWrite(operation, guard); expect(body(writes(calls)[0]!).data).toEqual(kind === 'budget' ? { goal_value: 11_000_000 } : { bid_value: 110_000 });
  });
  it('refuses foreign parent accounts, foreign audiences and unsupported current targeting before writes', async () => {
    const foreign = fixture(call => call.url.pathname === `/api/v3/campaigns/${C}` ? { data: { ...campaign, ad_account_id: 'other' } } : undefined);
    await expect(foreign.provider.previewWrite(op('reddit_set_ad_status', { ad_id: AD, configured_status: 'PAUSED' }), guard)).rejects.toThrow('ownership'); expect(writes(foreign.calls)).toEqual([]);
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('reddit_update_targeting', { ad_group_id: G, targeting: { custom_audience_ids: ['foreign'] } }), guard)).rejects.toThrow('not available'); expect(writes(calls)).toEqual([]);
    const unknown = fixture(call => call.url.pathname === `/api/v3/ad_groups/${G}` ? { data: { ...group, targeting: { ...group.targeting, future_native_dimension: ['value'] } } } : undefined);
    await expect(unknown.provider.previewWrite(op('reddit_update_targeting', { ad_group_id: G, targeting: { communities: [] } }), guard)).rejects.toThrow('unsupported fields');
  });
  it('refuses an unbounded bid-cap removal instead of representing it as zero spend', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('reddit_set_ad_group_bidding', { ad_group_id: G, bid_strategy: 'BIDLESS' }), guard)).rejects.toThrow('removing an existing monetary bid cap'); expect(writes(calls)).toEqual([]);
  });
  it('creates a paused ad using an associated post and preserves configured status on replacement', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: { ...ad, ...body(call).data } } : call.init.method === 'PATCH' ? { data: { ...ad, ...body(call).data } } : undefined);
    await provider.applyWrite(op('reddit_create_ad', { ad_group_id: G, post_id: POST, name: 'New ad', configured_status: 'ACTIVE' }, 'create'), guard); expect(body(writes(calls)[0]!).data).toMatchObject({ type: 'UNSPECIFIED', configured_status: 'PAUSED', post_id: POST });
    const preview = await provider.previewWrite(op('reddit_update_ad', { ad_id: AD, post_id: POST }), guard); expect(preview.changes[0]).toContain('preserves configured status PAUSED');
    await provider.applyWrite(op('reddit_update_ad', { ad_id: AD, post_id: POST }), guard); expect(body(writes(calls)[1]!).data).toEqual({ post_id: POST });
  });
  it('archives with PATCH and retains returned IDs when the server violates paused creation', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { data: { ...ad, ...body(call).data } } : undefined);
    await provider.applyWrite(op('reddit_archive_entity', { entity: 'ads', resource_id: AD }), guard); expect(body(writes(calls)[0]!)).toEqual({ data: { configured_status: 'ARCHIVED' } });
    const bad = fixture(call => call.init.method === 'POST' ? { data: { id: G, ad_account_id: A, ...body(call).data, configured_status: 'ACTIVE' } } : undefined);
    await expect(bad.provider.applyWrite(op('reddit_create_ad_group', groupInput, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [G] } });
  });
  it('uses the shared exact-argument gate, budget caps and protected-account checks', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'reddit-child-')); dirs.push(directory);
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { data: { ...group, ...body(call).data } } : undefined);
    const audit = new AuditLog(path.join(directory, 'audit')), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(directory, 'pending')), audit), runtime = await createContext({ engine, providerModules: [{ provider, tools: redditTools(provider) }] });
    const args = { account_id: A, ad_group_id: G, budget_micros: 11_000_000 };
    const pending = await runtime.registry.call('reddit_set_ad_group_budget', args, runtime.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]);
    await expect(runtime.registry.call('reddit_set_ad_group_budget', { ...args, budget_micros: 11_100_000, pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('differs');
    await runtime.registry.call('reddit_set_ad_group_budget', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx); expect(writes(calls)).toHaveLength(1);
    await expect(runtime.registry.call('reddit_set_ad_group_budget', { ...args, budget_micros: 20_000_000 }, runtime.ctx)).rejects.toThrow('budget-delta cap');
    const blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(directory, 'blocked')), audit); await expect(blocked.validate(provider, op('reddit_set_ad_status', { ad_id: AD, configured_status: 'PAUSED' }))).rejects.toThrow('protected');
  });
});

describe('Reddit creative previews and async authoring', () => {
  it('renders actual referenced copy/media and bound stage-copy actions', async () => {
    const { provider } = fixture(), result = await provider.creatives.ads({ account_id: A, page_size: 20, include_post_details: true });
    expect(creativesOutput.safeParse(result).success).toBe(true); expect(result.creatives[0]).toMatchObject({ headlines: ['Actual headline'], descriptions: ['Existing body'], media: [{ type: 'image', url: 'https://i.redd.it/image.png' }], actions: expect.arrayContaining([{ label: 'Stage a creative copy', tool: 'reddit_stage_post_copy', arguments: { account_id: A, ad_id: AD, source_post_id: POST, profile_id: P }, fields: expect.any(Array) }]) });
  });
  it('surfaces denied post hydration while retaining selected-account ad configuration', async () => {
    const { provider } = fixture(call => call.url.pathname === `/api/v3/structured_posts/${POST}` ? Response.json({}, { status: 403 }) : undefined), result = await provider.creatives.ads({ account_id: A, page_size: 20, include_post_details: true });
    expect(result.creatives[0]!.id).toBe(AD); expect(result.creatives[0]!.media).toEqual([]); expect(result.warnings[0]!.message).toContain('403');
  });
  it('uses current native asset envelopes and canonical profile IDs', async () => {
    const { provider, calls } = fixture(); const result = await provider.creatives.assets({ account_id: A, profile_id: 't2_author', page_size: 20 }); expect(creativesOutput.safeParse(result).success).toBe(true); expect(result.creatives[0]).toMatchObject({ id: IMAGE, type: 'IMAGE_ASSET', media: [{ url: asset.media.permanent_url }] }); expect(calls.at(-1)!.url.pathname).toBe(`/api/v3/profiles/${P}/creative_assets`);
  });
  it('creates a current structured-post job from owned assets and gives a scoped poll receipt', async () => {
    const { provider, client, calls } = fixture(call => call.init.method === 'POST' ? { data: { id: 'job-1', status: 'QUEUED' } } : undefined);
    const operation = op('reddit_create_post', { profile_id: P, type: 'IMAGE', headline: 'New headline', image_asset_id: IMAGE, destination_url: 'https://example.com' }, 'create');
    await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]);
    const result = await provider.applyWrite(operation, guard), detail = result.details as { resource_receipt: string }; expect(result.resourceIds).toEqual(['job-1']); expect(client.verifyResourceReceipt(detail.resource_receipt, 'post_job', A, 'job-1')).toEqual({ profile_id: P });
    expect(writes(calls)[0]!.url.pathname).toBe(`/api/v3/profiles/${P}/structured_posts/jobs`); expect(body(writes(calls)[0]!)).toEqual({ data: { allow_comments: false, creative: { type: 'IMAGE', headline: 'New headline', destination: { type: 'URL', url: 'https://example.com' }, image: { media: { type: 'URL', url: asset.media.permanent_url } } } } });
  });
  it('stages a separate copy, keeps original body/media/comments and never patches the source post or ad', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: { id: 'job-1', status: 'PROCESSING' } } : undefined);
    await provider.applyWrite(op('reddit_stage_post_copy', { ad_id: AD, source_post_id: POST, profile_id: P, headline: 'Changed headline' }, 'create'), guard);
    expect(writes(calls)).toHaveLength(1); expect(writes(calls)[0]!.init.method).toBe('POST'); expect(body(writes(calls)[0]!)).toEqual({ data: { allow_comments: false, creative: { ...post.creative, headline: 'Changed headline', image: { media: { type: 'URL', url: 'https://i.redd.it/image.png' } } } } });
  });
  it('refuses source drift and foreign profile/post references through typed and generic writes', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('reddit_stage_post_copy', { ad_id: AD, source_post_id: 't3_changed', profile_id: P, headline: 'New' }, 'create'), guard)).rejects.toThrow('no longer matches'); expect(writes(calls)).toEqual([]);
    const foreign = fixture(call => call.url.pathname === `/api/v3/structured_posts/${POST}` ? { data: { ...post, profile_id: 't2_foreign' } } : undefined);
    await expect(foreign.provider.previewWrite(op('reddit_update_ad', { ad_id: AD, post_id: POST }), guard)).rejects.toThrow('not associated');
    await expect(foreign.provider.previewWrite(op('reddit_api_update', { path: `ads/${AD}`, body: { data: { post_id: POST } } }), guard)).rejects.toThrow('not associated'); expect(writes(foreign.calls)).toEqual([]);
    await expect(provider.previewWrite(op('reddit_api_update', { path: `ads/${AD}`, body: { data: { ad_group_id: 'foreign' } } }), guard)).rejects.toThrow('parent/account changes');
  });
  it('checks scoped job receipts and current profile association before fetching account-less status', async () => {
    const { provider, client, calls } = fixture(call => call.url.pathname === '/api/v3/structured_posts/jobs/job-1' ? { data: { id: 'job-1', status: 'SUCCESS', post_id: POST, error_message: null } } : undefined), receipt = client.resourceReceipt('post_job', A, P, 'job-1');
    await expect(provider.creatives.postJob({ account_id: A, job_id: 'job-1', resource_receipt: 'invalid' })).rejects.toThrow('invalid or expired'); expect(calls).toEqual([]);
    expect(await provider.creatives.postJob({ account_id: A, job_id: 'job-1', resource_receipt: receipt })).toMatchObject({ status: 'SUCCESS', post_id: POST });
    const revoked = fixture(call => call.url.pathname.endsWith('/profiles') ? { data: [] } : undefined);
    await expect(revoked.provider.creatives.postJob({ account_id: A, job_id: 'job-1', resource_receipt: receipt })).rejects.toThrow('not unambiguously associated'); expect(revoked.calls.some(call => call.url.pathname.includes('/structured_posts/jobs/'))).toBe(false);
  });
  it('follows native list URLs, rejects cross-account cursors and does not add pagination parameters to native unpaged targeting', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/api/v3/targeting/geolocations' ? { data: [{ id: 'US' }, { id: 'CA' }] } : undefined);
    const result = await provider.creatives.targetingOptions({ account_id: A, dimension: 'geolocations', country: 'US', page_size: 1 }); expect(result.truncated).toBe(true); expect(calls.at(-1)!.url.searchParams.get('country')).toBe('US'); expect(calls.at(-1)!.url.searchParams.has('page.size')).toBe(false);
    await expect(provider.creatives.groups({ account_id: A, page_size: 50, cursor: 'https://ads-api.reddit.com/api/v3/ad_accounts/foreign/ad_groups?page.token=next' })).rejects.toThrow('changed resource scope');
  });
});

describe('Reddit media pulled from approved immutable sources', () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), sha = createHash('sha256').update(bytes).digest('hex');
  it('generates private source URLs only on apply and never fetches them with Reddit credentials', async () => {
    const providerUrl = vi.fn(async () => ({ url: 'https://storage.example.com/private/asset?token=private-grant', expires_at: new Date(Date.now() + 3_600_000).toISOString(), sha256: sha }));
    const media: MediaResolver = { read: async (source, options) => verifyMedia(bytes, 'qa.png', source.expected_sha256, options), providerUrl };
    const { provider, client, calls } = fixture(call => call.init.method === 'POST' ? { data: [{ id: 'upload-1' }] } : undefined, media);
    const operation = op('reddit_upload_asset', { profile_id: P, type: 'IMAGE', name: 'QA image', media_id: '00000000-0000-4000-8000-000000000001', expected_sha256: sha }, 'create');
    const preview = await provider.previewWrite(operation, guard); expect(providerUrl).not.toHaveBeenCalled(); expect(JSON.stringify(preview)).not.toContain('private-grant'); expect(writes(calls)).toEqual([]);
    const applied = await provider.applyWrite(operation, guard); expect(providerUrl).toHaveBeenCalledTimes(1); expect(body(writes(calls)[0]!)).toEqual({ data: [{ name: 'QA image', type: 'IMAGE', media: { type: 'URL', url: 'https://storage.example.com/private/asset?token=private-grant' } }] });
    expect(calls.some(call => call.url.hostname === 'storage.example.com')).toBe(false); const detail = applied.details as { resource_receipt: string }; expect(client.verifyResourceReceipt(detail.resource_receipt, 'asset_upload', A, 'upload-1')).toEqual({ profile_id: P });
  });
  it('rejects changed source digests and explicit private/IP import URLs before a native upload', async () => {
    const media: MediaResolver = { read: async source => verifyMedia(bytes, 'qa.png', source.expected_sha256), providerUrl: async () => ({ url: 'https://storage.example.com/image', expires_at: new Date(Date.now() + 3600_000).toISOString(), sha256: '0'.repeat(64) }) };
    const { provider, calls } = fixture(undefined, media); await expect(provider.applyWrite(op('reddit_upload_asset', { profile_id: P, type: 'IMAGE', name: 'QA', media_id: '00000000-0000-4000-8000-000000000001', expected_sha256: sha }, 'create'), guard)).rejects.toThrow('changed immutable'); expect(writes(calls)).toEqual([]);
    await expect(provider.previewWrite(op('reddit_import_asset_url', { profile_id: P, type: 'IMAGE', name: 'QA', media_url: 'https://127.0.0.1/private' }, 'create'), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it('submits native HEADLINE asset creation and reports duplicated assets without treating them as newly created', async () => {
    const { provider, client, calls } = fixture(call => call.init.method === 'POST' ? { data: [{ id: 'upload-1' }] } : call.url.pathname === '/api/v3/creative_assets/uploads/upload-1' ? { data: { id: 'upload-1', status: 'ACTIVE', result: { ...asset, status: 'DUPLICATE_ASSET' } } } : undefined);
    const applied = await provider.applyWrite(op('reddit_create_text_asset', { profile_id: P, type: 'HEADLINE', text: 'New headline' }, 'create'), guard); expect(body(writes(calls)[0]!)).toEqual({ data: [{ type: 'HEADLINE', text: 'New headline' }] });
    const detail = applied.details as { resource_receipt: string }; expect(client.verifyResourceReceipt(detail.resource_receipt, 'asset_upload', A, 'upload-1')).toBeTruthy();
    const status = await provider.creatives.uploadStatus({ account_id: A, upload_id: 'upload-1', resource_receipt: detail.resource_receipt }); expect(status.warning).toContain('not proof'); expect(writes(calls)).toHaveLength(1);
  });
});
