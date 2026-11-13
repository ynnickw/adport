import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, creativesOutput, DEFAULT_POLICY, nextPageArguments, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { createCard, updateCard, type NativeCard } from '../src/card-schemas.js';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';

// Official xdevplatform/docs creatives/reference.mdx blob 8dd974803dab7fa6187ae8111723eb812687fd03,
// refreshed 2026-11-05. Card POST uses a JSON body/object receipt; GET/PUT/DELETE use array data.
const A = 'a1', C = '1321554298900107264', OTHER = '1321554298900107265', URI = `card://${C}`;
const M = '3_908573900237180928', V = '13_909110614026444802';
const account = { id: A, name: 'QA account', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false };
const image = { media_key: M, media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', media_url: 'https://pbs.twimg.com/media/qa.jpg', deleted: false };
const media = (key = M) => ({ type: 'MEDIA', media_key: key });
const details = (title = 'QA title', url = 'https://example.com/qa') => ({ type: 'DETAILS', title, destination: { type: 'WEBSITE', url } });
const button = () => ({ type: 'BUTTON', label: { type: 'ENUM', value: 'INSTALL' }, destination: { type: 'APP', country_code: 'US', ios_app_store_identifier: '12345678', ios_deep_link: 'qaapp://home' } });
const original: NativeCard = { id: C, card_uri: URI, name: 'QA card', card_type: 'IMAGE_WEBSITE', deleted: false, components: [media(), details()], created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:00:00Z' };
const guard = { forcePausedCreation: true };
type Call = { url: URL; init: RequestInit; body?: Record<string, unknown> };
const writes = (calls: Call[]) => calls.filter(v => v.init.method !== 'GET');
const operation = (payload: Record<string, unknown>, tool = 'x_create_card'): WriteOperation => ({ provider: 'x', accountId: A, tool, kind: tool === 'x_create_card' ? 'create' : tool === 'x_delete_card' ? 'remove' : 'update', payload });
function fixture(options: { initial?: NativeCard; cardType?: string; handler?: (call: Call) => unknown } = {}) {
  const calls: Call[] = [];let current = structuredClone(options.initial ?? original);
  const client = new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' }, async (url, init = {}) => {
    const call: Call = { url: new URL(String(url)), init, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };calls.push(call);
    const custom = options.handler?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const route = call.url.pathname.replace(`/12/accounts/${A}`, '');
    if (init.method === 'GET') {
      if (!route) return Response.json({ data: account });
      if (route === '/cards') return Response.json({ data: [current], next_cursor: null });
      if (route.startsWith('/cards/')) return Response.json({ data: [current] });
      if (route.startsWith('/media_library/')) { const key = route.split('/').at(-1)!;return Response.json({ data: { ...image, media_key: key, ...(key.startsWith('13_') ? { media_type: 'VIDEO', media_url: 'https://video.twimg.com/qa.mp4', poster_media_url: image.media_url } : {}) } }); }
    }
    if (route === '/cards' && init.method === 'POST' || route === `/cards/${C}` && init.method === 'PUT') {
      current = { ...current, ...call.body, card_type: options.cardType ?? current.card_type, updated_at: '2026-11-05T00:01:00Z' } as NativeCard;
      if (call.body?.components) delete current.slides;
      if (call.body?.slides) delete current.components;
      return Response.json({ data: init.method === 'POST' ? current : [current] });
    }
    if (route === `/cards/${C}` && init.method === 'DELETE') { current.deleted = true;return Response.json({ data: [current] }); }
    throw new Error(`Unexpected ${init.method} ${route}`);
  });
  return { calls, provider: new XAdsProvider(client), current: () => current, set: (value: NativeCard) => { current = value; } };
}
async function editInput(f: ReturnType<typeof fixture>, fields: Record<string, unknown> = {}) { return { card_id: C, expected_configuration_hash: (await f.provider.cards.get(A, C)).configuration_hash, acknowledge_shared_creative_effects: true, ...fields }; }
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(value => rm(value, { recursive: true, force: true }))); });

describe('typed X card authoring schemas', () => {
  it('accepts single media, ordered carousels and complete multi-destination website slides', () => {
    for (const value of [
      { name: 'Website', components: [media(), details()] },
      { name: 'App', components: [media(V), button()] },
      { name: 'Carousel', components: [{ type: 'SWIPEABLE_MEDIA', media_keys: [M, V] }, details()] },
      { name: 'Multi destination', slides: [[media(), details('First')], [media(V), details('Second', 'https://example.com/second')]] },
    ]) expect(createCard.safeParse(value).success).toBe(true);
  });
  it.each([
    { name: 'No layout' }, { name: 'Both', components: [media(), details()], slides: [[media(), details()], [media(), details()]] },
    { name: 'Wrong order', components: [details(), media()] }, { name: 'Two media', components: [media(), media(V)] },
    { name: 'Short carousel', components: [{ type: 'SWIPEABLE_MEDIA', media_keys: [M] }, details()] },
    { name: 'Long carousel', components: [{ type: 'SWIPEABLE_MEDIA', media_keys: Array(7).fill(M) }, details()] },
    { name: 'App slides', slides: [[media(), button()], [media(), button()]] },
    { name: 'Unsafe destination', components: [media(), details('Title', 'javascript:alert(1)')] },
    { name: 'Malformed destination', components: [media(), details('Title', 'invalid')] },
    { name: 'Embedded credential', components: [media(), details('Title', 'https://user:pass@example.com')] },
    { name: 'Missing app', components: [media(), { ...button(), destination: { type: 'APP', country_code: 'US' } }] },
    { name: 'Mismatched deep link', components: [media(), { ...button(), destination: { type: 'APP', country_code: 'US', ios_app_store_identifier: '123', googleplay_deep_link: 'app://home' } }] },
    { name: 'Unknown field', components: [media(), { ...details(), arbitrary_native_flag: true }] },
  ])('rejects incompatible or unrepresentable card content: $name', value => { expect(createCard.safeParse(value).success).toBe(false); });
  it('requires changes, snapshot, explicit shared-effects acknowledgement and unambiguous copy edits', () => {
    const base = { card_id: C, expected_configuration_hash: 'a'.repeat(64), acknowledge_shared_creative_effects: true };
    for (const value of [base, { ...base, name: 'Name', acknowledge_shared_creative_effects: false }, { ...base, name: 'Name', expected_configuration_hash: 'old' }, { ...base, components: [media(), details()], title: 'Mixed' }, { ...base, slide_index: 0 }]) expect(updateCard.safeParse(value).success).toBe(false);
    expect(updateCard.safeParse({ ...base, title: 'Changed' }).success).toBe(true);
  });
});

describe('native X card lifecycle and shared widgets', () => {
  it('keeps native page rows, cursor and filters, string IDs, exact snapshot and bound widget copy actions', async () => {
    const second = { ...original, id: OTHER, card_uri: `card://${OTHER}` };
    const f = fixture({ handler: call => call.url.pathname.endsWith('/cards') ? { data: [original, second], next_cursor: 'next-page' } : undefined });
    const result = await f.provider.cards.list({ account_id: A, count: 1, card_types: ['IMAGE_WEBSITE'], card_ids: [C, OTHER], card_uris: [URI, `card://${OTHER}`], q: 'QA', include_legacy_cards: true });
    expect(creativesOutput.passthrough().parse(result).creatives).toHaveLength(2);
    expect(result).toMatchObject({ truncated: true, next_cursor: 'next-page', items: [{ id: C, configuration_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }, { id: OTHER }] });
    expect(Object.fromEntries(f.calls.find(v => v.url.pathname.endsWith('/cards'))!.url.searchParams)).toEqual({ count: '1', include_legacy_cards: 'true', with_deleted: 'false', card_types: 'IMAGE_WEBSITE', card_id: `${C},${OTHER}`, card_uris: `${URI},card://${OTHER}`, q: 'QA' });
    expect(result.creatives[0]).toMatchObject({ headlines: ['QA title'], landing_urls: ['https://example.com/qa'], media: [{ type: 'image', url: image.media_url }], actions: [{ tool: 'x_update_card', arguments: { account_id: A, card_id: C, acknowledge_shared_creative_effects: true } }, { fields: [{ key: 'title', value: 'QA title' }, { key: 'website_url' }] }] });
    const tool = xTools(f.provider).find(t => t.name === 'x_cards')!;
    expect(nextPageArguments(tool, { account_id: A, q: 'QA', count: 1 }, result)).toEqual({ account_id: A, q: 'QA', count: 1, cursor: 'next-page' });
    expect(writes(f.calls)).toHaveLength(0);
  });
  it.each(['cursor', 'duplicate', 'foreign-account', 'filter', 'deleted'] as const)('rejects conflicting inventory: %s', async mode => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/cards') ? { data: mode === 'duplicate' ? [original, original] : [{ ...original, ...(mode === 'foreign-account' ? { account_id: 'foreign' } : mode === 'deleted' ? { deleted: true } : {}) }], next_cursor: mode === 'cursor' ? 'same' : null } : undefined });
    await expect(f.provider.cards.list({ account_id: A, cursor: mode === 'cursor' ? 'same' : undefined, card_ids: mode === 'filter' ? [OTHER] : undefined })).rejects.toThrow(/inventory/);expect(writes(f.calls)).toHaveLength(0);
  });
  it('requires an array exact-ID read and rejects a conflicting account before card/media reads', async () => {
    const wrongShape = fixture({ handler: call => call.url.pathname.endsWith(`/cards/${C}`) ? { data: original } : undefined });
    await expect(wrongShape.provider.cards.get(A, C)).rejects.toThrow(/schema/);
    const wrongId = fixture({ handler: call => call.url.pathname.endsWith(`/cards/${C}`) ? { data: [{ ...original, id: OTHER }] } : undefined });
    await expect(wrongId.provider.cards.get(A, C)).rejects.toThrow(/mismatch/);
    const wrongAccount = fixture({ handler: call => call.url.pathname === `/12/accounts/${A}` ? { data: { ...account, id: 'foreign' } } : undefined });
    await expect(wrongAccount.provider.previewWrite(operation({ name: 'New', components: [media(), details()] }), guard)).rejects.toThrow(/account ID/);expect(wrongAccount.calls).toHaveLength(1);
  });
  it('bounds hydration at 100 while retaining every native card and failed/unsupported references', async () => {
    const cards = Array.from({ length: 101 }, (_, i) => { const id = String(BigInt(C) + BigInt(i));return { ...original, id, card_uri: `card://${id}`, components: [media(`3_${String(100000000000000000n + BigInt(i))}`), details()] }; });
    const f = fixture({ handler: call => call.url.pathname.endsWith('/cards') ? { data: cards, next_cursor: null } : undefined });
    const result = await f.provider.cards.list({ account_id: A, count: 200 });
    expect(result.items).toHaveLength(101);expect(result.creatives).toHaveLength(101);expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('100 distinct')]));
    expect(f.calls.filter(v => v.url.pathname.includes('/media_library/'))).toHaveLength(100);
    const legacy = fixture({ initial: { ...original, id: 'legacy1', components: [{ type: 'UNKNOWN', raw: 'retained' }] } });
    const raw = await legacy.provider.cards.list({ account_id: A, include_legacy_cards: true });expect(raw.items[0]!.components).toEqual([{ type: 'UNKNOWN', raw: 'retained' }]);expect(raw.creatives[0]!.actions).toEqual([]);expect(raw.warnings.length).toBeGreaterThan(0);
  });
  it('keeps a failed preview source reference and never renders an unapproved CDN URL', async () => {
    const missing = fixture({ handler: call => call.url.pathname.includes('/media_library/') ? new Response('', { status: 403 }) : undefined });
    const result = await missing.provider.cards.list({ account_id: A });expect(result.items[0]!.components).toEqual(original.components);expect(result.creatives[0]!.media).toEqual([]);expect(result.warnings.length).toBe(1);
    const unsafe = fixture({ handler: call => call.url.pathname.includes('/media_library/') ? { data: { ...image, media_url: 'https://foreign.example/image.jpg' } } : undefined });
    expect((await unsafe.provider.cards.list({ account_id: A })).creatives[0]!.media).toEqual([]);
  });
  it('creates one unattached card through OAuth-signed JSON and confirms it independently without publishing', async () => {
    const f = fixture(), payload = { name: 'QA new + Ü', components: [media(), details('New title', 'https://example.com/new?a=1&b=2')] };
    const preview = await f.provider.previewWrite(operation(payload), guard);expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [] });expect(writes(f.calls)).toHaveLength(0);
    await expect(f.provider.applyWrite(operation(payload), guard)).resolves.toEqual({ applied: true, resourceIds: [C] });
    const call = writes(f.calls)[0]!;expect(call.url.pathname).toBe(`/12/accounts/${A}/cards`);expect(call.url.search).toBe('');expect(call.body).toEqual(payload);expect(new Headers(call.init.headers).get('content-type')).toBe('application/json');expect(new Headers(call.init.headers).get('authorization')).toMatch(/^OAuth /);
    expect(writes(f.calls)).toHaveLength(1);expect(f.calls.at(-1)!.url.pathname).toBe(`/12/accounts/${A}/cards/${C}`);expect(f.calls.some(v => /\/(?:tweet|promoted_tweets|campaigns|line_items)(?:\/|$)/.test(v.url.pathname))).toBe(false);
  });
  it.each(['IMAGE_APP', 'MIXED_MEDIA_SINGLE_DEST_CAROUSEL_WEBSITE', 'IMAGE_MULTI_DEST_CAROUSEL_WEBSITE'])('supports native app/carousel layout %s', async type => {
    const payload = type === 'IMAGE_APP' ? { name: 'App', components: [media(), button()] } : type === 'MIXED_MEDIA_SINGLE_DEST_CAROUSEL_WEBSITE' ? { name: 'Mixed', components: [{ type: 'SWIPEABLE_MEDIA', media_keys: [M, V] }, details()] } : { name: 'Slides', slides: [[media(), details('First')], [media(), details('Second', 'https://example.com/second')]] };
    const f = fixture({ cardType: type });await f.provider.applyWrite(operation(payload), guard);expect(writes(f.calls)[0]!.body).toEqual(payload);expect(f.current().card_type).toBe(type);
  });
  it.each(['pending', 'deleted', 'gif', 'foreign-account', 'wrong-key'])('rejects unavailable media before card creation: %s', async mode => {
    const f = fixture({ handler: call => call.url.pathname.includes('/media_library/') ? { data: { ...image, ...(mode === 'pending' ? { media_status: 'PROCESSING' } : mode === 'deleted' ? { deleted: true } : mode === 'gif' ? { media_type: 'GIF' } : mode === 'foreign-account' ? { account_id: 'foreign' } : { media_key: '3_999' }) } } : undefined });
    await expect(f.provider.previewWrite(operation({ name: 'New', components: [media(), details()] }), guard)).rejects.toThrow();expect(writes(f.calls)).toHaveLength(0);
  });
  it('uses current configuration hashes and preserves omitted layout/name while editing copy', async () => {
    const f = fixture(), rename = await editInput(f, { name: 'Renamed' });
    await f.provider.applyWrite(operation(rename, 'x_update_card'), guard);expect(writes(f.calls)[0]!.body).toEqual({ name: 'Renamed' });expect(f.current().components).toEqual(original.components);
    const copy = await editInput(f, { title: 'Updated copy' });await f.provider.applyWrite(operation(copy, 'x_update_card'), guard);
    expect(writes(f.calls)[1]!.body).toEqual({ components: [media(), details('Updated copy')] });expect(f.current().name).toBe('Renamed');
    const stale = await editInput(f, { name: 'No' });f.set({ ...f.current(), updated_at: '2026-11-05T01:00:00Z' });await expect(f.provider.applyWrite(operation(stale, 'x_update_card'), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(f.calls)).toHaveLength(2);
  });
  it('edits only the selected multi-destination slide and preserves its media and other slides', async () => {
    const slides = [[media(), details('First')], [media(V), details('Second', 'https://example.com/second')]];
    const f = fixture({ initial: { ...original, components: undefined, slides, card_type: 'MIXED_MEDIA_MULTI_DEST_CAROUSEL_WEBSITE' }, cardType: 'MIXED_MEDIA_MULTI_DEST_CAROUSEL_WEBSITE' });
    await expect(f.provider.previewWrite(operation(await editInput(f, { title: 'Changed' }), 'x_update_card'), guard)).rejects.toThrow(/slide_index/);
    const payload = await editInput(f, { slide_index: 1, title: 'Changed' });await f.provider.applyWrite(operation(payload, 'x_update_card'), guard);
    expect(writes(f.calls)[0]!.body).toEqual({ slides: [slides[0], [media(V), details('Changed', 'https://example.com/second')]] });
    const actions = (await f.provider.cards.list({ account_id: A, include_media: false })).creatives[0]!.actions;expect(actions[2]!.arguments.slide_index).toBe(1);
  });
  it('changes app button copy without replacing its app identifiers/deep link', async () => {
    const f = fixture({ initial: { ...original, card_type: 'IMAGE_APP', components: [media(), button()] } });
    await expect(f.provider.previewWrite(operation(await editInput(f, { title: 'Wrong shortcut' }), 'x_update_card'), guard)).rejects.toThrow(/DETAILS/);
    await f.provider.applyWrite(operation(await editInput(f, { button_label: 'OPEN' }), 'x_update_card'), guard);
    expect(writes(f.calls)[0]!.body).toEqual({ components: [media(), { ...button(), label: { type: 'ENUM', value: 'OPEN' } }] });
  });
  it('refuses to drop unsupported native fields during copy edits while permitting name-only preservation', async () => {
    const components = [media(), { ...details(), unknown_native_field: 'keep' }], f = fixture({ initial: { ...original, components } });
    await expect(f.provider.previewWrite(operation(await editInput(f, { title: 'No' }), 'x_update_card'), guard)).rejects.toThrow(/unsupported component/);
    await f.provider.applyWrite(operation(await editInput(f, { name: 'Rename only' }), 'x_update_card'), guard);expect(writes(f.calls)[0]!.body).toEqual({ name: 'Rename only' });expect(f.current().components).toEqual(components);
  });
  it('retains original and unexpected receipt IDs and does not replay changed-content or failed readback writes', async () => {
    for (const mode of ['receipt-id', 'receipt-content', 'readback'] as const) {
      let submitted = false;
      const f = fixture({ handler: call => { if (call.init.method === 'PUT') { submitted = true;return { data: [{ ...original, name: 'Changed', ...(mode === 'receipt-id' ? { id: OTHER } : mode === 'receipt-content' ? { components: [media(), details('Unexpected')] } : {}) }] }; } if (submitted && mode === 'readback' && call.url.pathname.endsWith(`/cards/${C}`)) return new Response('', { status: 403 });return undefined; } });
      const payload = await editInput(f, { name: 'Changed' });const error = await f.provider.applyWrite(operation(payload, 'x_update_card'), guard).catch(error => error);
      expect(error.details.resource_ids).toContain(C);if (mode === 'receipt-id') expect(error.details.resource_ids).toContain(OTHER);expect(writes(f.calls)).toHaveLength(1);
    }
  });
  it('retains a created card ID after an unexpected native response schema and never retries POST', async () => {
    const f = fixture({ handler: call => call.init.method === 'POST' ? { data: { id: C } } : undefined });
    await expect(f.provider.applyWrite(operation({ name: 'New', components: [media(), details()] }), guard)).rejects.toMatchObject({ details: { resource_ids: [C] } });expect(writes(f.calls)).toHaveLength(1);
  });
  it('verifies native deletion and exact tombstone readback with no POST body', async () => {
    const f = fixture(), payload = await editInput(f);await f.provider.applyWrite(operation(payload, 'x_delete_card'), guard);
    expect(writes(f.calls)).toHaveLength(1);expect(writes(f.calls)[0]!.init.method).toBe('DELETE');expect(writes(f.calls)[0]!.init.body).toBeUndefined();expect(f.calls.at(-1)!.url.searchParams.get('with_deleted')).toBe('true');expect(f.current().deleted).toBe(true);
  });
  it('requires the shared policy gate and consumes a creation approval for exactly one native attempt', async () => {
    const f = fixture(), dir = await mkdtemp(path.join(tmpdir(), 'adport-x-card-'));dirs.push(dir);
    const runtime = await createContext({ providerModules: [{ provider: f.provider, tools: xTools(f.provider) }], engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))) });
    const args = { account_id: A, name: 'QA card', components: [media(), details()] };
    const preview = await runtime.registry.call('x_create_card', args, runtime.ctx) as any;expect(preview).toMatchObject({ status: 'pending_validation', applied: false, preview: { serverValidated: false } });expect(writes(f.calls)).toHaveLength(0);
    const request = { ...args, pending_operation_id: preview.pending_operation_id };await runtime.registry.call('x_create_card', request, runtime.ctx);expect(writes(f.calls)).toHaveLength(1);
    await expect(runtime.registry.call('x_create_card', request, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(writes(f.calls)).toHaveLength(1);
    const tools = xTools(f.provider);expect(tools.find(t => t.name === 'x_create_card')!.annotations).toMatchObject({ readOnly: false, destructive: false });expect(tools.find(t => t.name === 'x_delete_card')!.annotations.destructive).toBe(true);
  });
});
