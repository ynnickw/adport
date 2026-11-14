import { createContext, DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it, vi } from 'vitest';
import { MetaGraphClient } from '../src/client.js';
import { MetaAdsProvider } from '../src/provider.js';
import { metaTools } from '../src/tools.js';

// Outgoing contracts checked against official meta/facebook-python-business-sdk:
// v25.0.3@542e10e31c40f7925f9ac03c000922a2fd0a2365 and v26.0.3@99b5e2db19e60e63f753154b36dad684cbbd3088,
// adaccount.py customconversions, customconversion.py node CRUD/stats and customconversionstatsresult.py.
// Fixtures below are contract tests, not recordings of successful native requests.
const account = '1234', conversionId = '701', pixel = '901', guard = { forcePausedCreation: true };
const rule = JSON.stringify({ url: { i_contains: '/thanks' } });
const initial = { id: conversionId, account_id: account, name: 'Registration', description: 'Original', rule, advanced_rule: '', custom_event_type: 'COMPLETE_REGISTRATION', default_conversion_value: 100, pixel: { id: pixel, name: 'Pixel' }, action_source_type: 'website', event_source_type: 'PIXEL', is_archived: false, is_unavailable: false };
const operation = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'meta', accountId: account, kind, payload });
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));
function setup(respond?: (url: URL, init: RequestInit) => unknown, version = 'v25.0') {
  const state = { conversion: structuredClone(initial) as Record<string, unknown>, references: [] as Record<string, unknown>[], deleted: false };
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(raw)); calls.push({ url, init });
    const override = respond?.(url, init);
    if (override !== undefined) return override instanceof Response ? override : Response.json(override);
    if (url.pathname.endsWith('/adspixels')) return Response.json({ data: [{ id: pixel, name: 'Pixel' }] });
    if (url.pathname.endsWith('/adsets')) return Response.json({ data: state.references });
    if (url.pathname.endsWith('/customconversions')) {
      if (init.method === 'POST') { state.conversion = { ...state.conversion, ...form(init), default_conversion_value: Number(form(init).default_conversion_value ?? 100) };return Response.json({ id: conversionId }); }
      return Response.json({ data: state.deleted ? [] : [state.conversion] });
    }
    if (url.pathname === `/${version}/${conversionId}`) {
      if (init.method === 'POST') { Object.assign(state.conversion, form(init));return Response.json({ success: true }); }
      if (init.method === 'DELETE') { state.deleted = true;return Response.json({ success: true }); }
      return Response.json(state.conversion);
    }
    throw new Error(`Unexpected fixture endpoint ${url.pathname}`);
  });
  return { state, calls, provider: new MetaAdsProvider(new MetaGraphClient({ accessToken: 'inert-fixture' }, version, fetcher as typeof fetch)), writes: () => calls.filter(call => call.init.method !== 'GET') };
}
const create = { name: 'QA conversion', description: 'No events', event_source_id: pixel, rule, custom_event_type: 'COMPLETE_REGISTRATION' };

describe('Meta custom-conversion lifecycle', () => {
  it('defines each typed workflow once and keeps specialist access and strict immutable-field validation', () => {
    const tools = metaTools(setup().provider), conversions = tools.filter(tool => /custom_conversion/.test(tool.name));
    expect(conversions).toHaveLength(7);expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
    for (const tool of conversions) expect(tool.catalog).toEqual({ category: 'measurement', exposure: 'specialist' });
    expect(conversions.find(tool => tool.name === 'meta_create_custom_conversion')!.annotations).toMatchObject({ readOnly: false, destructive: false });
    const update = conversions.find(tool => tool.name === 'meta_update_custom_conversion')!;
    for (const input of [{ rule }, { event_source_id: pixel }, { is_archived: true }, {}]) expect(update.input.safeParse({ account_id: account, conversion_id: conversionId, expected_snapshot_hash: 'a'.repeat(64), acknowledge_shared_effects: true, ...input }).success).toBe(false);
    expect(update.input.safeParse({ account_id: account, conversion_id: conversionId, expected_snapshot_hash: 'a'.repeat(64), name: 'Changed' }).success).toBe(false);
  });
  it.each(['v25.0', 'v26.0'])('previews locally and creates using official %s form fields with independent readback', async version => {
    const { provider, calls, writes } = setup(undefined, version), op = operation('meta_create_custom_conversion', { ...create, default_conversion_value: 1.25 }, 'create');
    const preview = await provider.previewWrite(op, guard);
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [], review: { kind: 'create', title: 'Create custom conversion', fields: expect.arrayContaining([{ label: 'Pixel', after: pixel }, { label: 'Rule', after: rule }]) } });
    expect(writes()).toHaveLength(0);
    const result = await provider.applyWrite(op, guard);
    expect(result).toMatchObject({ applied: true, resourceIds: [conversionId], details: { conversion: { name: create.name, pixel: { id: pixel } }, requested_default_conversion_value: 1.25, reported_default_conversion_value: 1.25 } });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.url.pathname).toBe(`/${version}/act_${account}/customconversions`);
    expect(form(writes()[0]!.init)).toEqual({ ...create, default_conversion_value: '1.25', action_source_type: 'website' });
    expect(writes()[0]!.init.headers).toMatchObject({ authorization: 'Bearer inert-fixture', 'content-type': 'application/x-www-form-urlencoded' });
    expect(calls.at(-1)!.url.pathname).toBe(`/${version}/${conversionId}`);
  });
  it.each(['[]', '{}', 'not JSON', '{"id":9007199254740993}', JSON.stringify({ deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: true } } } } } } } } } } } } })])('rejects unsafe rule %s before native access', async invalid => {
    const { provider, calls } = setup();
    await expect(provider.previewWrite(operation('meta_create_custom_conversion', { ...create, rule: invalid }, 'create'), guard)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('requires the event-source Pixel in the selected account rather than trusting a numeric source ID', async () => {
    const { provider, writes } = setup(url => url.pathname.endsWith('/adspixels') ? { data: [{ id: '999' }] } : undefined);
    await expect(provider.previewWrite(operation('meta_create_custom_conversion', create, 'create'), guard)).rejects.toThrow('pixel inventory');expect(writes()).toHaveLength(0);
  });
  it('lists owned configurations with fixed-edge continuation and does not expose next-URL tokens', async () => {
    const { provider, calls } = setup(url => url.pathname.endsWith('/customconversions') ? { data: [initial], ...(url.searchParams.has('after') ? {} : { paging: { next: `https://graph.facebook.com/v25.0/act_${account}/customconversions?after=next-one&access_token=never-return&fields=other` } }) } : undefined);
    const first = await provider.conversions.list({ account_id: `act_${account}`, limit: 1 });
    expect(first).toMatchObject({ conversions: [initial], truncated: true, next_cursor: 'next-one', records: [{ id: conversionId, name: initial.name, status: 'Configured', source: pixel }] });
    expect(JSON.stringify(first)).not.toContain('never-return');
    await provider.conversions.list({ account_id: account, limit: 1, cursor: first.next_cursor });
    expect(calls.at(-1)!.url.searchParams.get('after')).toBe('next-one');expect(calls.at(-1)!.url.searchParams.has('access_token')).toBe(false);
    const tool = metaTools(provider).find(tool => tool.name === 'meta_list_custom_conversions')!;expect(tool.output!.safeParse(first).success).toBe(true);
  });
  it.each([
    'https://untrusted.example/v25.0/act_1234/customconversions?after=a',
    'https://graph.facebook.com/v25.0/act_999/customconversions?after=a',
    'https://graph.facebook.com/v26.0/act_1234/customconversions?after=a',
  ])('rejects unsafe pagination %s without following it', async next => {
    const { provider, calls } = setup(() => ({ data: [initial], paging: { next } }));
    await expect(provider.conversions.list({ account_id: account, limit: 1 })).rejects.toThrow('pagination');expect(calls).toHaveLength(1);
  });
  it('keeps event timestamps and Pixel names out of snapshots but binds configuration and source identity', async () => {
    const { provider, state } = setup(), first = await provider.conversions.get(account, conversionId);
    Object.assign(state.conversion, { first_fired_time: '2026-10-01T00:00:00Z', last_fired_time: '2026-11-01T00:00:00Z', pixel: { id: pixel, name: 'New source name' } });
    expect((await provider.conversions.get(account, conversionId)).snapshot_hash).toBe(first.snapshot_hash);
    state.conversion.rule = '{"url":{"i_contains":"/elsewhere"}}';expect((await provider.conversions.get(account, conversionId)).snapshot_hash).not.toBe(first.snapshot_hash);
    state.conversion.account_id = '999';await expect(provider.conversions.get(account, conversionId)).rejects.toThrow('selected ad account');
  });
  it('rejects repeated list cursors and duplicate IDs instead of claiming another usable page', async () => {
    for (const response of [{ data: [initial, initial] }, { data: [initial], paging: { next: 'https://graph.facebook.com/v25.0/act_1234/customconversions?after=again' } }]) {
      const { provider } = setup(() => response);
      await expect(provider.conversions.list({ account_id: account, limit: 2, cursor: 'again' })).rejects.toThrow('repeated');
    }
  });
  it('rejects mismatched IDs, unsafe numeric IDs and foreign shared conversions', async () => {
    for (const override of [{ id: '702' }, { id: 9007199254740992 }, { account_id: '999' }]) {
      const { provider } = setup(() => ({ ...initial, ...override }));await expect(provider.conversions.get(account, conversionId)).rejects.toThrow();
    }
  });
  it('updates only supplied metadata, preserves immutable settings, and binds the preview to the current snapshot', async () => {
    const { provider, state, writes } = setup(), current = await provider.conversions.get(account, conversionId);
    const op = operation('meta_update_custom_conversion', { conversion_id: conversionId, expected_snapshot_hash: current.snapshot_hash, acknowledge_shared_effects: true, description: '' });
    expect(await provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false, review: { kind: 'update', fields: [{ label: 'description', before: 'Original', after: '' }] } });expect(writes()).toHaveLength(0);
    state.conversion.name = 'Changed elsewhere';await expect(provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes()).toHaveLength(0);
    state.conversion.name = initial.name;
    await expect(provider.applyWrite(op, guard)).resolves.toMatchObject({ details: { conversion: { description: '', rule, name: initial.name } } });
    expect(form(writes()[0]!.init)).toEqual({ description: '' });
  });
  it.each([{ is_archived: true }, { is_unavailable: true }, { is_archived: undefined }])('refuses edits when native state is not explicitly available: %j', async changed => {
    const { provider, state, writes } = setup();Object.assign(state.conversion, changed);
    const current = await provider.conversions.get(account, conversionId);
    await expect(provider.previewWrite(operation('meta_update_custom_conversion', { conversion_id: conversionId, expected_snapshot_hash: current.snapshot_hash, acknowledge_shared_effects: true, name: 'Changed' }), guard)).rejects.toThrow('unarchived and available');expect(writes()).toHaveLength(0);
  });
  it('reports native default request/read differences instead of guessing a cents or currency conversion', async () => {
    const { provider, state } = setup((_url, init) => { if (init.method === 'POST') { state.conversion.default_conversion_value = 125;return { success: true }; } });
    const current = await provider.conversions.get(account, conversionId), op = operation('meta_update_custom_conversion', { conversion_id: conversionId, expected_snapshot_hash: current.snapshot_hash, acknowledge_shared_effects: true, default_conversion_value: 1.25 });
    await expect(provider.applyWrite(op, guard)).resolves.toMatchObject({ warnings: [expect.stringContaining('equivalence are unverified')], details: { requested_default_conversion_value: 1.25, reported_default_conversion_value: 125 } });
  });
  it('does not claim a metadata update when readback silently changed immutable rules', async () => {
    const { provider, state, writes } = setup((_url, init) => { if (init.method === 'POST') { Object.assign(state.conversion, { name: 'New', rule: '{"url":{"i_contains":"/wrong"}}' });return { success: true }; } });
    const current = await provider.conversions.get(account, conversionId);
    await expect(provider.applyWrite(operation('meta_update_custom_conversion', { conversion_id: conversionId, expected_snapshot_hash: current.snapshot_hash, acknowledge_shared_effects: true, name: 'New' }), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resourceIds: [conversionId] } });expect(writes()).toHaveLength(1);
  });
  it('preserves native permission denial and never retries the mutation', async () => {
    const { provider, writes } = setup((_url, init) => init.method === 'POST' ? Response.json({ error: { code: 200, message: 'Permission denied' } }, { status: 403 }) : undefined);
    await expect(provider.applyWrite(operation('meta_create_custom_conversion', create, 'create'), guard)).rejects.toThrow('Permission denied');expect(writes()).toHaveLength(1);
  });
  it('retains a returned creation ID when readback fails and does not repeat the POST', async () => {
    let created = false;
    const { provider, writes } = setup((url, init) => {
      if (init.method === 'POST') { created = true;return { id: conversionId }; }
      if (created && url.pathname.endsWith(`/${conversionId}`)) return Response.json({ error: { code: 100, message: 'Unavailable' } }, { status: 400 });
    });
    await expect(provider.applyWrite(operation('meta_create_custom_conversion', create, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: [conversionId] }, message: expect.stringContaining('not replayed') });expect(writes()).toHaveLength(1);
  });
  it('does not fabricate a resource ID for an uncertain creation response', async () => {
    const { provider, writes } = setup((_url, init) => init.method === 'POST' ? { success: true } : undefined);
    await expect(provider.applyWrite(operation('meta_create_custom_conversion', create, 'create'), guard)).rejects.toThrow('did not return a custom-conversion ID');expect(writes()).toHaveLength(1);
  });
  it('retains the known creation ID when Meta returns a different source or rule', async () => {
    const { provider, writes } = setup((url, init) => init.method === 'POST' ? { id: conversionId } : url.pathname.endsWith(`/${conversionId}`) ? { ...initial, name: create.name, description: create.description, pixel: { id: '999' } } : undefined);
    await expect(provider.applyWrite(operation('meta_create_custom_conversion', create, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: [conversionId] }, message: expect.stringContaining('differs from the approved') });expect(writes()).toHaveLength(1);
  });
  it('exposes all selected-account references and refuses deletion, including paused/archived ad sets', async () => {
    const { provider, state, calls, writes } = setup();
    state.references = [{ id: '800', account_id: account, status: 'ARCHIVED', promoted_object: { custom_conversion_id: conversionId } }];
    const usage = await provider.conversions.usage(account, conversionId);
    expect(usage).toMatchObject({ references: [{ id: '800', status: 'ARCHIVED' }], scan_complete: true });
    expect(JSON.parse(calls.find(call => call.url.pathname.endsWith('/adsets'))!.url.searchParams.get('effective_status')!)).toContain('ARCHIVED');
    await expect(provider.previewWrite(operation('meta_delete_custom_conversion', { conversion_id: conversionId, expected_context_hash: usage.context_hash, acknowledge_shared_effects: true }, 'remove'), guard)).rejects.toThrow('visible ad-set references');expect(writes()).toHaveLength(0);
  });
  it('rechecks usage at apply and rejects a newly attached ad set before deletion', async () => {
    const { provider, state, writes } = setup(), usage = await provider.conversions.usage(account, conversionId);
    const op = operation('meta_delete_custom_conversion', { conversion_id: conversionId, expected_context_hash: usage.context_hash, acknowledge_shared_effects: true }, 'remove');
    expect(await provider.previewWrite(op, guard)).toMatchObject({ review: { kind: 'remove' }, serverValidated: false });
    state.references = [{ id: '800', account_id: account, promoted_object: { custom_conversion_id: conversionId } }];
    await expect(provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes()).toHaveLength(0);
  });
  it('marks a 50-page usage scan incomplete and refuses to delete', async () => {
    const { provider, writes } = setup(url => {
      if (!url.pathname.endsWith('/adsets')) return;
      const page = Number(url.searchParams.get('after') ?? 0);
      return { data: [{ id: String(1000 + page), account_id: account }], paging: { next: `https://graph.facebook.com/v25.0/act_${account}/adsets?after=${page + 1}` } };
    });
    const usage = await provider.conversions.usage(account, conversionId);expect(usage.scan_complete).toBe(false);
    await expect(provider.previewWrite(operation('meta_delete_custom_conversion', { conversion_id: conversionId, expected_context_hash: usage.context_hash, acknowledge_shared_effects: true }, 'remove'), guard)).rejects.toThrow('incomplete usage scan');expect(writes()).toHaveLength(0);
  });
  it.each([
    { data: [{ id: '800', account_id: '999' }] },
    { data: [{ id: '800', account_id: account, promoted_object: { custom_conversion_id: 9007199254740992 } }] },
    { data: [{ id: '800', account_id: account }, { id: '800', account_id: account }] },
  ])('rejects unsafe usage context before mutation: %j', async response => {
    const { provider, writes } = setup(url => url.pathname.endsWith('/adsets') ? response : undefined);
    await expect(provider.conversions.usage(account, conversionId)).rejects.toThrow();expect(writes()).toHaveLength(0);
  });
  it('rejects a repeated usage cursor within its bounded scan', async () => {
    let page = 0;
    const { provider } = setup(url => url.pathname.endsWith('/adsets') ? { data: [{ id: String(800 + page++), account_id: account }], paging: { next: 'https://graph.facebook.com/v25.0/act_1234/adsets?after=again' } } : undefined);
    await expect(provider.conversions.usage(account, conversionId)).rejects.toThrow('repeated');expect(page).toBe(2);
  });
  it.each(['absent', 'archived'])('verifies native deletion as %s without promising historical erasure', async outcome => {
    let deleted = false;
    const { provider, writes } = setup((url, init) => {
      if (init.method === 'DELETE') { deleted = true;return { success: true }; }
      if (deleted && url.pathname.endsWith('/customconversions')) return { data: outcome === 'absent' ? [] : [{ ...initial, is_archived: true }] };
    });
    const usage = await provider.conversions.usage(account, conversionId);
    await expect(provider.applyWrite(operation('meta_delete_custom_conversion', { conversion_id: conversionId, expected_context_hash: usage.context_hash, acknowledge_shared_effects: true }, 'remove'), guard)).resolves.toMatchObject({ resourceIds: [conversionId], details: { deletion_readback: outcome === 'absent' ? 'ABSENT_FROM_COMPLETE_ACCOUNT_INVENTORY' : 'ARCHIVED', historical_reporting_may_be_retained: true } });
    expect(writes()).toHaveLength(1);expect(writes()[0]!.init).toMatchObject({ method: 'DELETE', body: undefined });
  });
  it('does not accept an ambiguous node 400 as deletion proof', async () => {
    const { provider, writes } = setup((url, init) => init.method === 'DELETE' ? true : url.pathname.endsWith('/customconversions') ? Response.json({ error: { code: 100 } }, { status: 400 }) : undefined);
    const usage = await provider.conversions.usage(account, conversionId);
    await expect(provider.applyWrite(operation('meta_delete_custom_conversion', { conversion_id: conversionId, expected_context_hash: usage.context_hash, acknowledge_shared_effects: true }, 'remove'), guard)).rejects.toMatchObject({ details: { resourceIds: [conversionId] }, message: expect.stringContaining('inventory readback failed') });expect(writes()).toHaveLength(1);
  });
  it('does not claim verified deletion while the complete account inventory still has an active definition', async () => {
    const { provider, writes } = setup((_url, init) => init.method === 'DELETE' ? true : undefined);
    const usage = await provider.conversions.usage(account, conversionId);
    await expect(provider.applyWrite(operation('meta_delete_custom_conversion', { conversion_id: conversionId, expected_context_hash: usage.context_hash, acknowledge_shared_effects: true }, 'remove'), guard)).rejects.toMatchObject({ details: { resourceIds: [conversionId] }, message: expect.stringContaining('unconfirmed') });expect(writes()).toHaveLength(1);
  });
  it('preserves native stats values and time filters, validates ownership first and never invents zero counts', async () => {
    const stats = { aggregation: 'count', data: [{ value: '12345678901234567890', dimension: 'native' }], timestamp: '2026-11-01T00:00:00+0000' };
    const { provider, calls, state } = setup(url => url.pathname.endsWith('/stats') ? { data: [stats] } : undefined);
    const args = { account_id: account, conversion_id: conversionId, aggregation: 'count' as const, start_time: '2026-10-01T00:00:00Z', end_time: '2026-11-01T00:00:00Z', limit: 50 };
    expect(await provider.conversions.stats(args)).toMatchObject({ stats: [stats], truncated: false });
    expect(calls[0]!.url.pathname).toBe(`/v25.0/${conversionId}`);expect(calls[1]!.url.searchParams.get('start_time')).toBe(args.start_time);
    state.conversion.account_id = '999';await expect(provider.conversions.stats(args)).rejects.toThrow('selected ad account');expect(calls.filter(call => call.url.pathname.endsWith('/stats'))).toHaveLength(1);
    expect(metaTools(provider).find(tool => tool.name === 'meta_custom_conversion_stats')!.input.safeParse({ ...args, start_time: args.end_time }).success).toBe(false);
  });
  it('uses the shared policy token, rejects changed arguments and records the successful preview/apply', async () => {
    const { provider, writes } = setup(), pending = new Map<string, PendingOperation>(), audit = vi.fn(async () => {});
    const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(key) { return pending.get(key); }, async delete(key) { pending.delete(key); }, async consume(key, expectedHash) { const value = pending.get(key);return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(key); } }, { append: audit });
    const runtime = await createContext({ engine, providerModules: [{ provider, tools: metaTools(provider) }] });
    const args = { account_id: account, ...create };
    const preview = await runtime.registry.call('meta_create_custom_conversion', args, runtime.ctx) as { pending_operation_id: string; applied: boolean };
    expect(preview.applied).toBe(false);expect(writes()).toHaveLength(0);
    await expect(runtime.registry.call('meta_create_custom_conversion', { ...args, name: 'Other', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await expect(runtime.registry.call('meta_create_custom_conversion', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).resolves.toMatchObject({ applied: true, result: { resourceIds: [conversionId] } });expect(writes()).toHaveLength(1);expect(audit).toHaveBeenCalled();
  });
});
