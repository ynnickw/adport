import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AuditLog, createContext, creativesOutput, DEFAULT_POLICY, nextPageArguments, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';
import { createPrerollCta, nativePrerollCta, prerollCtaSelection, updatePrerollCta } from '../src/preroll-cta-schemas.js';

// Official xdevplatform/docs09e643bc, creatives/reference.mdx Preroll Call To
// Actions, refreshed2026-11-06: single writes use query parameters; partial PUT,
// account/line-item-scoped GET cursors and DELETE object tombstones.
const A = 'a1', L = 'l1', I = 'cta1', N = 'cta3';
const account = { id: A, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false };
const campaign = { id: 'c1', name: 'QA campaign', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null };
const line = { id: L, name: 'Preroll group', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['PUBLISHER_NETWORK'], product_type: 'MEDIA', objective: 'PREROLL_VIEWS', daily_budget_amount_local_micro: 5_000_000, total_budget_amount_local_micro: null };
type Cta = z.infer<typeof nativePrerollCta>;
const cta: Cta = { id: I, line_item_id: L, call_to_action: 'VISIT_SITE', call_to_action_url: 'https://example.test/original', deleted: false };
const selection = { line_item_id: L, call_to_action: 'SHOP' as const, call_to_action_url: 'http://example.test/über?q=A+B&ref=100%25#section' }, guard = { forcePausedCreation: true };
type Call = { url: URL; init: RequestInit };
type Options = { rows?: Cta[]; line?: Record<string, unknown>; campaign?: Record<string, unknown>; handler?(call: Call): unknown | Promise<unknown> };
function fixture(options: Options = {}) {
  const calls: Call[] = [], rows = structuredClone(options.rows ?? []), parent = { ...line, ...options.line }, funding = { ...campaign, ...options.campaign };
  const client = new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' }, async (raw, init = {}) => {
    const call = { url: new URL(String(raw)), init };calls.push(call);const custom = await options.handler?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const path = call.url.pathname.replace(`/12/accounts/${A}`, ''), q = call.url.searchParams, ok = (data: unknown) => Response.json({ data });
    if (init.method === 'GET') {
      if (!path) return ok(account);
      if (path === '/campaigns/c1') return ok(funding);
      if (path === '/line_items/' + L) return ok(parent);
      if (path === '/preroll_call_to_actions') { const active = rows.filter(row => q.get('with_deleted') === 'true' || !row.deleted), start = q.has('cursor') ? 1 : 0, count = Number(q.get('count') ?? 20);return Response.json({ data: active.slice(start, start + count), next_cursor: start + count < active.length ? 'p2' : null }); }
      if (path.startsWith('/preroll_call_to_actions/')) { const row = rows.find(row => row.id === path.split('/').at(-1));return row ? ok(row) : new Response('', { status: 404 }); }
    }
    if (path === '/preroll_call_to_actions' && init.method === 'POST') { const row = { id: N, line_item_id: q.get('line_item_id')!, call_to_action: q.get('call_to_action')!, call_to_action_url: q.get('call_to_action_url')!, deleted: false };rows.push(row);return ok(row); }
    const row = rows.find(row => row.id === path.split('/').at(-1));
    if (row && init.method === 'PUT') { for (const key of ['call_to_action', 'call_to_action_url'] as const) if (q.has(key)) row[key] = q.get(key)!;return ok(row); }
    if (row && init.method === 'DELETE') { row.deleted = true;return ok(row); }
    throw new Error(`Unexpected synthetic endpoint ${init.method} ${path}`);
  });
  return { provider: new XAdsProvider(client), calls, rows, parent, funding };
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.init.method !== 'GET');
const op = (tool: string, payload: Record<string, unknown>): WriteOperation => ({ provider: 'x', tool, accountId: A, kind: tool === 'x_create_preroll_cta' ? 'create' : tool === 'x_update_preroll_cta' ? 'update' : 'remove', payload });
async function creation(f: ReturnType<typeof fixture>) { return { ...selection, expected_context_hash: (await f.provider.prerollCtas.context(A, selection)).context_hash, acknowledge_ad_group_scope: true as const }; }
async function existing(f: ReturnType<typeof fixture>, changes: Record<string, unknown> = {}) { return { preroll_call_to_action_id: I, expected_context_hash: (await f.provider.prerollCtas.get(A, I)).context_hash, acknowledge_ad_group_scope: true as const, ...changes }; }
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('preroll CTA scope and native read contracts', () => {
  it.each([{ ...selection, call_to_action: 'BUY_NOW' }, { ...selection, call_to_action_url: 'javascript:alert(1)' }, { ...selection, call_to_action_url: 'https://user:secret@example.test' }, { ...selection, call_to_action_url: 'https://example.test/\nnext' }, { ...selection, line_item_id: 'l/other' }, { ...selection, media_creative_id: 'mc1' }])('rejects unsupported buttons, unsafe destinations and scope substitution %#', value => {
    expect(prerollCtaSelection.safeParse(value).success).toBe(false);
  });
  it('requires context and explicit group scope; partial edits cannot be empty', () => {
    expect(createPrerollCta.safeParse(selection).success).toBe(false);
    expect(createPrerollCta.safeParse({ ...selection, expected_context_hash: 'a'.repeat(64), acknowledge_ad_group_scope: false }).success).toBe(false);
    expect(updatePrerollCta.safeParse({ preroll_call_to_action_id: I, expected_context_hash: 'a'.repeat(64), acknowledge_ad_group_scope: true }).success).toBe(false);
  });
  it('pages one scoped group and gives guarded button/destination edits bound to complete context', async () => {
    const f = fixture({ rows: [cta, { ...cta, id: 'cta2' }] }), result = await f.provider.prerollCtas.list({ account_id: A, line_item_id: L, count: 1 });
    expect(creativesOutput.safeParse(result).success).toBe(true);expect(result).toMatchObject({ truncated: true, next_cursor: 'p2', creatives: [{ id: I, status: 'PRESENT', headlines: ['Visit site'], landing_urls: [cta.call_to_action_url], actions: [{ tool: 'x_update_preroll_cta', arguments: { account_id: A, preroll_call_to_action_id: I, acknowledge_ad_group_scope: true }, fields: [{ key: 'call_to_action', type: 'select', options: expect.arrayContaining([{ label: 'Watch now', value: 'WATCH_NOW' }]) }, { key: 'call_to_action_url', value: cta.call_to_action_url }] }, { tool: 'x_delete_preroll_cta' }] }] });
    expect(f.calls.filter(call => call.url.pathname.endsWith('/preroll_call_to_actions')).map(call => Object.fromEntries(call.url.searchParams))).toEqual([{ line_item_ids: L, count: '1', with_deleted: 'false' }, { line_item_ids: L, count: '200', with_deleted: 'false' }]);
    expect(nextPageArguments(xTools(f.provider).find(tool => tool.name === 'x_preroll_ctas')!, { account_id: A, line_item_id: L, count: 1 }, result)).toEqual({ account_id: A, line_item_id: L, count: 1, cursor: 'p2' });expect(writes(f)).toEqual([]);
  });
  it('browses an account without fanning out parent/context reads or exposing unverified edit actions', async () => {
    const f = fixture({ rows: [cta, { ...cta, id: 'cta2', line_item_id: 'l2' }] }), result = await f.provider.prerollCtas.list({ account_id: A });
    expect(creativesOutput.safeParse(result).success).toBe(true);expect(result.creatives).toHaveLength(2);expect(result.creatives.every(row => !row.actions.length)).toBe(true);
    expect(f.calls.map(call => call.url.pathname)).toEqual([`/12/accounts/${A}`, `/12/accounts/${A}/preroll_call_to_actions`]);expect(Object.fromEntries(f.calls[1]!.url.searchParams)).toEqual({ count: '20', with_deleted: 'false' });expect(writes(f)).toEqual([]);
  });
  it('does not offer button edits when the parent no longer supports preroll authoring', async () => {
    const f = fixture({ rows: [cta], line: { objective: 'VIDEO_VIEWS' } }), result = await f.provider.prerollCtas.get(A, I);
    expect(result.creatives[0]!.actions.map(action => action.tool)).toEqual(['x_delete_preroll_cta']);await expect(f.provider.previewWrite(op('x_update_preroll_cta', await existing(f, { call_to_action: 'SHOP' })), guard)).rejects.toThrow(/PREROLL_VIEWS/);expect(writes(f)).toEqual([]);
  });
  it.each(['account', 'group', 'deleted', 'duplicate', 'cursor', 'oversized'] as const)('rejects native page/filter contradictions: %s', async mode => {
    const row = { ...cta, ...(mode === 'account' ? { account_id: 'other' } : mode === 'group' ? { line_item_id: 'other' } : mode === 'deleted' ? { deleted: true } : {}) };
    const f = fixture({ handler: call => call.url.pathname.endsWith('/preroll_call_to_actions') ? { data: mode === 'duplicate' ? [row, row] : mode === 'oversized' ? [row, { ...row, id: 'cta2' }] : [row], next_cursor: mode === 'cursor' ? 'same' : null } : undefined });
    await expect(f.provider.prerollCtas.list({ account_id: A, line_item_id: L, ...(mode === 'oversized' ? { count: 1 } : mode === 'cursor' ? { cursor: 'same' } : {}) })).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
  it('retains a gallery without edit actions when full context cannot be established', async () => {
    const f = fixture({ rows: [cta], handler: call => call.url.pathname.endsWith('/preroll_call_to_actions') && call.url.searchParams.get('count') === '200' ? { data: [cta] } : undefined });
    const result = await f.provider.prerollCtas.list({ account_id: A, line_item_id: L });expect(result.creatives[0]!.actions).toEqual([]);expect(result.warnings.join(' ')).toContain('remain visible');
    await expect(f.provider.prerollCtas.get(A, I)).rejects.toThrow(/incomplete/);expect(writes(f)).toEqual([]);
  });
  it('reports missing page continuation without inventing a complete listing', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/preroll_call_to_actions') ? { data: [] } : undefined });
    const result = await f.provider.prerollCtas.list({ account_id: A, line_item_id: L });expect(result.truncated).toBe(true);expect(result.notes.join(' ')).toContain('unconfirmed');
  });
  it('keeps unknown native presets visible, omits unsafe links and never selects a replacement preset implicitly', async () => {
    const f = fixture({ rows: [{ ...cta, call_to_action: 'FUTURE_BUTTON', call_to_action_url: 'javascript:alert(1)' }] }), result = await f.provider.prerollCtas.get(A, I);
    expect(creativesOutput.safeParse(result).success).toBe(true);expect(result.creatives[0]!.landing_urls).toEqual([]);expect(result.creatives[0]!.headlines).toEqual(['FUTURE_BUTTON']);expect(result.creatives[0]!.actions[0]!.fields.map(field => field.key)).toEqual(['call_to_action_url']);
    expect((await f.provider.prerollCtas.list({ account_id: A, line_item_id: L, with_deleted: true })).creatives[0]!.status).toBe('PRESENT');
  });
  it('binds other CTA records and parent configuration, but ignores timestamps and scope echoes', async () => {
    const f = fixture({ rows: [cta, { ...cta, id: 'cta2' }] }), first = await f.provider.prerollCtas.get(A, I);Object.assign(f.rows[0]!, { updated_at: 'later', account_id: A });
    expect((await f.provider.prerollCtas.get(A, I)).context_hash).toBe(first.context_hash);f.rows[1]!.call_to_action_url = 'https://changed.test';expect((await f.provider.prerollCtas.get(A, I)).context_hash).not.toBe(first.context_hash);
    const next = await f.provider.prerollCtas.get(A, I);f.parent.daily_budget_amount_local_micro++;expect((await f.provider.prerollCtas.get(A, I)).context_hash).not.toBe(next.context_hash);
  });
  it.each(['id', 'account', 'inventory'] as const)('rejects exact-record contradictions: %s', async mode => {
    const f = fixture({ rows: [cta], handler: call => call.url.pathname.endsWith('/preroll_call_to_actions/' + I) ? { data: { ...cta, ...(mode === 'id' ? { id: 'other' } : mode === 'account' ? { account_id: 'other' } : { call_to_action_url: 'https://changed.test' }) } } : undefined });
    await expect(f.provider.prerollCtas.get(A, I)).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
  it('limits full context to ten advancing pages and rejects repeated cross-page IDs', async () => {
    let pages = 0;const overflow = fixture({ handler: call => call.url.pathname.endsWith('/preroll_call_to_actions') ? { data: [], next_cursor: `p${++pages}` } : undefined });
    await expect(overflow.provider.prerollCtas.context(A, selection)).rejects.toThrow(/incomplete/);expect(pages).toBe(10);expect(writes(overflow)).toEqual([]);
    const repeated = fixture({ handler: call => call.url.pathname.endsWith('/preroll_call_to_actions') ? { data: [cta], next_cursor: call.url.searchParams.has('cursor') ? null : 'p2' } : undefined });await expect(repeated.provider.prerollCtas.context(A, selection)).rejects.toThrow(/repeated/);
  });
  it.each(['objective', 'group_deleted', 'group_draft', 'campaign_deleted', 'campaign_draft', 'currency'] as const)('rejects ineligible authoring parents: %s', async mode => {
    const f = fixture({ line: mode === 'objective' ? { objective: 'VIDEO_VIEWS' } : mode === 'group_deleted' ? { deleted: true } : mode === 'group_draft' ? { entity_status: 'DRAFT' } : mode === 'currency' ? { currency: 'EUR' } : {}, campaign: mode === 'campaign_deleted' ? { deleted: true } : mode === 'campaign_draft' ? { entity_status: 'DRAFT' } : {} });
    await expect(f.provider.prerollCtas.context(A, selection)).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
});

describe('preroll CTA native writes and shared policy', () => {
  it('creates one scoped CTA using a signed query and independently checks record, inventory and parent', async () => {
    const f = fixture(), operation = op('x_create_preroll_cta', await creation(f)), preview = await f.provider.previewWrite(operation, guard);
    expect(preview.serverValidated).toBe(false);expect(preview.review?.fields).toContainEqual({ label: 'Scope', after: 'All preroll ads in this ad group' });expect(writes(f)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [N] });const request = writes(f)[0]!;
    expect(request.url.pathname).toBe(`/12/accounts/${A}/preroll_call_to_actions`);expect(Object.fromEntries(request.url.searchParams)).toEqual(selection);expect(request.init.body).toBeUndefined();expect(request.init.headers).toMatchObject({ Authorization: expect.stringContaining('oauth_signature=') });expect(request.url.href).not.toContain('+');
    expect(f.parent).toEqual(line);expect(f.funding).toEqual(campaign);expect(writes(f)).toHaveLength(1);
  });
  it('refuses implicit replacement and requires a paused group only for creation', async () => {
    const f = fixture({ rows: [cta] });await expect(f.provider.previewWrite(op('x_create_preroll_cta', await creation(f)), guard)).rejects.toThrow(/explicit CTA update/);expect(writes(f)).toEqual([]);
    const active = fixture({ line: { entity_status: 'ACTIVE' } }), args = await creation(active);await expect(active.provider.previewWrite(op('x_create_preroll_cta', args), guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect((await active.provider.previewWrite(op('x_create_preroll_cta', args), { forcePausedCreation: false })).review?.fields).toContainEqual({ label: 'Parent delivery', after: 'ACTIVE' });expect(writes(active)).toEqual([]);
  });
  it.each(['button', 'destination', 'both', 'unchanged_button'] as const)('sends only the actual partial PUT fields and preserves omitted configuration: %s', async mode => {
    const f = fixture({ rows: [cta, { ...cta, id: 'cta2' }], line: { entity_status: 'ACTIVE' } }), change = mode === 'button' ? { call_to_action: 'WATCH_NOW' } : mode === 'destination' ? { call_to_action_url: selection.call_to_action_url } : mode === 'both' ? { call_to_action: 'SHOP', call_to_action_url: selection.call_to_action_url } : { call_to_action: cta.call_to_action, call_to_action_url: selection.call_to_action_url };
    const operation = op('x_update_preroll_cta', await existing(f, change)), preview = await f.provider.previewWrite(operation, guard);expect(preview.review?.fields).toContainEqual({ label: 'Parent delivery', after: 'ACTIVE' });expect(writes(f)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [I] });const request = writes(f)[0]!;expect(request.init.method).toBe('PUT');expect(request.url.pathname).toBe(`/12/accounts/${A}/preroll_call_to_actions/${I}`);expect(Object.fromEntries(request.url.searchParams)).toEqual(mode === 'unchanged_button' ? { call_to_action_url: selection.call_to_action_url } : change);expect(request.init.body).toBeUndefined();
    expect(f.rows[0]).toEqual({ ...cta, ...change });expect(f.rows[1]).toEqual({ ...cta, id: 'cta2' });expect(f.parent.entity_status).toBe('ACTIVE');expect(f.funding).toEqual(campaign);expect(writes(f)).toHaveLength(1);
  });
  it('does not send an unchanged update, and preserves unknown native presets in URL-only edits', async () => {
    const f = fixture({ rows: [cta] });await expect(f.provider.previewWrite(op('x_update_preroll_cta', await existing(f, { call_to_action: cta.call_to_action })), guard)).rejects.toThrow(/change the CTA/);expect(writes(f)).toEqual([]);
    const unknown = fixture({ rows: [{ ...cta, call_to_action: 'FUTURE_BUTTON' }] });expect(await unknown.provider.applyWrite(op('x_update_preroll_cta', await existing(unknown, { call_to_action_url: 'https://next.test/' })), guard)).toEqual({ applied: true, resourceIds: [I] });expect(unknown.rows[0]!.call_to_action).toBe('FUTURE_BUTTON');expect(Object.fromEntries(writes(unknown)[0]!.url.searchParams)).toEqual({ call_to_action_url: 'https://next.test/' });
  });
  it.each(['current', 'other_cta', 'parent', 'request'] as const)('rejects context drift before mutation: %s', async mode => {
    const f = fixture({ rows: [cta] }), args = await existing(f, { call_to_action: 'SHOP' });
    if (mode === 'current') f.rows[0]!.call_to_action_url = 'https://changed.test';
    if (mode === 'other_cta') f.rows.push({ ...cta, id: 'cta2' });
    if (mode === 'parent') f.parent.daily_budget_amount_local_micro++;
    if (mode === 'request') { const empty = fixture(), creating = await creation(empty);await expect(empty.provider.previewWrite(op('x_create_preroll_cta', { ...creating, call_to_action_url: 'https://changed.test' }), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(empty)).toEqual([]);return; }
    await expect(f.provider.applyWrite(op('x_update_preroll_cta', args), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(f)).toEqual([]);
  });
  it.each(['account', 'group', 'button', 'url', 'deleted', 'schema', 'envelope', 'readback', 'parent', 'inventory'] as const)('preserves known create IDs without retry on uncertain native state: %s', async mode => {
    let written = false;const expected = { ...selection, id: N, deleted: false };
    const f = fixture({ handler: call => {
      if (call.init.method === 'POST') { written = true;if (mode === 'schema') return { data: { id: N } };if (mode === 'envelope') return { data: expected, errors: [{ message: 'private native details' }] };return { data: { ...expected, ...(mode === 'account' ? { account_id: 'other' } : mode === 'group' ? { line_item_id: 'other' } : mode === 'button' ? { call_to_action: 'GO_TO' } : mode === 'url' ? { call_to_action_url: 'https://wrong.test' } : mode === 'deleted' ? { deleted: true } : {}) } }; }
      if (written && call.url.pathname.endsWith('/preroll_call_to_actions/' + N)) return mode === 'readback' ? new Response('', { status: 403 }) : { data: expected };
      if (written && call.url.pathname.endsWith('/preroll_call_to_actions')) return { data: mode === 'inventory' ? [expected, { ...cta, id: 'cta2' }] : [expected], next_cursor: null };
      if (written && mode === 'parent' && call.url.pathname.endsWith('/line_items/' + L)) return { data: { ...line, daily_budget_amount_local_micro: 6_000_000 } };
      return undefined;
    } });
    await expect(f.provider.applyWrite(op('x_create_preroll_cta', await creation(f)), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: [N] } });expect(writes(f)).toHaveLength(1);
  });
  it('deletes only the CTA and verifies its tombstone plus retained settings without pausing ads', async () => {
    const f = fixture({ rows: [cta, { ...cta, id: 'cta2' }], line: { entity_status: 'ACTIVE' } }), operation = op('x_delete_preroll_cta', await existing(f));
    expect((await f.provider.previewWrite(operation, guard)).review?.fields).toContainEqual({ label: 'Parent delivery', after: 'ACTIVE' });expect(writes(f)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [I] });expect(writes(f).map(call => [call.init.method, call.url.pathname, Object.fromEntries(call.url.searchParams)])).toEqual([['DELETE', `/12/accounts/${A}/preroll_call_to_actions/${I}`, {}]]);expect(f.rows[0]).toEqual({ ...cta, deleted: true });expect(f.rows[1]).toEqual({ ...cta, id: 'cta2' });expect(f.parent.entity_status).toBe('ACTIVE');expect(f.funding).toEqual(campaign);
    const tombstone = await f.provider.prerollCtas.get(A, I);expect(tombstone.creatives[0]).toMatchObject({ status: 'DELETED', actions: [] });
  });
  it.each(['omitted_field', 'readback', 'other_cta', 'delete_receipt', 'delete_absence'] as const)('retains exact IDs and never replays unconfirmed edits/removal: %s', async mode => {
    let written = false;const deleting = mode.startsWith('delete');
    const f = fixture({ rows: [cta, { ...cta, id: 'cta2' }], handler: call => {
      if (call.init.method === 'PUT' || call.init.method === 'DELETE') { written = true;return { data: { ...cta, call_to_action: deleting ? 'VISIT_SITE' : 'SHOP', deleted: deleting, ...(mode === 'omitted_field' ? { call_to_action_url: 'https://unexpected.test' } : mode === 'delete_receipt' ? { id: 'other' } : {}) } }; }
      if (written && call.url.pathname.endsWith('/preroll_call_to_actions/' + I)) return mode === 'readback' || mode === 'delete_absence' ? new Response('', { status: 404 }) : { data: { ...cta, call_to_action: 'SHOP' } };
      if (written && call.url.pathname.endsWith('/preroll_call_to_actions')) return { data: [{ ...cta, call_to_action: 'SHOP' }, { ...cta, id: 'cta2', ...(mode === 'other_cta' ? { call_to_action_url: 'https://changed.test' } : {}) }], next_cursor: null };
      return undefined;
    } });
    await expect(f.provider.applyWrite(op(deleting ? 'x_delete_preroll_cta' : 'x_update_preroll_cta', await existing(f, deleting ? {} : { call_to_action: 'SHOP' })), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: mode === 'delete_receipt' ? [I, 'other'] : [I] } });expect(writes(f)).toHaveLength(1);
  });
  it('routes all three writes through pending tokens, exact arguments, caps, protected accounts and consume-once approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-x-cta-'));dirs.push(dir);const f = fixture(), modules = [{ provider: f.provider, tools: xTools(f.provider) }], pending = new PendingStore(join(dir, 'pending')), audit = new AuditLog(join(dir, 'audit')), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, pending, audit), providerModules: modules });
    const call = (name: string, args: Record<string, unknown>) => runtime.registry.call(name, args, runtime.ctx), args = { account_id: A, ...await creation(f) }, preview = await call('x_create_preroll_cta', args) as { pending_operation_id: string };expect(writes(f)).toEqual([]);
    const capped = await createContext({ engine: new PolicyEngine({ ...DEFAULT_POLICY, max_daily_budget_micros: 1_000_000 }, pending, audit), providerModules: modules });await expect(capped.registry.call('x_create_preroll_cta', args, capped.ctx)).rejects.toThrow(/cap|maximum|budget/i);
    await expect(call('x_create_preroll_cta', { ...args, call_to_action: 'WATCH_NOW', pending_operation_id: preview.pending_operation_id })).rejects.toThrow();expect(writes(f)).toEqual([]);
    await call('x_create_preroll_cta', { ...args, pending_operation_id: preview.pending_operation_id });expect(writes(f)).toHaveLength(1);await expect(call('x_create_preroll_cta', { ...args, pending_operation_id: preview.pending_operation_id })).rejects.toThrow();
    const mutation = async (tool: string, fields: Record<string, unknown>) => { const current = await f.provider.prerollCtas.get(A, N), input = { account_id: A, preroll_call_to_action_id: N, expected_context_hash: current.context_hash, acknowledge_ad_group_scope: true, ...fields }, before = writes(f).length, dry = await call(tool, input) as { pending_operation_id: string };expect(writes(f)).toHaveLength(before);await call(tool, { ...input, pending_operation_id: dry.pending_operation_id });expect(writes(f)).toHaveLength(before + 1); };
    await mutation('x_update_preroll_cta', { call_to_action: 'WATCH_NOW' });
    const protectedRuntime = await createContext({ engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, pending, audit), providerModules: modules });await expect(protectedRuntime.registry.call('x_delete_preroll_cta', { account_id: A, preroll_call_to_action_id: N, expected_context_hash: (await f.provider.prerollCtas.get(A, N)).context_hash, acknowledge_ad_group_scope: true }, protectedRuntime.ctx)).rejects.toThrow(/protected/i);expect(writes(f)).toHaveLength(2);
    await mutation('x_delete_preroll_cta', {});expect(writes(f).map(call => call.init.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });
});
