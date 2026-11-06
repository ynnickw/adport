import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, creativesOutput, DEFAULT_POLICY, nextPageArguments, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';
import { createPost, createPromotions, postFields, type NativePost } from '../src/post-schemas.js';

// Fresh official xdevplatform/docs: creatives a9226e10, campaign-management570f918c,
// inspected2026-11-06. POST /tweet is distinct from a draft; promoted_tweets POST array,
// DELETE object tombstone retains ACTIVE. No PUT association status endpoint.
const A = 'a1', U = '756201191646691328', P = '1166476031668015104', P2 = '1166476031668015105', NEW = '1166476031668015199', M = '3_908573900237180928';
const account = { id: A, name: 'QA account', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false };
const campaign = { id: 'c1', name: 'QA campaign', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null };
const line = { id: 'l1', name: 'QA ad group', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'ENGAGEMENTS', daily_budget_amount_local_micro: 5_000_000, total_budget_amount_local_micro: null };
const post: NativePost = { id_str: P, user: { id_str: U }, name: 'QA post', full_text: 'Exact <copy> & + Unicode ✓', nullcast: true, tweet_type: 'PUBLISHED', conversation_settings: 'EVERYONE', truncated: false, entities: { urls: [] } };
const promo = { id: 'pt1', line_item_id: 'l1', tweet_id: P, entity_status: 'ACTIVE', deleted: false };
const guard = { forcePausedCreation: true };
type Call = { url: URL; init: RequestInit };
type Options = { handler?(call: Call): unknown; posts?: NativePost[]; promotions?: typeof promo[]; line?: Record<string, unknown>; authorType?: string; actor?: string; permissions?: string[] };
function fixture(options: Options = {}) {
  const calls: Call[] = [], posts = structuredClone(options.posts ?? [post, { ...post, id_str: P2, name: 'Second post' }]), promotions = structuredClone(options.promotions ?? []);
  const currentLine = { ...line, ...options.line };
  const client = new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init };calls.push(call);const custom = options.handler?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const route = call.url.pathname.replace(`/12/accounts/${A}`, ''), q = call.url.searchParams;
    if (init.method === 'GET') {
      if (!route) return Response.json({ data: account });
      if (route === '/promotable_users') return Response.json({ data: [{ id: 'pu1', user_id: U, promotable_user_type: options.authorType ?? 'FULL', deleted: false }], next_cursor: null });
      if (route === '/authenticated_user_access') return Response.json({ data: { user_id: options.actor ?? U, permissions: options.permissions ?? [] } });
      if (route === '/campaigns/c1') return Response.json({ data: campaign });
      if (route === '/line_items/l1') return Response.json({ data: currentLine });
      if (route === '/tweets') return Response.json({ data: q.has('tweet_ids') ? posts.filter(row => q.get('tweet_ids')!.split(',').includes(row.id_str)) : posts, next_cursor: null });
      if (route === '/media_library/' + M) return Response.json({ data: { media_key: M, media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', deleted: false, media_url: 'https://pbs.twimg.com/media/qa.jpg' } });
      if (route === '/cards/all') return Response.json({ data: [{ id: '123', card_uri: 'card://123', card_type: 'IMAGE_WEBSITE', deleted: false, components: [{ type: 'MEDIA', media_key: M }] }] });
      if (route === '/promoted_tweets') return Response.json({ data: promotions.filter(row => q.get('with_deleted') === 'true' || !row.deleted), next_cursor: null });
      if (/^\/promoted_tweets\/pt\d+$/.test(route)) { const row = promotions.find(value => value.id === route.split('/').at(-1));return row ? Response.json({ data: row }) : new Response('', { status: 404 }); }
    }
    if (route === '/tweet' && init.method === 'POST') { posts.push({ ...post, id_str: NEW, name: q.get('name'), full_text: q.get('text') ?? '', conversation_settings: q.get('conversation_settings') ?? 'EVERYONE' });return Response.json({ data: { id_str: NEW, user: { id_str: U }, text: q.get('text') } }); }
    if (route === `/tweets/${P}/name` && init.method === 'PUT') { const row = posts.find(value => value.id_str === P)!;row.name = q.get('name');return Response.json({ data: row }); }
    if (route === '/promoted_tweets' && init.method === 'POST') { const rows = q.get('tweet_ids')!.split(',').map((id, i) => ({ ...promo, id: `pt${i + 1}`, tweet_id: id }));promotions.push(...rows);return Response.json({ data: rows, total_count: rows.length }); }
    if (route === '/promoted_tweets/pt1' && init.method === 'DELETE') { const row = promotions.find(value => value.id === 'pt1')!;row.deleted = true;return Response.json({ data: row }); }
    throw new Error(`Unexpected ${init.method} ${route}`);
  });
  return { calls, posts, promotions, line: currentLine, provider: new XAdsProvider(client) };
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.init.method !== 'GET');
const op = (tool: string, payload: Record<string, unknown>): WriteOperation => ({ provider: 'x', accountId: A, tool, kind: tool.startsWith('x_create_') ? 'create' : tool.startsWith('x_delete_') ? 'remove' : 'update', payload });
const fields = { as_user_id: U, text: 'New + Unicode ✓ & <copy>', name: 'New post' };
async function publication(f: ReturnType<typeof fixture>, value = fields) { return { ...value, expected_context_hash: (await f.provider.posts.creationContext(A, value)).context_hash, confirm_publication: true }; }
async function association(f: ReturnType<typeof fixture>, ids = [P]) { const selection = { line_item_id: 'l1', user_id: U, tweet_ids: ids };return { ...selection, expected_context_hash: (await f.provider.posts.promotionContext(A, selection)).context_hash, acknowledge_active_associations: true }; }
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('native X publication and promotion contracts', () => {
  it('requires explicit publication/source hash, unique1–50 posts and ACTIVE association acknowledgement', () => {
    for (const value of [{ as_user_id: U }, { as_user_id: U, text: '' }, { ...fields, nullcast: false }, { ...fields, video_cta: 'VISIT_SITE' }, { ...fields, media_keys: [M, M] }]) expect(postFields.safeParse(value).success).toBe(false);
    expect(createPost.safeParse(fields).success).toBe(false);
    expect(createPost.safeParse({ ...fields, expected_context_hash: 'a'.repeat(64), confirm_publication: true }).success).toBe(true);
    for (const ids of [[], [P, P], Array.from({ length: 51 }, (_, i) => String(BigInt(P) + BigInt(i)))]) expect(createPromotions.safeParse({ line_item_id: 'l1', user_id: U, tweet_ids: ids, expected_context_hash: 'a'.repeat(64), acknowledge_active_associations: true }).success).toBe(false);
  });
  it('reads the exact account author/string IDs and keeps oversized native pages, scope and continuation', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/tweets') ? { data: [post, { ...post, id_str: P2 }], next_cursor: 'next' } : undefined });
    const result = await f.provider.posts.list({ account_id: A, user_id: U, count: 1, name: 'QA' });
    expect(result.items.map(row => row.id_str)).toEqual([P, P2]);expect(result.next_cursor).toBe('next');expect(creativesOutput.passthrough().parse(result).creatives[0]).toMatchObject({ descriptions: [post.full_text], status: 'PUBLISHED', type: 'PROMOTED_ONLY_POST', actions: [{ tool: 'x_rename_published_post', arguments: { tweet_id: P, user_id: U, expected_snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/) } }] });
    expect(Object.fromEntries(f.calls.find(call => call.url.pathname.endsWith('/tweets'))!.url.searchParams)).toEqual({ tweet_type: 'PUBLISHED', user_id: U, trim_user: 'true', timeline_type: 'NULLCAST', include_mentions_and_replies: 'false', count: '1', name: 'QA' });
    expect(nextPageArguments(xTools(f.provider).find(tool => tool.name === 'x_published_posts')!, { account_id: A, user_id: U, name: 'QA', count: 1 }, result)).toEqual({ account_id: A, user_id: U, name: 'QA', count: 1, cursor: 'next' });expect(writes(f)).toEqual([]);
  });
  it.each(['duplicate', 'author', 'timeline', 'cursor', 'rounded', 'draft'] as const)('rejects conflicting published inventory: %s', async mode => {
    const bad = { ...post, ...(mode === 'author' ? { user: { id_str: '123' } } : mode === 'timeline' ? { nullcast: false } : mode === 'rounded' ? { id_str: Number(P) } : mode === 'draft' ? { tweet_type: 'DRAFT' } : {}) };
    const f = fixture({ handler: call => call.url.pathname.endsWith('/tweets') ? { data: mode === 'duplicate' ? [post, post] : [bad], next_cursor: mode === 'cursor' ? 'same' : null } : undefined });
    await expect(f.provider.posts.list({ account_id: A, user_id: U, ...(mode === 'cursor' ? { cursor: 'same' } : {}) })).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
  it('does not invent completion when the native cursor is omitted, or absence from an incomplete target scan', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/tweets') ? { data: [post] } : undefined });
    expect(await f.provider.posts.list({ account_id: A, user_id: U })).toMatchObject({ truncated: true, notes: [expect.stringContaining('unconfirmed')] });
    await expect(f.provider.posts.get(A, U, P)).rejects.toThrow(/incomplete/);
  });
  it('handles targeted native continuation, and rejects missing, unrelated or repeated post rows', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/tweets') ? { data: call.url.searchParams.has('cursor') ? [] : [post], next_cursor: call.url.searchParams.has('cursor') ? null : 'next' } : undefined });
    expect((await f.provider.posts.get(A, U, P)).id_str).toBe(P);expect(f.calls.filter(call => call.url.pathname.endsWith('/tweets'))).toHaveLength(2);
    for (const rows of [[], [{ ...post, id_str: P2 }], [post, post]]) {
      const bad = fixture({ handler: call => call.url.pathname.endsWith('/tweets') ? { data: rows, next_cursor: null } : undefined });await expect(bad.provider.posts.get(A, U, P)).rejects.toThrow();
    }
  });
  it('renders only safe native media/destinations and omits unsupported author rename actions', async () => {
    const rich = { ...post, entities: { urls: [{ url: 'https://t.co/qa', expanded_url: 'https://example.com/qa' }] }, extended_entities: { media: [{ id_str: P2, type: 'video', media_url_https: 'https://pbs.twimg.com/poster.jpg', video_info: { variants: [{ url: 'https://video.twimg.com/qa.mp4', content_type: 'video/mp4', bitrate: 100 }, { url: 'https://evil.example/qa.mp4', content_type: 'video/mp4', bitrate: 1000 }] } }] } };
    const f = fixture({ posts: [rich], authorType: 'RETWEETS_ONLY' });const result = await f.provider.posts.list({ account_id: A, user_id: U });
    expect(result.creatives[0]).toMatchObject({ landing_urls: ['https://example.com/qa'], media: [{ type: 'video', url: 'https://video.twimg.com/qa.mp4', poster_url: 'https://pbs.twimg.com/poster.jpg' }], actions: [] });
  });
  it('creates only a distinct nullcast published post, with signed query fields and independent metadata readback', async () => {
    const f = fixture(), payload = await publication(f), operation = op('x_create_promoted_only_post', payload);
    const preview = await f.provider.previewWrite(operation, guard);expect(preview).toMatchObject({ serverValidated: false, review: { fields: expect.arrayContaining([{ label: 'Publication', after: 'PUBLISHED · promoted-only · no ad association' }]) } });expect(writes(f)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ applied: true, resourceIds: [NEW], details: { publication_confirmed: true, nullcast: true, ad_association_created: false, requested_text_exactly_observed: true } });
    const request = writes(f)[0]!;expect(request.url.pathname).toBe(`/12/accounts/${A}/tweet`);expect(Object.fromEntries(request.url.searchParams)).toEqual({ as_user_id: U, text: fields.text, name: fields.name, conversation_settings: 'EVERYONE', nullcast: 'true', trim_user: 'true', tweet_mode: 'extended' });expect(request.init.body).toBeUndefined();expect(request.init.headers).toMatchObject({ Authorization: expect.stringContaining('oauth_signature=') });expect(request.url.href).not.toContain('+');
    expect(f.posts.find(row => row.id_str === P)).toEqual(post);expect(f.promotions).toEqual([]);expect(writes(f)).toHaveLength(1);
  });
  it.each(['actor', 'author', 'stale', 'media', 'video'] as const)('rejects invalid publication sources before native write: %s', async mode => {
    const f = fixture({ ...(mode === 'actor' ? { actor: '123' } : mode === 'author' ? { authorType: 'RETWEETS_ONLY' } : {}), handler: call => mode === 'media' && call.url.pathname.includes('/media_library/') ? { data: { media_key: M, media_type: 'IMAGE', media_status: 'PROCESSING', deleted: false } } : undefined });
    const raw = { ...fields, ...(mode === 'media' || mode === 'video' ? { media_keys: [M] } : {}), ...(mode === 'video' ? { video_title: 'Wrong type' } : {}) };
    if (mode === 'stale') { const payload = await publication(f);await expect(f.provider.previewWrite(op('x_create_promoted_only_post', { ...payload, expected_context_hash: 'a'.repeat(64) }), guard)).rejects.toThrow(/changed/); }
    else await expect(f.provider.posts.creationContext(A, raw)).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
  it('binds media/card configuration and reports attachment/text verification limits explicitly', async () => {
    let title = 'First';const f = fixture({ handler: call => {
      if (call.url.pathname.endsWith('/cards/all')) return { data: [{ id: '123', card_uri: 'card://123', card_type: 'IMAGE_WEBSITE', deleted: false, title }] };
      if (call.url.pathname.endsWith('/tweets') && call.url.searchParams.get('tweet_ids') === NEW) return { data: [{ ...post, id_str: NEW, name: fields.name, full_text: 'Native rewritten https://t.co/qa' }], next_cursor: null };
      return undefined;
    } });
    const raw = { ...fields, media_keys: [M], card_uri: 'card://123' }, context = await f.provider.posts.creationContext(A, raw), payload = { ...raw, expected_context_hash: context.context_hash, confirm_publication: true };
    title = 'Changed';await expect(f.provider.previewWrite(op('x_create_promoted_only_post', payload), guard)).rejects.toThrow(/changed/);expect(writes(f)).toEqual([]);
    title = 'First';const result = await f.provider.applyWrite(op('x_create_promoted_only_post', payload), guard);expect(result).toMatchObject({ details: { requested_text_exactly_observed: false, attachment_readback_verified: false }, warnings: [expect.stringContaining('equivalence'), expect.stringContaining('attachment')] });
  });
  it('edits an account-owned published label without requiring post-publication composer authority', async () => {
    const f = fixture({ actor: '123', permissions: [] }), current = await f.provider.posts.get(A, U, P), operation = op('x_rename_published_post', { user_id: U, tweet_id: P, expected_snapshot_hash: current.snapshot_hash, name: 'Advertiser label' });
    await f.provider.previewWrite(operation, guard);expect(writes(f)).toEqual([]);expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [P] });expect(f.posts[0]!.name).toBe('Advertiser label');expect(f.posts[0]!.full_text).toBe(post.full_text);expect(f.calls.some(call => call.url.pathname.endsWith('/authenticated_user_access'))).toBe(false);
  });
  it.each(['malformed', 'wrong-author', 'readback', 'transport', 'partial-error'] as const)('retains publication IDs/unknown outcomes without retry: %s', async mode => {
    const f = fixture({ handler: call => {
      if (call.init.method === 'POST') {
        if (mode === 'transport') throw new Error('unknown');
        if (mode === 'malformed') return { data: { id_str: NEW } };
        if (mode === 'partial-error') return { data: { id_str: NEW }, errors: [{ message: 'private native echo never displayed' }] };
        if (mode === 'wrong-author') return { data: { id_str: NEW, user: { id_str: '123' } } };
      }
      if (mode === 'readback' && call.url.pathname.endsWith('/tweets') && call.url.searchParams.get('tweet_ids') === NEW) return new Response('', { status: 403 });
      return undefined;
    } });
    const payload = await publication(f);await expect(f.provider.applyWrite(op('x_create_promoted_only_post', payload), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: mode === 'transport' ? [] : [NEW] } });expect(writes(f)).toHaveLength(1);
  });
  it('renames with snapshot/preservation checks and uses only native name PUT, not post copy replacement', async () => {
    const f = fixture(), current = await f.provider.posts.get(A, U, P), operation = op('x_rename_published_post', { user_id: U, tweet_id: P, expected_snapshot_hash: current.snapshot_hash, name: 'Renamed' });
    await f.provider.previewWrite(operation, guard);expect(writes(f)).toEqual([]);expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [P] });expect(f.posts[0]).toEqual({ ...post, name: 'Renamed' });expect(writes(f)[0]!.url.pathname).toBe(`/12/accounts/${A}/tweets/${P}/name`);expect(Object.fromEntries(writes(f)[0]!.url.searchParams)).toEqual({ name: 'Renamed' });
    await expect(f.provider.previewWrite(operation, guard)).rejects.toThrow(/changed/);expect(writes(f)).toHaveLength(1);
  });
  it('rejects a native rename which changed published content, preserving known IDs', async () => {
    const f = fixture({ handler: call => call.init.method === 'PUT' ? { data: { ...post, name: 'Renamed', full_text: 'Unexpected copy change' } } : undefined });
    const current = await f.provider.posts.get(A, U, P);await expect(f.provider.applyWrite(op('x_rename_published_post', { user_id: U, tweet_id: P, expected_snapshot_hash: current.snapshot_hash, name: 'Renamed' }), guard)).rejects.toMatchObject({ details: { resource_ids: [P] } });expect(writes(f)).toHaveLength(1);
  });
  it('creates up to50 ACTIVE native associations under a paused ad group, verifies all IDs and unchanged parents', async () => {
    const f = fixture(), operation = op('x_create_promoted_posts', await association(f, [P, P2]));const preview = await f.provider.previewWrite(operation, guard);
    expect(preview).toMatchObject({ review: { fields: expect.arrayContaining([{ label: 'Native association status', after: 'ACTIVE' }, { label: 'Ad-group status', after: 'PAUSED' }]) }, budgetDeltas: expect.arrayContaining([{ target: 'l1 daily_budget_amount_local_micro existing pool', currency: 'USD', fromMicros: 5_000_000, toMicros: 5_000_000 }]) });expect(writes(f)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: ['pt1', 'pt2'] });const request = writes(f)[0]!;expect(request.init.method).toBe('POST');expect(request.init.body).toBeUndefined();expect(Object.fromEntries(request.url.searchParams)).toEqual({ line_item_id: 'l1', tweet_ids: `${P},${P2}` });expect(request.url.searchParams.has('entity_status')).toBe(false);expect(f.line.entity_status).toBe('PAUSED');expect(writes(f)).toHaveLength(1);
  });
  it('enforces paused creation for ACTIVE groups even under PAUSED campaigns; explicit non-paused policy permits native ACTIVE associations', async () => {
    const f = fixture({ line: { entity_status: 'ACTIVE' } }), operation = op('x_create_promoted_posts', await association(f));
    await expect(f.provider.previewWrite(operation, guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(writes(f)).toEqual([]);await f.provider.previewWrite(operation, { forcePausedCreation: false });expect(writes(f)).toEqual([]);
  });
  it.each(['draft', 'deleted', 'product', 'retweet', 'duplicate', 'stale'] as const)('refuses unsafe or duplicate association preflight: %s', async mode => {
    const f = fixture({ ...(mode === 'retweet' ? { authorType: 'RETWEETS_ONLY' } : {}), line: mode === 'draft' ? { entity_status: 'DRAFT' } : mode === 'deleted' ? { deleted: true } : mode === 'product' ? { product_type: 'MEDIA' } : {}, promotions: mode === 'duplicate' ? [promo] : [] });
    if (['draft', 'deleted', 'product', 'retweet'].includes(mode)) await expect(association(f)).rejects.toThrow();
    else { const payload = await association(f);await expect(f.provider.previewWrite(op('x_create_promoted_posts', { ...payload, ...(mode === 'stale' ? { expected_context_hash: 'a'.repeat(64) } : {}) }), guard)).rejects.toThrow(); }expect(writes(f)).toEqual([]);
  });
  it.each(['missing-cursor', 'repeated-cursor', 'duplicate', 'foreign', 'deleted'] as const)('requires complete scoped promotion inventory: %s', async mode => {
    const f = fixture({ handler: call => call.init.method === 'GET' && call.url.pathname.endsWith('/promoted_tweets') ? { data: mode === 'duplicate' ? [promo, promo] : mode === 'foreign' ? [{ ...promo, line_item_id: 'foreign' }] : mode === 'deleted' ? [{ ...promo, deleted: true }] : [], ...(mode === 'missing-cursor' ? {} : { next_cursor: mode === 'repeated-cursor' ? 'repeat' : null }) } : undefined });
    await expect(association(f)).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
  it.each(['partial', 'duplicate-id', 'foreign', 'state', 'copy', 'readback', 'parent', 'envelope'] as const)('retains all acknowledged association IDs without replay: %s', async mode => {
    const f = fixture({ handler: call => {
      if (call.init.method === 'POST') {
        if (mode === 'partial') return { data: [promo] };
        if (mode === 'duplicate-id') return { data: [promo, { ...promo, tweet_id: P2 }] };
        if (mode === 'foreign') return { data: [{ ...promo, line_item_id: 'foreign' }, { ...promo, id: 'pt2', tweet_id: P2 }] };
        if (mode === 'state') return { data: [{ ...promo, entity_status: 'PAUSED' }, { ...promo, id: 'pt2', tweet_id: P2 }] };
        if (mode === 'copy') return { data: [{ ...promo, tweet_id: NEW }, { ...promo, id: 'pt2', tweet_id: P2 }] };
        if (mode === 'envelope') return { data: [promo], errors: [{ message: 'Partial failure' }] };
      }
      if (mode === 'readback' && call.url.pathname.endsWith('/promoted_tweets/pt1')) return new Response('', { status: 403 });
      if (mode === 'parent' && call.url.pathname.endsWith('/line_items/l1') && f.promotions.length) return { data: { ...line, entity_status: 'ACTIVE' } };
      return undefined;
    } });
    const payload = await association(f, [P, P2]);await expect(f.provider.applyWrite(op('x_create_promoted_posts', payload), guard)).rejects.toMatchObject({ details: { resource_ids: ['partial', 'duplicate-id', 'envelope'].includes(mode) ? ['pt1'] : ['pt1', 'pt2'] } });expect(writes(f)).toHaveLength(1);
  });
  it('views association copy/media and binds native DELETE to the association ID/hash, keeping the published post', async () => {
    const f = fixture({ promotions: [promo] }), gallery = await f.provider.posts.promotions({ account_id: A, line_item_id: 'l1', user_id: U });
    const creative = creativesOutput.passthrough().parse(gallery).creatives[0]!;expect(creative).toMatchObject({ id: 'pt1', descriptions: [post.full_text], status: 'ACTIVE', actions: [{ label: 'Remove from ad group', tool: 'x_delete_promoted_post', arguments: { promoted_tweet_id: 'pt1' }, fields: [] }] });
    const action = creative.actions![0]!, { account_id: _account, ...payload } = action.arguments;
    const operation = op(action.tool, payload);await f.provider.previewWrite(operation, guard);expect(writes(f)).toEqual([]);expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: ['pt1'] });
    expect(writes(f)[0]!.init.method).toBe('DELETE');expect(writes(f)[0]!.url.pathname).toBe(`/12/accounts/${A}/promoted_tweets/pt1`);expect(f.promotions[0]).toMatchObject({ entity_status: 'ACTIVE', deleted: true });expect(f.posts[0]).toEqual(post);
    expect((await f.provider.posts.promotions({ account_id: A, line_item_id: 'l1', with_deleted: true })).creatives[0]).toMatchObject({ status: 'DISASSOCIATED', actions: [] });await expect(f.provider.previewWrite(operation, guard)).rejects.toThrow(/changed|deleted/);
  });
  it.each(['foreign', 'wrong-id', 'not-deleted', 'readback'] as const)('refuses unconfirmed disassociation: %s', async mode => {
    let removed = false;const f = fixture({ promotions: [promo], handler: call => {
      if (call.init.method === 'DELETE') { removed = true;return { data: { ...promo, deleted: mode !== 'not-deleted', ...(mode === 'foreign' ? { line_item_id: 'other' } : mode === 'wrong-id' ? { id: 'wrong' } : {}) } }; }
      if (mode === 'readback' && removed && call.url.pathname.endsWith('/promoted_tweets/pt1')) return new Response('', { status: 403 });return undefined;
    } });
    const current = await f.provider.posts.getPromotion(A, 'pt1');await expect(f.provider.applyWrite(op('x_delete_promoted_post', { promoted_tweet_id: 'pt1', expected_context_hash: current.context_hash }), guard)).rejects.toMatchObject({ details: { resource_ids: mode === 'wrong-id' ? ['pt1', 'wrong'] : ['pt1'] } });expect(writes(f)).toHaveLength(1);
  });
});

describe('shared X post policy gate', () => {
  it('keeps all four write paths behind previews, identical arguments, protected accounts, caps and consume-once auditing', async () => {
    const f = fixture(), dir = await mkdtemp(path.join(tmpdir(), 'adport-x-posts-'));dirs.push(dir);
    const policy = { ...DEFAULT_POLICY, max_daily_budget_micros: 20_000_000 }, pending = new PendingStore(path.join(dir, 'pending')), audit = new AuditLog(path.join(dir, 'audit'));
    const modules = [{ provider: f.provider, tools: xTools(f.provider) }], runtime = await createContext({ engine: new PolicyEngine(policy, pending, audit), providerModules: modules });
    const call = (name: string, input: unknown) => runtime.registry.call(name, input, runtime.ctx), input = { account_id: A, ...await publication(f) };
    const preview = await call('x_create_promoted_only_post', input) as { pending_operation_id: string };expect(writes(f)).toEqual([]);
    await expect(call('x_create_promoted_only_post', { ...input, text: 'Changed', pending_operation_id: preview.pending_operation_id })).rejects.toThrow(/match|differ/i);expect(writes(f)).toEqual([]);
    await call('x_create_promoted_only_post', { ...input, pending_operation_id: preview.pending_operation_id });expect(writes(f)).toHaveLength(1);
    await expect(call('x_create_promoted_only_post', { ...input, pending_operation_id: preview.pending_operation_id })).rejects.toThrow();expect(writes(f)).toHaveLength(1);
    const exactApply = async (name: string, input: Record<string, unknown>) => { const before = writes(f).length, preview = await call(name, input) as { pending_operation_id: string };expect(writes(f)).toHaveLength(before);await call(name, { ...input, pending_operation_id: preview.pending_operation_id });expect(writes(f)).toHaveLength(before + 1); };
    await exactApply('x_rename_published_post', { account_id: A, user_id: U, tweet_id: P, expected_snapshot_hash: (await f.provider.posts.get(A, U, P)).snapshot_hash, name: 'Gated name' });
    await exactApply('x_create_promoted_posts', { account_id: A, ...await association(f) });
    await exactApply('x_delete_promoted_post', { account_id: A, promoted_tweet_id: 'pt1', expected_context_hash: (await f.provider.posts.getPromotion(A, 'pt1')).context_hash });
    for (const current of xTools(f.provider).filter(value => ['x_create_promoted_only_post', 'x_rename_published_post', 'x_create_promoted_posts', 'x_delete_promoted_post'].includes(value.name))) expect(current.annotations?.readOnly).toBe(false);
    const capped = await createContext({ engine: new PolicyEngine({ ...policy, max_daily_budget_micros: 1_000_000 }, pending, audit), providerModules: modules });
    await expect(capped.registry.call('x_create_promoted_posts', { account_id: A, ...await association(f) }, capped.ctx)).rejects.toThrow(/cap|maximum|budget/i);expect(writes(f)).toHaveLength(4);
    const protectedRuntime = await createContext({ engine: new PolicyEngine({ ...policy, protected_accounts: [A] }, pending, audit), providerModules: modules });
    await expect(protectedRuntime.registry.call('x_create_promoted_only_post', input, protectedRuntime.ctx)).rejects.toThrow(/protected/i);expect(writes(f)).toHaveLength(4);
  });
});
