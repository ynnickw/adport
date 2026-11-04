import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, reviewWrite, type WriteOperation } from '@adport/core';
import { PinterestAdsClient, PINTEREST_TOKEN_URL } from '../src/client.js';
import { PinterestAdsProvider } from '../src/provider.js';
import { pinterestTools } from '../src/tools.js';

// Native headers, paths, queries and bodies checked against Pinterest-owned OpenAPI5.28.0
// and the current Conversions API guide2026-11-04. No provider credentials or real customer data.
const A = '549000000001', T = '549000000002', F = '549000000003', guard = { forcePausedCreation: true };
const ownedTag = { id: T, ad_account_id: A, name: 'QA tag', status: 'ACTIVE', configs: { aem_enabled: false }, last_fired_time_ms: 100 };
const e = { action_source: 'web', event_id: 'synthetic-event-identifier', event_name: 'checkout', event_time: 1700000000, user_data: { em: ['a'.repeat(64)] }, event_source_url: 'https://example.test/order/private-order', custom_data: { order_id: 'private-order-id', currency: 'EUR', value: '1.2300' } };
type Call = { url: URL; init: RequestInit };
const body = (call: Call) => JSON.parse(String(call.init.body));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture(handler?: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new PinterestAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === PINTEREST_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.url.pathname === `/v5/ad_accounts/${A}`) return Response.json({ id: A, name: 'QA advertiser', currency: 'EUR' });
    if (call.url.pathname.endsWith('/conversion_tags') && init.method === 'GET') return Response.json({ items: [ownedTag] });
    if (call.url.pathname.endsWith(`/conversion_tags/${T}`)) return Response.json(ownedTag);
    throw new Error(`Unexpected ${init.method} ${call.url.pathname}`);
  });
  return { provider: new PinterestAdsProvider(client), calls };
}
const writes = (calls: Call[]) => calls.filter(c => c.init.method !== 'GET' && c.url.href !== PINTEREST_TOKEN_URL);
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ provider: 'pinterest', accountId: A, tool, payload, kind });
async function eventsInput(provider: PinterestAdsProvider, extra: Record<string, unknown> = {}) { return { expected_context_hash: (await provider.measurement.context(A)).snapshot_hash, confirm_data_rights: true, data: [e], ...extra }; }
const sent = (processed = 1) => ({ num_events_received: 1, num_events_processed: processed, events: [{ status: processed ? 'processed' : 'failed' }] });

describe('Pinterest conversion tags and measurement reads', () => {
  it('defines shared lazy tools exactly once with honest read/write hints', () => {
    const tools = pinterestTools(new Proxy({} as PinterestAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(new Set(tools.map(v => v.name)).size).toBe(tools.length);
    expect(tools.filter(t => t.name === 'pinterest_conversion_tags')).toHaveLength(1);
    expect(tools.find(t => t.name === 'pinterest_create_conversion_tag')?.annotations).toMatchObject({ readOnly: false, destructive: false });
    expect(tools.find(t => t.name === 'pinterest_send_conversion_events')?.annotations).toMatchObject({ readOnly: false });
    expect(tools.find(t => t.name === 'pinterest_conversion_tag_page_visits')?.pagination).toEqual({ cursorInput: 'bookmark' });
  });
  it('reads native unpaged tags using filter_deleted and verifies advertiser ownership', async () => {
    const { provider, calls } = fixture();
    expect(await provider.measurement.tags(A, true)).toMatchObject({ account_id: A, items: [ownedTag], truncated: false });
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ filter_deleted: 'true' });
    expect(await provider.measurement.getTag(A, T)).toEqual(ownedTag); expect(writes(calls)).toEqual([]);
  });
  it.each([{ items: [{ ...ownedTag, ad_account_id: F }] }, { items: [ownedTag, ownedTag] }])('rejects foreign or duplicate tags %#', async response => {
    const { provider } = fixture(call => call.url.pathname.endsWith('/conversion_tags') ? response : undefined);
    await expect(provider.measurement.tags(A)).rejects.toThrow();
  });
  it.each([{ ...ownedTag, id: F }, { ...ownedTag, ad_account_id: F }])('rejects mismatched single-tag identity %#', async response => {
    const { provider } = fixture(call => call.url.pathname.endsWith(`/conversion_tags/${T}`) ? response : undefined);
    await expect(provider.measurement.getTag(A, T)).rejects.toThrow();
  });
  it('excludes volatile firing times from the context hash and rejects account mismatch', async () => {
    let time = 100;
    const { provider } = fixture(call => call.url.pathname.endsWith('/conversion_tags') ? { items: [{ ...ownedTag, last_fired_time_ms: time++ }] } : undefined);
    expect((await provider.measurement.context(A)).snapshot_hash).toBe((await provider.measurement.context(A)).snapshot_hash);
    const foreign = fixture(call => call.url.pathname === `/v5/ad_accounts/${A}` ? { id: F } : undefined);
    await expect(foreign.provider.measurement.context(A)).rejects.toThrow('account ID');
  });
  it('keeps context hashes stable across native object-key and tag ordering changes', async () => {
    let reverse = false;
    const { provider } = fixture(call => {
      if (!call.url.pathname.endsWith('/conversion_tags')) return undefined;
      const rows = [{ ...ownedTag, configs: reverse ? { md_frequency: 1, aem_enabled: false } : { aem_enabled: false, md_frequency: 1 } }, { ...ownedTag, id: F, name: 'Second tag' }];
      return { items: reverse ? rows.reverse() : rows };
    });
    const before = await provider.measurement.context(A); reverse = true;
    expect((await provider.measurement.context(A)).snapshot_hash).toBe(before.snapshot_hash);
  });
  it('parses the native account-keyed OCPM mapping rather than inventing an items envelope', async () => {
    const event = { ad_account_id: A, conversion_tag_id: T, conversion_event: 'CHECKOUT' };
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/ocpm_eligible') ? { [A]: [event] } : undefined);
    expect(await provider.measurement.eligible(A)).toEqual({ account_id: A, events: [event] }); expect(writes(calls)).toEqual([]);
    const foreign = fixture(call => call.url.pathname.endsWith('/ocpm_eligible') ? { [F]: [event] } : undefined);
    await expect(foreign.provider.measurement.eligible(A)).rejects.toThrow('another advertiser');
  });
  it('preserves optional native event metadata and bookmark pagination without inventing identities', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/page_visit') ? { items: [{ conversion_tag_id: T }], bookmark: 'next' } : undefined);
    expect(await provider.measurement.visits({ account_id: A, page_size: 5, bookmark: 'before', order: 'DESCENDING' })).toMatchObject({ items: [{ conversion_tag_id: T }], next_cursor: 'next', truncated: true });
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ page_size: '5', bookmark: 'before', order: 'DESCENDING' });
  });
  it.each([{ items: [], bookmark: 'next' }, { items: [{}], bookmark: 'same' }, { items: [{}, {}] }, { items: [{ ad_account_id: F }] }])('rejects nonadvancing/oversized/foreign event pages %#', async response => {
    const { provider } = fixture(call => call.url.pathname.endsWith('/page_visit') ? response : undefined);
    await expect(provider.measurement.visits({ account_id: A, page_size: 1, bookmark: 'same', order: 'ASCENDING' })).rejects.toThrow();
  });
  it('returns native EQS components and filters without calculating a recommendation score', async () => {
    const row = { overall_status: 'GOOD', lookback_period: '14d', source_platform: 'WEB', ingestion_source: 'CONVERSIONS_API', quality_components: { hashed_email: { checkout: { coverage: 0.9, overlap: 0.5, issues: [] } } } };
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/conversion_eqs') ? [row] : undefined);
    expect(await provider.measurement.quality({ account_id: A, lookback_period: '14d', source_platform: 'WEB', ingestion_source: 'CONVERSIONS_API' })).toEqual({ account_id: A, items: [row] });
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ lookback_period: '14d', source_platform: 'WEB', ingestion_source: 'CONVERSIONS_API' });
    await expect(provider.measurement.quality({ account_id: A, lookback_period: '1d' })).rejects.toThrow('filters');
  });
  it('creates a tag with every enhanced-match flag explicitly false, no installed code, and no preview POST', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { id: F, ad_account_id: A, name: 'New QA tag' } : undefined);
    const input = { name: 'New QA tag', expected_context_hash: (await provider.measurement.context(A)).snapshot_hash };
    const preview = await provider.previewWrite(op('pinterest_create_conversion_tag', input), guard);
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [] }); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(op('pinterest_create_conversion_tag', input), guard)).toEqual({ applied: true, resourceIds: [F] });
    expect(body(writes(calls)[0]!)).toEqual({ name: 'New QA tag', aem_db_enabled: false, aem_enabled: false, aem_external_id_enabled: false, aem_fnln_enabled: false, aem_ge_enabled: false, aem_loc_enabled: false, aem_ph_enabled: false, md_frequency: 1 });
    expect(writes(calls)[0]!.init.headers).toMatchObject({ authorization: 'Bearer access', 'content-type': 'application/json' });
  });
  it('requires enhanced-match consent and forwards documented frequency without an invented maximum', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { id: F, ad_account_id: A, name: 'New', configs: { aem_enabled: true, md_frequency: 3 } } : undefined);
    const input = { name: 'New', aem_enabled: true, md_frequency: 3, expected_context_hash: (await provider.measurement.context(A)).snapshot_hash };
    await expect(provider.previewWrite(op('pinterest_create_conversion_tag', input), guard)).rejects.toThrow('consent'); expect(writes(calls)).toEqual([]);
    await provider.applyWrite(op('pinterest_create_conversion_tag', { ...input, confirm_enhanced_match_consent: true }), guard);
    expect(body(writes(calls)[0]!)).toMatchObject({ aem_enabled: true, md_frequency: 3 });
  });
  it('blocks duplicate tags, stale context and wrong operation kinds before mutation', async () => {
    const { provider, calls } = fixture(), context = await provider.measurement.context(A);
    await expect(provider.previewWrite(op('pinterest_create_conversion_tag', { name: 'QA TAG', expected_context_hash: context.snapshot_hash }), guard)).rejects.toThrow('already exists');
    await expect(provider.previewWrite(op('pinterest_create_conversion_tag', { name: 'New', expected_context_hash: '0'.repeat(64) }), guard)).rejects.toThrow('context changed');
    await expect(provider.previewWrite(op('pinterest_create_conversion_tag', {}, 'update'), guard)).rejects.toThrow('kind'); expect(writes(calls)).toEqual([]);
  });
  it('retains returned tag IDs on an uncertain creation and never retries', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { ...ownedTag, id: F, name: 'Different' } : undefined);
    await expect(provider.applyWrite(op('pinterest_create_conversion_tag', { name: 'New', expected_context_hash: (await provider.measurement.context(A)).snapshot_hash }), guard)).rejects.toMatchObject({ details: { resource_ids: [F] } }); expect(writes(calls)).toHaveLength(1);
  });
});

describe('Pinterest guarded conversion-event ingestion', () => {
  it('defaults to native test mode, forwards exact decimal strings and returns safe per-index receipts', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/events') ? sent() : undefined), input = await eventsInput(provider);
    const preview = await provider.previewWrite(op('pinterest_send_conversion_events', input), guard);
    expect(preview.serverValidated).toBe(false); expect(writes(calls)).toEqual([]);
    const result = await provider.applyWrite(op('pinterest_send_conversion_events', input), guard);
    expect(writes(calls)).toHaveLength(1); expect(writes(calls)[0]!.url.search).toBe('?test=true'); expect(body(writes(calls)[0]!)).toEqual({ data: [e] });
    expect(result).toMatchObject({ applied: true, resourceIds: [], details: { status: 'COMPLETE', mode: 'TEST', num_events_processed: 1, rows: [{ index: 0, status: 'processed', has_error: false, has_warning: false }] } }); expect(result.warnings?.join(' ')).toContain('not recorded');
    for (const value of [preview, reviewWrite(op('pinterest_send_conversion_events', input), preview), result]) for (const secret of [e.event_id, e.user_data.em[0]!, e.event_source_url, e.custom_data.order_id]) expect(JSON.stringify(value)).not.toContain(secret);
    expect(JSON.stringify(preview)).not.toContain('resultDetails'); expect(JSON.stringify(preview)).not.toContain('resultWarnings');
  });
  it('requires explicit data rights and live confirmation before sending real-mode events', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/events') ? sent() : undefined);
    for (const extra of [{ confirm_data_rights: false }, { test: false }]) await expect(provider.previewWrite(op('pinterest_send_conversion_events', await eventsInput(provider, extra)), guard)).rejects.toThrow();
    expect(writes(calls)).toEqual([]);
    const input = await eventsInput(provider, { test: false, confirm_live_events: true });
    const preview = await provider.previewWrite(op('pinterest_send_conversion_events', input), guard); expect(preview.notes?.join(' ')).toContain('Live events');
    await provider.applyWrite(op('pinterest_send_conversion_events', input), guard); expect(writes(calls)[0]!.url.search).toBe('?test=false');
  });
  it.each([
    { ...e, user_data: { em: ['unhashed@example.test'] } }, { ...e, user_data: { external_id: ['a'.repeat(64)] } },
    { ...e, user_data: { client_ip_address: '192.0.2.1' } }, { ...e, user_data: { client_ip_address: '0.0.0.0', client_user_agent: 'synthetic' } },
    { ...e, event_time: 9999999999999 }, { ...e, custom_data: { value: '1.2' } }, { ...e, custom_data: { value: 1.2, currency: 'EUR' } },
    { ...e, event_name: 'invalid name' }, { ...e, device_info: { network_type: '5g' } }, { ...e, app_info: { window_width: 40000 } },
    { ...e, event_source_url: 'https://name:password@example.test/' }, { ...e, unsupported: true },
  ])('rejects invalid/unhashed/misleading conversion payloads before any POST %#', async invalid => {
    const { provider, calls } = fixture();
    await expect(provider.previewWrite(op('pinterest_send_conversion_events', await eventsInput(provider, { data: [invalid] })), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it('supports mobile/offline matching and custom events, preserving native app/device fields', async () => {
    const data = [
      { ...e, action_source: 'app_ios', event_name: 'Custom_Action-1', user_data: { hashed_maids: ['b'.repeat(64)], ph: ['c'.repeat(64)] }, app_info: { app_id: 'synthetic-app', window_width: 100 }, device_info: { network_type: 'cellular_5g', os_family: 'ios', form_factor: 'cellphone', battery_level: 100, languages: ['en'] } },
      { ...e, event_id: 'offline-event', action_source: 'offline', user_data: { client_ip_address: '2001:db8::1', client_user_agent: 'synthetic-test-client' }, custom_data: { currency: 'USD', value: '0.001', predicted_ltv: '2.500', opt_out_type: 'LDP,OTHER', contents: [{ id: 'sku', item_price: '0.001', quantity: 1 }] } },
    ];
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/events') ? { num_events_received: 2, num_events_processed: 2, events: [{ status: 'processed' }, { status: 'processed' }] } : undefined);
    await provider.applyWrite(op('pinterest_send_conversion_events', await eventsInput(provider, { data })), guard);
    expect(body(writes(calls)[0]!)).toEqual({ data });
  });
  it('rejects duplicate stable IDs and batches outside the native1–1000 bound', async () => {
    const { provider, calls } = fixture();
    for (const data of [[], [e, e], Array.from({ length: 1001 }, (_, i) => ({ ...e, event_id: String(i) }))]) await expect(provider.previewWrite(op('pinterest_send_conversion_events', await eventsInput(provider, { data })), guard)).rejects.toThrow();
    expect(writes(calls)).toEqual([]);
  });
  it('reports partial outcomes without exposing native echoed identifiers or retrying failed rows', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/events') ? { num_events_received: 2, num_events_processed: 1, events: [{ status: 'processed', warning_message: e.event_source_url }, { status: 'failed', error_message: e.user_data.em[0] }] } : undefined);
    const result = await provider.applyWrite(op('pinterest_send_conversion_events', await eventsInput(provider, { data: [e, { ...e, event_id: 'second-private-id' }] })), guard);
    expect(result.details).toMatchObject({ status: 'PARTIAL_OR_UNCONFIRMED', num_events_processed: 1, failed_count: 1, rows: [{ index: 0, status: 'processed', has_warning: true }, { index: 1, status: 'failed', has_error: true }] });
    expect(result.warnings?.join(' ')).toContain('1 of 2'); expect(JSON.stringify(result)).not.toContain(e.event_source_url); expect(JSON.stringify(result)).not.toContain(e.user_data.em[0]); expect(writes(calls)).toHaveLength(1);
  });
  it.each([sent(0), { ...sent(), num_events_processed: 0 }, { ...sent(), num_events_received: 2 }, { ...sent(), events: [] }, { events: [{}] }])('fails honestly on zero success, contradictory counts or malformed receipts %#', async response => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/events') ? response : undefined);
    await expect(provider.applyWrite(op('pinterest_send_conversion_events', await eventsInput(provider)), guard)).rejects.toThrow(); expect(writes(calls)).toHaveLength(1);
  });
  it.each([400, 401, 403, 429, 500])('sanitizes native HTTP%s failures and never automatically replays POST', async status => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/events') ? Response.json({ code: 42, message: `Reflected ${e.user_data.em[0]} ${e.event_source_url}` }, { status }) : undefined);
    const error = await provider.applyWrite(op('pinterest_send_conversion_events', await eventsInput(provider)), guard).catch(error => error);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { status: 'UNCONFIRMED', http_status: status, record_count: 1 } });
    expect(JSON.stringify(error)).not.toContain(e.user_data.em[0]); expect(error.message).not.toContain(e.event_source_url); expect(writes(calls)).toHaveLength(1);
  });
  it('uses one-use policy approval, rejects changed arguments/protected accounts, and writes only safe audit summaries', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/events') ? sent() : undefined), input = { account_id: A, ...await eventsInput(provider) };
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-pinterest-measurement-')); dirs.push(dir);
    const runtime = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))) });
    const preview = await runtime.registry.call('pinterest_send_conversion_events', input, runtime.ctx) as { pending_operation_id: string };
    await expect(runtime.registry.call('pinterest_send_conversion_events', { ...input, data: [{ ...e, event_id: 'changed' }], pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
    // A mismatch can consume approval. Obtain a distinct fresh preview for the authorized exact arguments.
    const fresh = await runtime.registry.call('pinterest_send_conversion_events', input, runtime.ctx) as { pending_operation_id: string };
    await runtime.registry.call('pinterest_send_conversion_events', { ...input, pending_operation_id: fresh.pending_operation_id }, runtime.ctx);
    await expect(runtime.registry.call('pinterest_send_conversion_events', { ...input, pending_operation_id: fresh.pending_operation_id }, runtime.ctx)).rejects.toThrow(); expect(writes(calls)).toHaveLength(1);
    const audit = (await Promise.all((await readdir(path.join(dir, 'audit'))).map(file => readFile(path.join(dir, 'audit', file), 'utf8')))).join('');
    for (const value of [e.event_id, e.event_source_url, e.user_data.em[0]!, e.custom_data.order_id]) expect(audit).not.toContain(value);
    const blocked = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(dir, 'blocked')), new AuditLog(path.join(dir, 'blocked-audit'))) });
    await expect(blocked.registry.call('pinterest_send_conversion_events', input, blocked.ctx)).rejects.toThrow('protected'); expect(writes(calls)).toHaveLength(1);
  });
});
