import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, creativesOutput, DEFAULT_POLICY, nextPageArguments, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';
import { createScheduled, scheduledFields, updateScheduled, type ScheduledPost, type ScheduledPromotion } from '../src/scheduled-schemas.js';

// Official docs creatives a9226e10 / campaign-management570f918c and Python SDK
// a3dd5819, checked2026-11-06. Scheduled POST returns an object (not an array),
// source DELETE is hard404; association DELETE is a readable deleted:true tombstone.
const A = 'a1', U = '756201191646691328', S = '917438609065623552', N = '917438609065623553', M = '3_917438348871983104', AT = '2026-11-08T12:34:00Z';
const post: ScheduledPost = { id: S, user_id: U, name: 'QA schedule', text: '<Exact> + Unicode ✓', scheduled_status: 'SCHEDULED', nullcast: true, scheduled_at: AT, card_uri: null, media_keys: [], tweet_id: null, completed_at: null };
const association: ScheduledPromotion = { id: 'sp1', line_item_id: 'l1', scheduled_tweet_id: S, tweet_id: null, deleted: false };
const campaign = { id: 'c1', name: 'QA campaign', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null };
const line = { id: 'l1', name: 'QA ad group', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'ENGAGEMENTS', daily_budget_amount_local_micro: 5_000_000, total_budget_amount_local_micro: null };
type Call = { url: URL; init: RequestInit };
type Options = { handler?(call: Call): unknown; posts?: ScheduledPost[]; associations?: ScheduledPromotion[]; authorType?: string; actor?: string; line?: Record<string, unknown> };
function fixture(options: Options = {}) {
  const calls: Call[] = [], posts = structuredClone(options.posts ?? [post]), associations = structuredClone(options.associations ?? []), currentLine = { ...line, ...options.line };
  const provider = new XAdsProvider(new XAdsClient({ consumerKey: 'inert', consumerSecret: 'inert', accessToken: 'inert', accessTokenSecret: 'inert' }, async (raw, init = {}) => {
    const call = { url: new URL(String(raw)), init };calls.push(call);const custom = options.handler?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const path = call.url.pathname.replace(`/12/accounts/${A}`, ''), q = call.url.searchParams, ok = (data: unknown) => Response.json({ data });
    if (init.method === 'GET') {
      if (!path) return ok({ id: A, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false });
      if (path === '/promotable_users') return Response.json({ data: [{ id: 'u1', user_id: U, promotable_user_type: options.authorType ?? 'FULL', deleted: false }], next_cursor: null });
      if (path === '/authenticated_user_access') return ok({ user_id: options.actor ?? U, permissions: [] });
      if (path === '/campaigns/c1') return ok(campaign);
      if (path === '/line_items/l1') return ok(currentLine);
      if (path === '/media_library/' + M) return ok({ media_key: M, media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', deleted: false, media_url: 'https://pbs.twimg.com/qa.jpg' });
      if (path === '/cards/all') return ok([{ id: '123', card_uri: 'card://123', card_type: 'IMAGE_WEBSITE', deleted: false }]);
      if (path === '/scheduled_tweets') return Response.json({ data: posts, next_cursor: null });
      if (path.startsWith('/scheduled_tweets/')) { const row = posts.find(row => row.id === path.split('/').at(-1));return row ? ok(row) : new Response('', { status: 404 }); }
      if (path === '/scheduled_promoted_tweets') return Response.json({ data: associations.filter(row => q.get('with_deleted') === 'true' || !row.deleted), next_cursor: null });
      if (path === '/scheduled_promoted_tweets/sp1') return ok(associations.find(row => row.id === 'sp1'));
    }
    if (path === '/scheduled_tweets' && init.method === 'POST') { const row = { ...post, id: N, user_id: q.get('as_user_id')!, text: q.get('text') ?? '', name: q.get('name'), scheduled_at: q.get('scheduled_at')!, card_uri: q.get('card_uri'), media_keys: q.get('media_keys')?.split(',') ?? [] };posts.push(row);return ok(row); }
    if (path.startsWith('/scheduled_tweets/') && init.method === 'PUT') { const row = posts.find(row => row.id === path.split('/').at(-1))!;for (const [key, value] of q) { if (key === 'media_keys') row.media_keys = value ? value.split(',') : [];else if (key === 'card_uri') row.card_uri = value || null;else Object.assign(row, { [key]: value }); }return ok(row); }
    if (path.startsWith('/scheduled_tweets/') && init.method === 'DELETE') { const index = posts.findIndex(row => row.id === path.split('/').at(-1)), [row] = posts.splice(index, 1);return ok({ ...row, scheduled_status: 'DELETED' }); }
    if (path === '/scheduled_promoted_tweets' && init.method === 'POST') { const row = { ...association, scheduled_tweet_id: q.get('scheduled_tweet_id')!, line_item_id: q.get('line_item_id')! };associations.push(row);return ok(row); }
    if (path === '/scheduled_promoted_tweets/sp1' && init.method === 'DELETE') { associations[0]!.deleted = true;return ok(associations[0]); }
    throw new Error(`Unexpected ${init.method} ${path}`);
  }));
  return { provider, calls, posts, associations, line: currentLine };
}
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.init.method !== 'GET');
const guard = { forcePausedCreation: true }, fields = { as_user_id: U, scheduled_at: AT, text: 'New & + ✓', name: 'New schedule' };
const op = (tool: string, payload: Record<string, unknown>): WriteOperation => ({ provider: 'x', accountId: A, tool, kind: tool.startsWith('x_create_') ? 'create' : tool.startsWith('x_delete_') ? 'remove' : 'update', payload });
async function creation(f: ReturnType<typeof fixture>, input = fields) { return { ...input, expected_context_hash: (await f.provider.scheduled.creationContext(A, input)).context_hash, acknowledge_automatic_publication: true }; }
async function edit(f: ReturnType<typeof fixture>, changed: Record<string, unknown>) { return { user_id: U, scheduled_tweet_id: S, expected_snapshot_hash: (await f.provider.scheduled.get(A, U, S)).snapshot_hash, acknowledge_automatic_publication: true, ...changed }; }
async function promotion(f: ReturnType<typeof fixture>) { const input = { user_id: U, line_item_id: 'l1', scheduled_tweet_id: S };return { ...input, expected_context_hash: (await f.provider.scheduled.promotionContext(A, input)).context_hash, acknowledge_automatic_promotion: true }; }
const dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] });vi.setSystemTime(new Date('2026-11-06T10:00:00Z')); });
afterEach(async () => { vi.useRealTimers();await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('X scheduled-post native lifecycle', () => {
  it.each([{ ...fields, nullcast: false }, { ...fields, scheduled_at: '2026-11-08T12:34:01Z' }, { ...fields, scheduled_at: '2026-11-08T12:34:00.000Z' }, { ...fields, media_keys: [M, M] }, { as_user_id: U, scheduled_at: AT }])('rejects unsupported/unapproved schedule fields %j', value => { expect(scheduledFields.safeParse(value).success).toBe(false); });
  it('requires explicit automatic publication and current context', () => { expect(createScheduled.safeParse(fields).success).toBe(false);expect(updateScheduled.safeParse({ user_id: U, scheduled_tweet_id: S, expected_snapshot_hash: 'a'.repeat(64), acknowledge_automatic_publication: true }).success).toBe(false); });
  it.each(['2026-11-06T10:14:00Z', '2027-11-06T10:01:00Z', '2026-11-05T10:00:00Z'])('rejects time outside bounded scheduling window: %s', async scheduled_at => { const f = fixture();await expect(f.provider.scheduled.creationContext(A, { ...fields, scheduled_at })).rejects.toThrow(/15minutes|year/);expect(mutations(f)).toEqual([]); });
  it('retains exact IDs/copy, native paging and a safe account-library preview', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/scheduled_tweets') ? { data: [{ ...post, media_keys: [M] }, { ...post, id: N }], next_cursor: 'next' } : undefined }), result = await f.provider.scheduled.list({ account_id: A, user_id: U, count: 1 });
    expect(result.items.map(row => row.id)).toEqual([S, N]);expect(creativesOutput.passthrough().parse(result).creatives[0]).toMatchObject({ descriptions: [post.text, `Scheduled: ${AT}`], media: [{ type: 'image', url: 'https://pbs.twimg.com/qa.jpg' }] });
    const request = f.calls.find(call => call.url.pathname.endsWith('/scheduled_tweets'))!;expect(Object.fromEntries(request.url.searchParams)).toEqual({ user_id: U, count: '1' });expect(nextPageArguments(xTools(f.provider).find(tool => tool.name === 'x_scheduled_posts')!, { account_id: A, user_id: U, count: 1 }, result)).toMatchObject({ cursor: 'next', user_id: U, count: 1 });expect(mutations(f)).toEqual([]);
  });
  it.each(['author', 'account', 'rounded', 'duplicate', 'cursor'] as const)('rejects conflicting schedule inventory: %s', async mode => {
    const row = { ...post, ...(mode === 'author' ? { user_id: '123' } : mode === 'account' ? { account_id: 'foreign' } : mode === 'rounded' ? { id: Number(S) } : {}) }, f = fixture({ handler: call => call.url.pathname.endsWith('/scheduled_tweets') ? { data: mode === 'duplicate' ? [row, row] : [row], next_cursor: mode === 'cursor' ? 'same' : null } : undefined });
    await expect(f.provider.scheduled.list({ account_id: A, user_id: U, cursor: 'same' })).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it('preserves missing-cursor uncertainty and bounds preview fan-out', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `3_${BigInt(S) + BigInt(i)}`), f = fixture({ handler: call => call.url.pathname.endsWith('/scheduled_tweets') ? { data: keys.map((key, i) => ({ ...post, id: String(BigInt(S) + BigInt(i)), media_keys: [key] })) } : call.url.pathname.includes('/media_library/') ? { data: { media_key: call.url.pathname.split('/').at(-1), media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', deleted: false, media_url: 'https://evil.example/leak.jpg' } } : undefined });
    const result = await f.provider.scheduled.list({ account_id: A, user_id: U });expect(result.truncated).toBe(true);expect(result.notes.join(' ')).toMatch(/unconfirmed.*40unique/);expect(f.calls.filter(call => call.url.pathname.includes('/media_library/'))).toHaveLength(40);expect(result.creatives.every(row => row.media.length === 0)).toBe(true);
    f.calls.length = 0;await f.provider.scheduled.list({ account_id: A, user_id: U, include_media: false });expect(f.calls.some(call => call.url.pathname.includes('/media_library/'))).toBe(false);
  });
  it('uses signed query POST with explicit nullcast and verifies complete scheduled state independently', async () => {
    const f = fixture(), payload = await creation(f), operation = op('x_create_scheduled_post', payload);expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ serverValidated: false, review: { title: 'Schedule promoted-only post' } });expect(mutations(f)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ applied: true, resourceIds: [N], details: { scheduled_status: 'SCHEDULED', published_tweet_id: null, ad_association_created: false } });
    const request = mutations(f)[0]!;expect(request.url.pathname).toBe(`/12/accounts/${A}/scheduled_tweets`);expect(Object.fromEntries(request.url.searchParams)).toEqual({ ...fields, nullcast: 'true' });expect(request.init.body).toBeUndefined();expect(request.init.headers).toMatchObject({ Authorization: expect.stringContaining('oauth_signature=') });expect(request.url.href).not.toContain('+');expect(f.associations).toEqual([]);expect(mutations(f)).toHaveLength(1);
  });
  it.each(['retweet', 'actor', 'stale', 'media'] as const)('rejects stale/unavailable authoring sources: %s', async mode => {
    const f = fixture({ authorType: mode === 'retweet' ? 'RETWEETS_ONLY' : 'FULL', actor: mode === 'actor' ? '123' : U, handler: call => mode === 'media' && call.url.pathname.includes('/media_library/') ? { data: { media_key: M, media_type: 'VIDEO', media_status: 'PROCESSING', deleted: false } } : undefined });
    if (mode === 'stale') await expect(f.provider.previewWrite(op('x_create_scheduled_post', { ...await creation(f), expected_context_hash: 'a'.repeat(64) }), guard)).rejects.toThrow(/changed/);
    else await expect(f.provider.scheduled.creationContext(A, { ...fields, ...(mode === 'media' ? { media_keys: [M] } : {}) })).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it.each(['parse', 'envelope', 'account', 'author', 'organic', 'time', 'copy', 'readback'] as const)('retains receipt IDs without replay on unconfirmed scheduling: %s', async mode => {
    const f = fixture({ handler: call => {
      if (call.init.method === 'POST') { if (mode === 'parse') return { data: { id: N } };if (mode === 'envelope') return { data: { id: N }, errors: ['secret body must not escape'] };if (mode !== 'readback') return { data: { ...post, id: N, text: fields.text, name: fields.name, ...(mode === 'account' ? { account_id: 'foreign' } : mode === 'author' ? { user_id: '123' } : mode === 'organic' ? { nullcast: false } : mode === 'time' ? { scheduled_at: '2026-11-09T12:34:00Z' } : { text: 'rewritten' }) } }; }
      if (mode === 'readback' && call.url.pathname.endsWith('/scheduled_tweets/' + N)) return new Response('', { status: 403 });return undefined;
    } });await expect(f.provider.applyWrite(op('x_create_scheduled_post', await creation(f)), guard)).rejects.toMatchObject({ details: { resource_ids: [N] } });expect(mutations(f)).toHaveLength(1);
  });
  it('updates only supplied fields, encoding attachment clears as empty query parameters', async () => {
    const f = fixture({ posts: [{ ...post, media_keys: [M], card_uri: 'card://123' }] }), payload = await edit(f, { text: 'Edited & + ✓', media_keys: [], card_uri: null }), operation = op('x_update_scheduled_post', payload);
    await f.provider.previewWrite(operation, guard);expect(mutations(f)).toEqual([]);expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [S] });expect(Object.fromEntries(mutations(f)[0]!.url.searchParams)).toEqual({ text: 'Edited & + ✓', media_keys: '', card_uri: '' });expect(f.posts[0]).toMatchObject({ name: post.name, scheduled_at: AT, nullcast: true, text: 'Edited & + ✓', media_keys: [], card_uri: null });
  });
  it('binds scheduled configuration and associations while ignoring irrelevant timestamps', async () => {
    let updated = 'first';const f = fixture({ handler: call => call.url.pathname.endsWith('/scheduled_tweets/' + S) ? { data: { ...f.posts[0], updated_at: updated } } : undefined }), payload = await edit(f, { name: 'Edit' });updated = 'second';await f.provider.previewWrite(op('x_update_scheduled_post', payload), guard);
    f.associations.push(association);await expect(f.provider.previewWrite(op('x_update_scheduled_post', payload), guard)).rejects.toThrow(/snapshot changed/);const shared = await edit(f, { name: 'Edit' });await expect(f.provider.previewWrite(op('x_update_scheduled_post', shared), guard)).rejects.toThrow(/shared_effects/);await f.provider.previewWrite(op('x_update_scheduled_post', { ...shared, acknowledge_shared_effects: true }), guard);expect(mutations(f)).toEqual([]);
  });
  it.each(['published', 'organic', 'past', 'completed', 'empty', 'unchanged'] as const)('rejects invalid scheduled edits: %s', async mode => {
    const f = fixture({ posts: [{ ...post, ...(mode === 'published' ? { scheduled_status: 'SUCCESS', tweet_id: N } : mode === 'organic' ? { nullcast: false } : mode === 'past' ? { scheduled_at: '2026-11-05T00:00:00Z' } : mode === 'completed' ? { completed_at: '2026-11-05T00:00:00Z' } : {}) }] }), payload = await edit(f, mode === 'empty' ? { text: '', media_keys: [] } : mode === 'unchanged' ? { text: post.text } : { name: 'Edit' });await expect(f.provider.previewWrite(op('x_update_scheduled_post', payload), guard)).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it('hard-deletes only unassociated future schedules and confirms exact native404', async () => {
    const f = fixture(), input = { user_id: U, scheduled_tweet_id: S, expected_snapshot_hash: (await f.provider.scheduled.get(A, U, S)).snapshot_hash, acknowledge_permanent_deletion: true }, operation = op('x_delete_scheduled_post', input);await f.provider.previewWrite(operation, guard);expect(mutations(f)).toEqual([]);expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [S] });expect(f.posts).toEqual([]);expect(mutations(f)[0]!.init.method).toBe('DELETE');
    const shared = fixture({ associations: [association] });await expect(shared.provider.previewWrite(op('x_delete_scheduled_post', { ...input, expected_snapshot_hash: (await shared.provider.scheduled.get(A, U, S)).snapshot_hash }), guard)).rejects.toThrow(/associations/);expect(mutations(shared)).toEqual([]);
  });
  it.each(['exists', 'denied', 'invalid404', 'receipt'] as const)('does not confuse deletion with an unconfirmed result: %s', async mode => {
    let deleted = false;const f = fixture({ handler: call => { if (call.init.method === 'DELETE') { deleted = true;return { data: { ...post, scheduled_status: mode === 'receipt' ? 'SCHEDULED' : 'DELETED' } }; }if (deleted && call.url.pathname.endsWith('/scheduled_tweets/' + S)) return mode === 'exists' ? { data: post } : mode === 'denied' ? new Response('', { status: 403 }) : new Response('{}', { status: 200 });return undefined; } }), payload = { user_id: U, scheduled_tweet_id: S, expected_snapshot_hash: (await f.provider.scheduled.get(A, U, S)).snapshot_hash, acknowledge_permanent_deletion: true };await expect(f.provider.applyWrite(op('x_delete_scheduled_post', payload), guard)).rejects.toMatchObject({ details: { resource_ids: [S] } });expect(mutations(f)).toHaveLength(1);
  });
});

describe('X scheduled ad associations and shared policy', () => {
  it('creates one object association with native singular scheduled_tweet_id and preserves parent budgets/status', async () => {
    const f = fixture(), operation = op('x_create_scheduled_promoted_post', await promotion(f)), preview = await f.provider.previewWrite(operation, guard);expect(preview.budgetDeltas).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'USD', fromMicros: 5_000_000, toMicros: 5_000_000 })]));expect(mutations(f)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: ['sp1'] });expect(Object.fromEntries(mutations(f)[0]!.url.searchParams)).toEqual({ line_item_id: 'l1', scheduled_tweet_id: S });expect(f.line).toEqual(line);expect(f.posts[0]).toEqual(post);expect(mutations(f)).toHaveLength(1);
  });
  it('requires a paused ad group under paused_creation even if campaign is paused', async () => { const f = fixture({ line: { entity_status: 'ACTIVE' } }), operation = op('x_create_scheduled_promoted_post', await promotion(f));await expect(f.provider.previewWrite(operation, guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });await f.provider.previewWrite(operation, { forcePausedCreation: false });expect(mutations(f)).toEqual([]); });
  it.each(['draft', 'deleted', 'product', 'retweet', 'duplicate', 'stale'] as const)('rejects unsafe association preflight: %s', async mode => {
    const f = fixture({ authorType: mode === 'retweet' ? 'RETWEETS_ONLY' : 'FULL', line: mode === 'draft' ? { entity_status: 'DRAFT' } : mode === 'deleted' ? { deleted: true } : mode === 'product' ? { product_type: 'MEDIA' } : {}, associations: mode === 'duplicate' ? [association] : [] });
    if (['draft', 'deleted', 'product', 'retweet'].includes(mode)) await expect(promotion(f)).rejects.toThrow();else await expect(f.provider.previewWrite(op('x_create_scheduled_promoted_post', { ...await promotion(f), ...(mode === 'stale' ? { expected_context_hash: 'a'.repeat(64) } : {}) }), guard)).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it.each(['missing', 'cursor', 'duplicate', 'foreign', 'deleted'] as const)('requires complete correctly scoped association inventory: %s', async mode => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/scheduled_promoted_tweets') ? { data: mode === 'duplicate' ? [association, association] : mode === 'foreign' ? [{ ...association, account_id: 'foreign' }] : mode === 'deleted' ? [{ ...association, deleted: true }] : [], ...(mode === 'missing' ? {} : { next_cursor: mode === 'cursor' ? 'repeat' : null }) } : undefined });await expect(promotion(f)).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it.each(['parse', 'array', 'foreign', 'copy', 'published', 'deleted', 'readback', 'parent'] as const)('retains acknowledged IDs on association failures: %s', async mode => {
    const f = fixture({ handler: call => { if (call.init.method === 'POST') { if (mode === 'parse') return { data: { id: 'sp1' } };if (mode === 'array') return { data: [association] };if (!['readback', 'parent'].includes(mode)) return { data: { ...association, ...(mode === 'foreign' ? { line_item_id: 'foreign' } : mode === 'copy' ? { scheduled_tweet_id: N } : mode === 'published' ? { tweet_id: N } : { deleted: true }) } }; }if (mode === 'readback' && call.url.pathname.endsWith('/scheduled_promoted_tweets/sp1')) return new Response('', { status: 403 });if (mode === 'parent' && f.associations.length && call.url.pathname.endsWith('/line_items/l1')) return { data: { ...line, entity_status: 'ACTIVE' } };return undefined; } });await expect(f.provider.applyWrite(op('x_create_scheduled_promoted_post', await promotion(f)), guard)).rejects.toMatchObject({ details: { resource_ids: ['sp1'] } });expect(mutations(f)).toHaveLength(1);
  });
  it('disassociates before publication without deleting the still-scheduled post', async () => { const f = fixture({ associations: [association] }), current = await f.provider.scheduled.getPromotion(A, 'sp1'), operation = op('x_delete_scheduled_promoted_post', { scheduled_promoted_tweet_id: 'sp1', expected_context_hash: current.context_hash });expect(current.source).toMatchObject({ scheduled_at: AT });await f.provider.previewWrite(operation, guard);expect(mutations(f)).toEqual([]);expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: ['sp1'] });expect(f.posts[0]).toEqual(post);expect(f.associations[0]!.deleted).toBe(true); });
  it('binds source/parents and rejects cancellation after source publication', async () => { const f = fixture({ associations: [association] }), current = await f.provider.scheduled.getPromotion(A, 'sp1'), operation = op('x_delete_scheduled_promoted_post', { scheduled_promoted_tweet_id: 'sp1', expected_context_hash: current.context_hash });f.posts[0]!.scheduled_at = '2026-11-09T12:34:00Z';await expect(f.provider.previewWrite(operation, guard)).rejects.toThrow(/changed/);f.posts[0]!.scheduled_status = 'SUCCESS';f.posts[0]!.tweet_id = N;await expect(f.provider.previewWrite(op('x_delete_scheduled_promoted_post', { ...operation.payload, expected_context_hash: (await f.provider.scheduled.getPromotion(A, 'sp1')).context_hash }), guard)).rejects.toThrow(/still-future/);expect(mutations(f)).toEqual([]); });
  it('retains native association continuation and rejects a foreign line filter', async () => { const f = fixture({ handler: call => call.url.pathname.endsWith('/scheduled_promoted_tweets') ? { data: [association], next_cursor: 'next' } : undefined });expect(await f.provider.scheduled.promotions({ account_id: A, line_item_id: 'l1', count: 1 })).toMatchObject({ items: [association], next_cursor: 'next', truncated: true });expect(Object.fromEntries(f.calls.find(call => call.url.pathname.endsWith('/scheduled_promoted_tweets'))!.url.searchParams)).toEqual({ count: '1', with_deleted: 'false', line_item_ids: 'l1' });const bad = fixture({ associations: [{ ...association, line_item_id: 'other' }] });await expect(bad.provider.scheduled.promotions({ account_id: A, line_item_id: 'l1' })).rejects.toThrow(/parent/); });
  it('uses exact shared preview/apply/audit with mismatch, replay, protected-account and cap rejection', async () => {
    const f = fixture(), dir = await mkdtemp(join(tmpdir(), 'adport-x-scheduled-'));dirs.push(dir);const pending = new PendingStore(join(dir, 'pending')), audit = new AuditLog(join(dir, 'audit')), modules = [{ provider: f.provider, tools: xTools(f.provider) }], runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, pending, audit), providerModules: modules }), input = { account_id: A, ...await creation(f) };
    const preview: any = await runtime.registry.call('x_create_scheduled_post', input, runtime.ctx);expect(preview.applied).toBe(false);expect(mutations(f)).toEqual([]);
    await expect(runtime.registry.call('x_create_scheduled_post', { ...input, text: 'Different', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(mutations(f)).toEqual([]);
    expect(await runtime.registry.call('x_create_scheduled_post', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toMatchObject({ applied: true });await expect(runtime.registry.call('x_create_scheduled_post', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(mutations(f)).toHaveLength(1);
    const protectedRuntime = await createContext({ engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, pending, audit), providerModules: modules });await expect(protectedRuntime.registry.call('x_create_scheduled_post', input, protectedRuntime.ctx)).rejects.toThrow(/protected/i);
    const capped = await createContext({ engine: new PolicyEngine({ ...DEFAULT_POLICY, max_daily_budget_micros: 1 }, pending, audit), providerModules: modules });await expect(capped.registry.call('x_create_scheduled_promoted_post', { account_id: A, ...await promotion(f) }, capped.ctx)).rejects.toThrow(/budget|maximum|cap/i);expect(mutations(f)).toHaveLength(1);
  });
});
