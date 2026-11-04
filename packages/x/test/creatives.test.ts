import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, creativesOutput, type WriteOperation } from '@adport/core';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';

// Shapes/verbs/CSV/query-only writes follow xdevplatform/docs2f701ee v12,
// creatives + authenticated_user_access, fetched2026-11-03. No SDK is executed.
const A = 'a1', U = '756201191646691328', D = '994747471329873920', M = '3_908573900237180928', V = '13_909110614026444802', CARD = 'card://1321554298900107264';
const account = { id: A, name: 'Synthetic', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false };
const draft = { id: D, user_id: U, name: null, text: 'Original\n\nCopy', nullcast: true, card_uri: CARD, media_keys: [M], updated_at: '2026-11-03T00:00:00Z' };
const image = { media_key: M, media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', name: null, file_name: 'image.png', media_url: 'https://pbs.twimg.com/media/image.jpg', deleted: false };
const video = { media_key: V, media_type: 'VIDEO', media_status: 'TRANSCODE_COMPLETED', name: 'Video', file_name: 'video.mp4', title: 'Title', description: 'Body', poster_media_key: M, poster_media_url: image.media_url, media_url: 'https://video.twimg.com/video.mp4', deleted: false };
type Call = { url: URL; init: RequestInit };
const mutations = (calls: Call[]) => calls.filter(v => v.init.method !== 'GET');
const operation = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'x', accountId: A, tool, payload, kind });
const guard = { forcePausedCreation: true };
function fixture(handler?: (call: Call) => unknown) {
  const calls: Call[] = []; let current: Record<string, unknown> = structuredClone(draft), library: Record<string, unknown> = structuredClone(video);
  const client = new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const route = call.url.pathname.replace(`/12/accounts/${A}`, ''), params = Object.fromEntries(call.url.searchParams);
    if (init.method === 'GET') {
      const values: Record<string, unknown> = { '': account, '/promotable_users': [{ id: 'pu1', user_id: U, promotable_user_type: 'FULL', deleted: false }], '/authenticated_user_access': { user_id: '123', permissions: ['AD_MANAGER', 'TWEET_COMPOSER'] }, '/draft_tweets': [current], [`/draft_tweets/${D}`]: current, '/media_library': [image, library], [`/media_library/${M}`]: image, [`/media_library/${V}`]: library, '/cards/all': [{ id: '1321554298900107264', card_uri: CARD, card_type: 'IMAGE_WEBSITE', deleted: false }] };
      if (route in values) return Response.json({ data: values[route], next_cursor: null });
    }
    if (route.startsWith('/draft_tweets') && ['POST', 'PUT'].includes(String(init.method))) {
      if (init.method === 'POST') current = { ...draft, text: '', name: null, media_keys: [], card_uri: null, nullcast: true };
      for (const [key, value] of Object.entries(params)) current[key === 'as_user_id' ? 'user_id' : key] = key === 'media_keys' ? value ? value.split(',') : [] : key === 'card_uri' ? value || null : key === 'nullcast' ? value === 'true' : value;
      return Response.json({ data: current });
    }
    if (route.startsWith('/media_library') && init.method === 'PUT') { library = { ...library, ...params }; return Response.json({ data: library }); }
    if (init.method === 'DELETE') return Response.json({ data: route.startsWith('/draft_tweets') ? { ...current, status: 'DELETED' } : { ...library, deleted: true } });
    throw new Error(`Unexpected ${init.method} ${route}`);
  });
  return { calls, provider: new XAdsProvider(client) };
}
const dirs: string[] = [];
afterEach(async () => { for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('X native draft/media creative management', () => {
  it('returns actual copy and ready previews with separate scoped copy/name actions', async () => {
    const { provider, calls } = fixture(), result = await provider.creatives.drafts({ account_id: A, count: 2, user_id: U });
    expect(creativesOutput.safeParse(result).success).toBe(true); expect(result.creatives[0]).toMatchObject({ id: D, status: 'DRAFT', descriptions: [draft.text], media: [{ type: 'image', url: image.media_url }], actions: [{ tool: 'x_update_draft_tweet', arguments: { account_id: A, draft_tweet_id: D }, fields: [{ key: 'text', value: draft.text }] }, { fields: [{ key: 'name' }] }] });
    expect(calls.find(v => v.url.pathname.endsWith('/draft_tweets'))!.url.searchParams.get('user_id')).toBe(U); expect(mutations(calls)).toEqual([]);
    const withoutMedia = await provider.creatives.drafts({ account_id: A, include_media: false }); expect(withoutMedia.creatives[0]!.media).toEqual([]);
  });
  it('retains native pagination, rejects author leaks and never loses references on failed media hydration', async () => {
    const paged = fixture(call => call.url.pathname.endsWith('/draft_tweets') ? { data: [draft], next_cursor: 'next' } : call.url.pathname.endsWith(`/media_library/${M}`) ? new Response('', { status: 404 }) : undefined);
    const result = await paged.provider.creatives.drafts({ account_id: A }); expect(result).toMatchObject({ truncated: true, next_cursor: 'next', warnings: [expect.stringContaining(M)], items: [{ media_keys: [M] }] }); expect(result.creatives[0]!.media).toEqual([]);
    await expect(paged.provider.creatives.drafts({ account_id: A, cursor: 'next' })).rejects.toThrow('repeated');
    const foreign = fixture(call => call.url.pathname.endsWith('/draft_tweets') ? { data: [{ ...draft, user_id: '999' }], next_cursor: null } : undefined); await expect(foreign.provider.creatives.drafts({ account_id: A, user_id: U })).rejects.toThrow('author/state');
  });
  it('creates only a promoted-only draft through POST signed query parameters after a read-only preview', async () => {
    const { provider, calls } = fixture(), op = operation('x_create_draft_tweet', { as_user_id: U, text: 'Copy + Ü\nNew line', name: 'QA draft', media_keys: [M], card_uri: CARD }, 'create');
    expect((await provider.previewWrite(op, guard)).changes).toEqual(expect.arrayContaining([expect.stringContaining('not server validation')])); expect(mutations(calls)).toEqual([]);
    expect(await provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: [D] }); const request = mutations(calls)[0]!;
    expect(request.url.pathname).toBe(`/12/accounts/${A}/draft_tweets`); expect(Object.fromEntries(request.url.searchParams)).toEqual({ as_user_id: U, nullcast: 'true', text: 'Copy + Ü\nNew line', name: 'QA draft', media_keys: M, card_uri: CARD }); expect(request.init.body).toBeUndefined(); expect(new Headers(request.init.headers).get('authorization')).toMatch(/^OAuth /);
    expect(mutations(calls).some(v => v.url.pathname.endsWith('/tweet') || v.url.pathname.endsWith('/promoted_tweets'))).toBe(false);
  });
  it('preserves omitted draft attachments, author, name and existing organic/nullcast state', async () => {
    let organic = { ...draft, nullcast: false, name: 'Existing' };
    const { provider, calls } = fixture(call => { if (!call.url.pathname.endsWith(`/draft_tweets/${D}`)) return undefined; if (call.init.method === 'PUT') organic = { ...organic, text: call.url.searchParams.get('text')! }; return { data: organic }; });
    await provider.applyWrite(operation('x_update_draft_tweet', { draft_tweet_id: D, text: 'New copy' }), guard); expect(Object.fromEntries(mutations(calls)[0]!.url.searchParams)).toEqual({ text: 'New copy' });
  });
  it('clears media and cards only with explicit empty/null fields and rejects empty final content', async () => {
    const { provider, calls } = fixture(); await provider.applyWrite(operation('x_update_draft_tweet', { draft_tweet_id: D, media_keys: [], card_uri: null }), guard); expect(Object.fromEntries(mutations(calls)[0]!.url.searchParams)).toEqual({ media_keys: '', card_uri: '' });
    await expect(provider.previewWrite(operation('x_update_draft_tweet', { draft_tweet_id: D, text: '', media_keys: [] }), guard)).rejects.toThrow('needs text or media'); expect(mutations(calls)).toHaveLength(1);
  });
  it('checks FULL advertiser membership and composer permission, but permits the same authenticated FULL user', async () => {
    const input = operation('x_create_draft_tweet', { as_user_id: U, text: 'Draft' }, 'create');
    for (const handler of [
      (call: Call) => call.url.pathname.endsWith('/promotable_users') ? { data: [{ id: 'pu1', user_id: U, promotable_user_type: 'RETWEETS_ONLY', deleted: false }], next_cursor: null } : undefined,
      (call: Call) => call.url.pathname.endsWith('/authenticated_user_access') ? { data: { user_id: '999', permissions: ['AD_MANAGER'] } } : undefined,
    ]) { const { provider, calls } = fixture(handler); await expect(provider.previewWrite(input, guard)).rejects.toThrow(); expect(mutations(calls)).toEqual([]); }
    const own = fixture(call => call.url.pathname.endsWith('/authenticated_user_access') ? { data: { user_id: U, permissions: ['AD_MANAGER'] } } : undefined); await expect(own.provider.previewWrite(input, guard)).resolves.toMatchObject({ serverValidated: false });
  });
  it.each(['deleted', 'pending', 'wrong-key', 'mixed', 'missing-card'])('rejects unavailable or incompatible attachment source: %s', async mode => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/media_library/${M}`) ? { data: { ...image, ...(mode === 'deleted' ? { deleted: true } : mode === 'pending' ? { media_status: 'PROCESSING' } : mode === 'wrong-key' ? { media_key: '3_999' } : {}) } } : mode === 'missing-card' && call.url.pathname.endsWith('/cards/all') ? { data: [] } : undefined);
    const payload = { as_user_id: U, text: 'Draft', media_keys: mode === 'mixed' ? [M, V] : [M], ...(mode === 'missing-card' ? { card_uri: CARD } : {}) }; await expect(provider.previewWrite(operation('x_create_draft_tweet', payload, 'create'), guard)).rejects.toThrow(); expect(mutations(calls)).toEqual([]);
  });
  it('binds exact draft, card and media lookups to requested IDs and the account path', async () => {
    const wrongDraft = fixture(call => call.url.pathname.endsWith(`/draft_tweets/${D}`) ? { data: { ...draft, id: '999' } } : undefined); await expect(wrongDraft.provider.creatives.draft(A, D)).rejects.toThrow('ID/state mismatch');
    const wrongCard = fixture(call => call.url.pathname.endsWith('/cards/all') ? { data: [{ id: '999', card_uri: 'card://999', deleted: false, card_type: 'IMAGE_WEBSITE' }] } : undefined); await expect(wrongCard.provider.creatives.cards(A, [CARD])).rejects.toThrow('association/filter');
    const { provider, calls } = fixture(); expect(await provider.creatives.cards(A, [CARD, 'card://999'])).toMatchObject({ missing: ['card://999'] }); expect(calls.at(-1)!.url.searchParams.get('card_uris')).toBe(`${CARD},card://999`);
  });
  it('retains IDs when native create unexpectedly publishes, changes copy or changes an omitted attachment', async () => {
    for (const changed of [{ nullcast: false }, { text: 'Unexpected rewrite' }, { card_uri: null }]) {
      const { provider, calls } = fixture(call => call.init.method === 'PUT' ? { data: { ...draft, text: 'Approved', ...changed } } : undefined); await expect(provider.applyWrite(operation('x_update_draft_tweet', { draft_tweet_id: D, text: 'Approved' }), guard)).rejects.toMatchObject({ details: { resource_ids: [D] } }); expect(mutations(calls)).toHaveLength(1);
    }
  });
  it('hard-deletes a draft with a DELETED receipt, retaining the ID if deletion is unconfirmed', async () => {
    const { provider, calls } = fixture(); await expect(provider.applyWrite(operation('x_delete_draft_tweet', { draft_tweet_id: D }, 'remove'), guard)).resolves.toMatchObject({ resourceIds: [D] }); expect(mutations(calls)[0]!.init.method).toBe('DELETE');
    const mismatch = fixture(call => call.init.method === 'DELETE' ? { data: draft } : undefined); await expect(mismatch.provider.applyWrite(operation('x_delete_draft_tweet', { draft_tweet_id: D }, 'remove'), guard)).rejects.toMatchObject({ details: { resource_ids: [D] } });
  });
  it('reconciles the live text-only PUT shape which omits name, using complete exact-ID readback', async () => {
    let changed = false;
    const { provider, calls } = fixture(call => {
      if (!call.url.pathname.endsWith(`/draft_tweets/${D}`)) return undefined;
      if (call.init.method === 'PUT') { changed = true; const { name: _name, ...partial } = draft; return { data: { ...partial, text: 'Updated' } }; }
      return { data: { ...draft, text: changed ? 'Updated' : draft.text } };
    });
    await expect(provider.applyWrite(operation('x_update_draft_tweet', { draft_tweet_id: D, text: 'Updated' }), guard)).resolves.toMatchObject({ resourceIds: [D] });
    expect(mutations(calls)).toHaveLength(1); expect(calls.at(-1)!.init.method).toBe('GET'); expect(calls.at(-1)!.url.pathname).toContain(D);
    let mutated = false;
    const stale = fixture(call => call.url.pathname.endsWith(`/draft_tweets/${D}`) ? call.init.method === 'PUT' ? (mutated = true, { data: { id: D } }) : { data: { ...draft, name: mutated ? 'Unapproved rename' : draft.name, text: mutated ? 'Updated' : draft.text } } : undefined);
    await expect(stale.provider.applyWrite(operation('x_update_draft_tweet', { draft_tweet_id: D, text: 'Updated' }), guard)).rejects.toMatchObject({ details: { resource_ids: [D] } });
  });
  it('retains string IDs on malformed create receipts and never uses rounded numeric snowflakes', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: { id: Number(D), id_str: D, text: 'Draft' } } : undefined);
    await expect(provider.applyWrite(operation('x_create_draft_tweet', { as_user_id: U, text: 'Draft' }, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [D] } }); expect(mutations(calls)).toHaveLength(1);
  });
  it('renders video/poster media only from native HTTPS CDN URLs and binds rename actions', async () => {
    const { provider } = fixture(), result = await provider.creatives.library({ account_id: A, count: 2 }); expect(creativesOutput.safeParse(result).success).toBe(true); expect(result.creatives[1]!.media).toEqual([{ type: 'video', url: video.media_url, poster_url: image.media_url }]); expect(result.creatives[1]!.actions[0]!.arguments).toEqual({ account_id: A, media_key: V });
    const unsafe = fixture(call => call.url.pathname.endsWith('/media_library') ? { data: [{ ...image, media_url: 'https://attacker.example/file.jpg' }], next_cursor: null } : undefined); expect((await unsafe.provider.creatives.library({ account_id: A })).creatives[0]!.media).toEqual([]);
  });
  it('updates supplied library metadata/poster, preserves other metadata and rejects incompatible image settings', async () => {
    const { provider, calls } = fixture(); await provider.applyWrite(operation('x_update_media_library', { media_key: V, title: 'New title', poster_media_key: M }), guard); expect(Object.fromEntries(mutations(calls)[0]!.url.searchParams)).toEqual({ title: 'New title', poster_media_key: M });
    await expect(provider.previewWrite(operation('x_update_media_library', { media_key: M, title: 'Invalid' }), guard)).rejects.toThrow('need video'); expect(mutations(calls)).toHaveLength(1);
    const mismatch = fixture(call => call.init.method === 'PUT' ? { data: { ...video, title: 'New title', description: null } } : undefined); await expect(mismatch.provider.applyWrite(operation('x_update_media_library', { media_key: V, title: 'New title' }), guard)).rejects.toMatchObject({ details: { resource_ids: [V] } });
  });
  it('deletes library records without claiming an ad pause or underlying-byte deletion', async () => {
    const { provider, calls } = fixture(), op = operation('x_delete_media_library_item', { media_key: V }, 'remove'); expect((await provider.previewWrite(op, guard)).changes[0]).toContain('neither pauses'); expect(mutations(calls)).toEqual([]); await provider.applyWrite(op, guard); expect(mutations(calls)[0]!.url.pathname).toBe(`/12/accounts/${A}/media_library/${V}`);
  });
  it('uses the exact-argument shared pending/protected-account gate for draft writes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'x-creatives-')); dirs.push(directory); const { provider, calls } = fixture(), audit = new AuditLog(path.join(directory, 'audit')), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(directory, 'pending')), audit), runtime = await createContext({ engine, providerModules: [{ provider, tools: xTools(provider) }] });
    const args = { account_id: A, as_user_id: U, text: 'Approved draft' }, pending = await runtime.registry.call('x_create_draft_tweet', args, runtime.ctx) as { pending_operation_id: string }; expect(mutations(calls)).toEqual([]); await expect(runtime.registry.call('x_create_draft_tweet', { ...args, text: 'Other', pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('differs'); await runtime.registry.call('x_create_draft_tweet', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx); expect(mutations(calls)).toHaveLength(1);
    const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(directory, 'blocked')), audit); await expect(protectedEngine.validate(provider, operation('x_create_draft_tweet', { as_user_id: U, text: 'Draft' }, 'create'))).rejects.toThrow('protected');
  });
});
