import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AuditLog, createContext, creativesOutput, DEFAULT_POLICY, nextPageArguments, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';
import { accountMediaList, createDirectMedia, directMediaSelection, nativeDirectMedia } from '../src/direct-media-schemas.js';

// Official xdevplatform/docs09e643bc, creatives/campaign-management reference,
// refreshed2026-11-06: Account Media and library IDs differ; POST/DELETE
// media_creatives return objects. DELETE tombstones may retain ACTIVE.
const A = 'a1', S = 'am1', L = 'l1', I = 'mc1';
const account = { id: A, name: 'QA account', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false };
const campaign = { id: 'c1', name: 'QA campaign', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null };
const line = { id: L, name: 'QA media group', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['PUBLISHER_NETWORK'], product_type: 'MEDIA', objective: 'PREROLL_VIEWS', daily_budget_amount_local_micro: 5_000_000, total_budget_amount_local_micro: null };
const asset = { id: S, creative_type: 'PREROLL', video_id: '13_771791717175468032', media_url: 'https://video.twimg.com/qa.mp4', deleted: false };
const association: z.infer<typeof nativeDirectMedia> = { id: I, line_item_id: L, account_media_id: S, creative_type: 'PREROLL', landing_url: null, entity_status: 'ACTIVE', approval_status: 'ACCEPTED', deleted: false };
const guard = { forcePausedCreation: true }, selection = { line_item_id: L, account_media_id: S };
type Call = { url: URL; init: RequestInit };
type Options = { source?: Record<string, unknown>; line?: Record<string, unknown>; campaign?: Record<string, unknown>; associations?: typeof association[]; handler?(call: Call): unknown | Promise<unknown> };
function fixture(options: Options = {}) {
  const calls: Call[] = [], source = { ...asset, ...options.source }, parent = { ...line, ...options.line }, funding = { ...campaign, ...options.campaign }, associations = structuredClone(options.associations ?? []);
  const client = new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' }, async (raw, init = {}) => {
    const call = { url: new URL(String(raw)), init };calls.push(call);const custom = await options.handler?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const path = call.url.pathname.replace(`/12/accounts/${A}`, ''), q = call.url.searchParams;
    if (init.method === 'GET') {
      if (!path) return Response.json({ data: account });
      if (path === '/line_items/' + L) return Response.json({ data: parent });
      if (path === '/campaigns/c1') return Response.json({ data: funding });
      if (path === '/account_media') return Response.json({ data: [source], next_cursor: null });
      if (path === '/account_media/' + S) return Response.json({ data: source });
      if (path === '/media_creatives') return Response.json({ data: associations.filter(row => q.get('with_deleted') === 'true' || !row.deleted), next_cursor: null });
      if (path === '/media_creatives/' + I) return associations[0] ? Response.json({ data: associations[0] }) : new Response('', { status: 404 });
    }
    if (path === '/media_creatives' && init.method === 'POST') { const row = { ...association, creative_type: source.creative_type, landing_url: q.get('landing_url') };associations.push(row);return Response.json({ data: row }); }
    if (path === '/media_creatives/' + I && init.method === 'DELETE') { associations[0]!.deleted = true;return Response.json({ data: associations[0] }); }
    throw new Error(`Unexpected synthetic endpoint ${init.method} ${path}`);
  });
  return { provider: new XAdsProvider(client), calls, source, parent, funding, associations };
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.init.method !== 'GET');
const operation = (tool: string, payload: Record<string, unknown>): WriteOperation => ({ provider: 'x', tool, accountId: A, kind: tool === 'x_create_media_creative' ? 'create' : 'remove', payload });
async function create(f: ReturnType<typeof fixture>, values: Partial<typeof selection> & { landing_url?: string } = {}) { const input = { ...selection, ...values };return { ...input, expected_context_hash: (await f.provider.directMedia.context(A, input)).context_hash, acknowledge_active_association: true as const }; }
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('direct-media native contracts and source boundaries', () => {
  it.each([{ ...selection, account_media_id: '13_771791717175468032' }, { ...selection, landing_url: 'javascript:alert(1)' }, { ...selection, landing_url: 'https://user:secret@example.test/' }, { ...selection, media_key: '3_908573900237180928' }])('rejects invalid source IDs, destinations and implicit library conversion %#', value => {
    expect(directMediaSelection.safeParse(value).success).toBe(false);
  });
  it('requires an exact context hash and explicit native ACTIVE acknowledgement', () => {
    expect(createDirectMedia.safeParse(selection).success).toBe(false);
    expect(createDirectMedia.safeParse({ ...selection, expected_context_hash: 'a'.repeat(64), acknowledge_active_association: false }).success).toBe(false);
    expect(accountMediaList.safeParse({ account_id: A, creative_types: ['PREROLL', 'PREROLL'] }).success).toBe(false);
    expect(accountMediaList.safeParse({ account_id: A, count: 51 }).success).toBe(false);
    expect(directMediaSelection.parse({ ...selection, landing_url: 'http://example.test/?a=1&b=2' }).landing_url).toBe('http://example.test/?a=1&b=2');
  });
  it('keeps native asset and association identities distinct and pages assets with safe previews', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/account_media') ? { data: [asset], next_cursor: 'page-two' } : undefined });
    const result = await f.provider.directMedia.assets({ account_id: A, creative_types: ['PREROLL'], count: 1 });
    expect(result).toMatchObject({ truncated: true, next_cursor: 'page-two', creatives: [{ id: S, type: 'PREROLL', status: 'PRESENT', media: [{ type: 'video', url: asset.media_url }] }] });
    expect(creativesOutput.safeParse(result).success).toBe(true);
    const request = f.calls.at(-1)!;expect(Object.fromEntries(request.url.searchParams)).toEqual({ count: '1', with_deleted: 'false', creative_types: 'PREROLL' });
    expect(nextPageArguments(xTools(f.provider).find(tool => tool.name === 'x_account_media')!, { account_id: A, count: 1 }, result)).toEqual({ account_id: A, count: 1, cursor: 'page-two' });
    expect(writes(f)).toEqual([]);
  });
  it.each(['account', 'deleted', 'type', 'duplicate', 'cursor'] as const)('rejects incorrect asset scope/filter/paging: %s', async mode => {
    const row = { ...asset, ...(mode === 'account' ? { account_id: 'other' } : mode === 'deleted' ? { deleted: true } : mode === 'type' ? { creative_type: 'BANNER' } : {}) };
    const f = fixture({ handler: call => call.url.pathname.endsWith('/account_media') ? { data: mode === 'duplicate' ? [row, row] : [row], next_cursor: mode === 'cursor' ? 'same' : null } : undefined });
    await expect(f.provider.directMedia.assets({ account_id: A, creative_types: ['PREROLL'], ...(mode === 'cursor' ? { cursor: 'same' } : {}) })).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
  it('does not invent completeness or unsafe/VAST previews', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/account_media') ? { data: [{ ...asset, media_url: 'https://video.twimg.com@evil.test/qa.mp4' }, { ...asset, id: 'am2', creative_type: 'VAST_PREROLL' }] } : undefined });
    const result = await f.provider.directMedia.assets({ account_id: A });expect(result.truncated).toBe(true);expect(result.notes.join(' ')).toContain('unconfirmed');expect(result.creatives.every(row => !row.media.length)).toBe(true);
  });
  it('binds configuration without timestamp churn, and verifies exact IDs and string video IDs', async () => {
    const f = fixture();const first = await f.provider.directMedia.getAsset(A, S);Object.assign(f.source, { updated_at: 'later' });expect((await f.provider.directMedia.getAsset(A, S)).configuration_hash).toBe(first.configuration_hash);
    f.source.video_id = '13_771791717175468033';expect((await f.provider.directMedia.getAsset(A, S)).configuration_hash).not.toBe(first.configuration_hash);
    for (const data of [{ ...asset, id: 'other' }, { ...asset, account_id: 'other' }, { ...asset, video_id: 9007199254740993 }]) {
      const bad = fixture({ handler: call => call.url.pathname.endsWith('/account_media/' + S) ? { data } : undefined });await expect(bad.provider.directMedia.getAsset(A, S)).rejects.toThrow();
    }
  });
  it('hydrates scoped association cards and retains them when source access fails', async () => {
    const f = fixture({ associations: [association] }), result = await f.provider.directMedia.list({ account_id: A, line_item_id: L });
    expect(creativesOutput.safeParse(result).success).toBe(true);expect(result.creatives[0]).toMatchObject({ id: I, status: 'ACTIVE', campaign_id: 'c1', ad_group_id: L, landing_urls: [], media: [{ type: 'video' }], actions: [{ tool: 'x_delete_media_creative', arguments: { media_creative_id: I, expected_context_hash: result.items[0]!.context_hash } }] });
    expect(f.calls.find(call => call.url.pathname.endsWith('/media_creatives'))?.url.searchParams.get('line_item_ids')).toBe(L);
    const bad = fixture({ associations: [association], handler: call => call.url.pathname.endsWith('/account_media/' + S) ? new Response('', { status: 403 }) : undefined });
    const missing = await bad.provider.directMedia.list({ account_id: A, line_item_id: L });expect(missing.creatives).toHaveLength(1);expect(missing.creatives[0]!.media).toEqual([]);expect(missing.warnings.join(' ')).toContain('remains visible');expect(writes(bad)).toEqual([]);
  });
  it.each(['account', 'line', 'deleted', 'duplicate'] as const)('rejects mismatched association inventory: %s', async mode => {
    const row = { ...association, ...(mode === 'account' ? { account_id: 'other' } : mode === 'line' ? { line_item_id: 'other' } : mode === 'deleted' ? { deleted: true } : {}) };
    const f = fixture({ handler: call => call.url.pathname.endsWith('/media_creatives') ? { data: mode === 'duplicate' ? [row, row] : [row], next_cursor: null } : undefined });
    await expect(f.provider.directMedia.list({ account_id: A, line_item_id: L })).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
  it('preserves tombstone ACTIVE separately from disassociation and source ownership', async () => {
    const f = fixture({ associations: [{ ...association, deleted: true }] });const result = await f.provider.directMedia.list({ account_id: A, line_item_id: L, with_deleted: true });
    expect(result.creatives[0]).toMatchObject({ status: 'DISASSOCIATED', actions: [] });expect(result.items[0]!.entity_status).toBe('ACTIVE');
    const hidden = fixture({ associations: [association], source: { creative_type: 'BANNER' } });expect((await hidden.provider.directMedia.list({ account_id: A, line_item_id: L })).creatives[0]!.media).toEqual([]);
  });
  it.each(['source_deleted', 'vast', 'unknown', 'group_deleted', 'campaign_deleted', 'draft', 'product', 'currency'] as const)('rejects unsupported sources or parents: %s', async mode => {
    const f = fixture({ source: mode === 'source_deleted' ? { deleted: true } : mode === 'vast' ? { creative_type: 'VAST_PREROLL' } : mode === 'unknown' ? { creative_type: 'FUTURE' } : {}, line: mode === 'group_deleted' ? { deleted: true } : mode === 'draft' ? { entity_status: 'DRAFT' } : mode === 'product' ? { product_type: 'PROMOTED_TWEETS' } : mode === 'currency' ? { currency: 'EUR' } : {}, campaign: mode === 'campaign_deleted' ? { deleted: true } : {} });
    await expect(f.provider.directMedia.context(A, selection)).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
  it('requires website-click destinations and refuses a preroll URL that native would ignore', async () => {
    const preroll = fixture();await expect(preroll.provider.directMedia.context(A, { ...selection, landing_url: 'https://example.test' })).rejects.toThrow(/ignored/);
    const display = fixture({ source: { creative_type: 'BANNER', media_url: 'https://pbs.twimg.com/qa.png' }, line: { objective: 'WEBSITE_CLICKS' } });await expect(display.provider.directMedia.context(A, selection)).rejects.toThrow(/landing_url/);
    expect((await display.provider.directMedia.context(A, { ...selection, landing_url: 'https://example.test' })).creatives[0]!.media[0]!.type).toBe('image');expect(writes(display)).toEqual([]);
  });
  it('requires a complete bounded native inventory rather than treating missing cursors as absence', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/media_creatives') ? { data: [] } : undefined });
    await expect(f.provider.directMedia.context(A, selection)).rejects.toThrow(/incomplete/);expect(writes(f)).toEqual([]);
  });
});

describe('direct-media guarded native lifecycle', () => {
  it.each(['PREROLL', 'BANNER'] as const)('creates one %s association with signed native query and independent source/parent/readback checks', async type => {
    const f = fixture({ source: { creative_type: type }, ...(type === 'BANNER' ? { line: { objective: 'WEBSITE_CLICKS' } } : {}) }), payload = await create(f, type === 'BANNER' ? { landing_url: 'https://example.test/?a=1&b=2#section' } : {}), op = operation('x_create_media_creative', payload);
    const preview = await f.provider.previewWrite(op, guard);expect(preview.serverValidated).toBe(false);expect(preview.budgetDeltas).toEqual(expect.arrayContaining([{ target: 'l1 daily_budget_amount_local_micro existing pool', currency: 'USD', fromMicros: 5_000_000, toMicros: 5_000_000 }]));expect(writes(f)).toEqual([]);
    expect(await f.provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: [I] });
    const request = writes(f)[0]!;expect(request.url.pathname).toBe(`/12/accounts/${A}/media_creatives`);expect(Object.fromEntries(request.url.searchParams)).toEqual({ line_item_id: L, account_media_id: S, ...(type === 'BANNER' ? { landing_url: 'https://example.test/?a=1&b=2#section' } : {}) });expect(request.init.body).toBeUndefined();expect(request.init.headers).toMatchObject({ Authorization: expect.stringContaining('oauth_signature=') });
    expect(f.calls.filter(call => call.url.pathname.endsWith('/media_creatives/' + I) && call.init.method === 'GET')).toHaveLength(1);expect(f.parent.entity_status).toBe('PAUSED');expect(f.funding).toEqual(campaign);expect(writes(f)).toHaveLength(1);
  });
  it('requires a PAUSED ad group under policy even when the campaign is paused', async () => {
    const f = fixture({ line: { entity_status: 'ACTIVE' } }), payload = await create(f);
    await expect(f.provider.previewWrite(operation('x_create_media_creative', payload), guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(writes(f)).toEqual([]);
    expect((await f.provider.previewWrite(operation('x_create_media_creative', payload), { forcePausedCreation: false })).review?.fields).toContainEqual({ label: 'Parent delivery', after: 'ACTIVE' });
  });
  it('normalizes optional scope echoes and absent destinations without treating approval processing as a config edit', async () => {
    let created = false;const f = fixture({ handler: call => {
      if (call.init.method === 'POST') { created = true;return { data: { ...association, account_id: A, landing_url: undefined, approval_status: 'PENDING' } }; }
      if (created && call.url.pathname.endsWith('/media_creatives/' + I)) return { data: association };
      if (created && call.url.pathname.endsWith('/account_media/' + S)) return { data: { ...asset, account_id: A } };
      return undefined;
    } });
    expect(await f.provider.applyWrite(operation('x_create_media_creative', await create(f)), guard)).toEqual({ applied: true, resourceIds: [I] });expect(writes(f)).toHaveLength(1);
    const differentEchoes = fixture({ associations: [{ ...association, landing_url: undefined, approval_status: 'PENDING' }], handler: call => call.url.pathname.endsWith('/media_creatives/' + I) ? { data: { ...association, account_id: A } } : undefined });
    const gallery = await differentEchoes.provider.directMedia.list({ account_id: A, line_item_id: L }), exact = await differentEchoes.provider.directMedia.get(A, I);
    expect(gallery.items[0]!.context_hash).toBe(exact.context_hash);
  });
  it.each(['source', 'flight', 'budget', 'destination', 'association'] as const)('rechecks approved context before native creation: %s', async mode => {
    const f = fixture(mode === 'destination' ? { source: { creative_type: 'BANNER' }, line: { objective: 'WEBSITE_CLICKS' } } : {}), payload = await create(f, mode === 'destination' ? { landing_url: 'https://first.test' } : {});
    if (mode === 'source') f.source.video_id = '13_771791717175468033';
    if (mode === 'flight') Object.assign(f.parent, { end_time: '2027-01-01T00:00:00Z' });
    if (mode === 'budget') f.parent.daily_budget_amount_local_micro++;
    if (mode === 'association') f.associations.push({ ...association, id: 'mc2', account_media_id: 'am2' });
    await expect(f.provider.applyWrite(operation('x_create_media_creative', mode === 'destination' ? { ...payload, landing_url: 'https://second.test' } : payload), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(f)).toEqual([]);
  });
  it('does not recreate an existing association', async () => {
    const f = fixture({ associations: [association] }), payload = await create(f);await expect(f.provider.previewWrite(operation('x_create_media_creative', payload), guard)).rejects.toThrow(/already has/);expect(writes(f)).toEqual([]);
  });
  it('does not accept a creation receipt that reuses another existing association ID', async () => {
    const f = fixture({ associations: [{ ...association, account_media_id: 'am2' }], handler: call => call.init.method === 'POST' || call.url.pathname.endsWith('/media_creatives/' + I) ? { data: association } : undefined });
    await expect(f.provider.applyWrite(operation('x_create_media_creative', await create(f)), guard)).rejects.toMatchObject({ details: { resource_ids: [I] } });expect(writes(f)).toHaveLength(1);
  });
  it.each(['wrong_source', 'wrong_line', 'wrong_account', 'inactive', 'deleted', 'format', 'readback', 'parent_drift', 'source_drift', 'envelope', 'schema'] as const)('retains known IDs without retry when creation is unconfirmed: %s', async mode => {
    let created = false;const f = fixture({ handler: call => {
      if (call.init.method === 'POST') { created = true;if (mode === 'envelope') return { data: association, errors: [{ code: 'UNCERTAIN', message: 'sensitive native body' }] };if (mode === 'schema') return { data: { id: I } };return { data: { ...association, ...(mode === 'wrong_source' ? { account_media_id: 'other' } : mode === 'wrong_line' ? { line_item_id: 'other' } : mode === 'wrong_account' ? { account_id: 'other' } : mode === 'inactive' ? { entity_status: 'PAUSED' } : mode === 'deleted' ? { deleted: true } : mode === 'format' ? { creative_type: 'BANNER' } : {}) } }; }
      if (created && call.url.pathname.endsWith('/media_creatives/' + I)) return mode === 'readback' ? new Response('', { status: 403 }) : { data: association };
      if (created && mode === 'parent_drift' && call.url.pathname.endsWith('/line_items/' + L)) return { data: { ...line, daily_budget_amount_local_micro: 6_000_000 } };
      if (created && mode === 'source_drift' && call.url.pathname.endsWith('/account_media/' + S)) return { data: { ...asset, video_id: '13_771791717175468033' } };
      return undefined;
    } });
    const payload = await create(f);await expect(f.provider.applyWrite(operation('x_create_media_creative', payload), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: [I] } });expect(writes(f)).toHaveLength(1);
  });
  it('deletes only the association, checks an ACTIVE tombstone, and retains source and parent settings', async () => {
    const f = fixture({ associations: [association] }), current = await f.provider.directMedia.get(A, I), op = operation('x_delete_media_creative', { media_creative_id: I, expected_context_hash: current.context_hash });
    const preview = await f.provider.previewWrite(op, guard);expect(preview.notes?.join(' ')).toContain('not source deletion');expect(writes(f)).toEqual([]);
    expect(await f.provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: [I] });expect(writes(f).map(call => [call.init.method, call.url.pathname])).toEqual([['DELETE', `/12/accounts/${A}/media_creatives/${I}`]]);
    expect(f.associations[0]).toMatchObject({ deleted: true, entity_status: 'ACTIVE' });expect(f.source).toEqual(asset);expect(f.parent).toEqual(line);expect(f.funding).toEqual(campaign);
  });
  it('rejects stale deletion and retains the known ID when native absence/readback is unconfirmed', async () => {
    const f = fixture({ associations: [association] }), current = await f.provider.directMedia.get(A, I);f.associations[0]!.landing_url = 'https://changed.test';
    await expect(f.provider.previewWrite(operation('x_delete_media_creative', { media_creative_id: I, expected_context_hash: current.context_hash }), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(f)).toEqual([]);
    let deleted = false;const bad = fixture({ associations: [association], handler: call => { if (call.init.method === 'DELETE') { deleted = true;return { data: { ...association, deleted: true } }; }if (deleted && call.url.pathname.endsWith('/media_creatives/' + I)) return new Response('', { status: 404 });return undefined; } });
    const before = await bad.provider.directMedia.get(A, I);await expect(bad.provider.applyWrite(operation('x_delete_media_creative', { media_creative_id: I, expected_context_hash: before.context_hash }), guard)).rejects.toMatchObject({ details: { resource_ids: [I] } });expect(writes(bad)).toHaveLength(1);
  });
  it('uses the shared registry pending token and blocks protected-account and argument drift', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-x-direct-media-'));dirs.push(dir);const f = fixture(), payload = await create(f);
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: xTools(f.provider) }] });
    const args = { account_id: A, ...payload }, preview = await runtime.registry.call('x_create_media_creative', args, runtime.ctx);expect(preview).toMatchObject({ status: 'pending_validation' });expect(writes(f)).toEqual([]);
    const pending = (preview as { pending_operation_id: string }).pending_operation_id;
    const capped = await createContext({ engine: new PolicyEngine({ ...DEFAULT_POLICY, max_daily_budget_micros: 1_000_000 }, new PendingStore(join(dir, 'capped-pending')), new AuditLog(join(dir, 'capped-audit'))), providerModules: [{ provider: f.provider, tools: xTools(f.provider) }] });
    await expect(capped.registry.call('x_create_media_creative', args, capped.ctx)).rejects.toThrow(/cap|maximum|budget/i);expect(writes(f)).toEqual([]);
    await expect(runtime.registry.call('x_create_media_creative', { ...args, account_media_id: 'am2', pending_operation_id: pending }, runtime.ctx)).rejects.toThrow();expect(writes(f)).toEqual([]);
    expect(await runtime.registry.call('x_create_media_creative', { ...args, pending_operation_id: pending }, runtime.ctx)).toMatchObject({ status: 'applied', result: { resourceIds: [I] } });
    await expect(runtime.registry.call('x_create_media_creative', { ...args, pending_operation_id: pending }, runtime.ctx)).rejects.toThrow();expect(writes(f)).toHaveLength(1);
    const blocked = await createContext({ engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(join(dir, 'blocked-pending')), new AuditLog(join(dir, 'blocked-audit'))), providerModules: [{ provider: f.provider, tools: xTools(f.provider) }] });
    await expect(blocked.registry.call('x_delete_media_creative', { account_id: A, media_creative_id: I, expected_context_hash: (await f.provider.directMedia.get(A, I)).context_hash }, blocked.ctx)).rejects.toThrow(/protected/i);expect(writes(f)).toHaveLength(1);
  });
});
