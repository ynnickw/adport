import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { PinterestAdsClient, PINTEREST_TOKEN_URL } from '../src/client.js';
import { PinterestAdsProvider } from '../src/provider.js';
import { pinterestTools } from '../src/tools.js';

// Pinterest-owned v5 OpenAPI5.28.0 audience/customer-list/website/sharing wire shapes,2026-11-04.
const A = '549000000001', C = '549000000002', G = '549000000003', U = '549000000004', S = '549000000005', L = '549000000006';
const audience = { id: U, ad_account_id: A, name: 'QA audience', description: 'Original', audience_type: 'VISITOR', rule: { visitor_source_id: ['9'], retention_days: 30, prefill: false }, status: 'INITIALIZING', size: null, is_nca: false };
const seed = { ...audience, id: S, audience_type: 'CUSTOMER_LIST', rule: { customer_list_id: L } };
const list = { id: L, ad_account_id: A, name: 'QA customer list', status: 'TOO_SMALL', is_nca: false, updated_time: 1793790000, num_batches: 1, num_uploaded_user_records: 1, num_removed_user_records: 0 };
const owner = { username: 'adport_qa' }, guard = { forcePausedCreation: true }, hashes = ['a'.repeat(64), 'b'.repeat(64)];
type Call = { url: URL; init: RequestInit };
const body = (call: Call) => JSON.parse(String(call.init.body));
const writes = (calls: Call[]) => calls.filter(c => c.init.method !== 'GET' && c.url.href !== PINTEREST_TOKEN_URL);
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ provider: 'pinterest', accountId: A, tool, payload, kind });
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture(handler?: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new PinterestAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === PINTEREST_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (init.method === 'GET') {
      const p = call.url.pathname;
      if (p === `/v5/ad_accounts/${A}`) return Response.json({ id: A, owner });
      if (p === '/v5/user_account') return Response.json(owner);
      if (p === '/v5/user_account/websites') return Response.json({ items: [{ website: 'https://owned.example', status: 'native-status', verified_at: '2026-11-04T00:00:00Z' }] });
      if (p.endsWith(`/audiences/${U}`)) return Response.json(audience);
      if (p.endsWith(`/audiences/${S}`)) return Response.json(seed);
      if (p.endsWith(`/customer_lists/${L}`)) return Response.json(list);
      if (p.endsWith('/customer_lists')) return Response.json({ items: [list] });
      if (p.endsWith('/audiences')) return Response.json({ items: [audience, seed] });
      if (p.endsWith('/ad_groups') || p.endsWith('/audiences/shared/accounts')) return Response.json({ items: [] });
      if (p.endsWith('/conversion_tags/9')) return Response.json({ id: '9', ad_account_id: A });
      if (p.endsWith(`/campaigns/${C}`)) return Response.json({ id: C, ad_account_id: A, status: 'PAUSED' });
      if (p.endsWith('/ads/7')) return Response.json({ id: '7', ad_account_id: A, campaign_id: C, ad_group_id: G });
      if (p.endsWith(`/ad_groups/${G}`)) return Response.json({ id: G, ad_account_id: A, campaign_id: C, status: 'PAUSED' });
    }
    throw new Error(`Unexpected ${init.method} ${call.url.pathname}`);
  });
  return { provider: new PinterestAdsProvider(client), calls };
}
const visitor = { audience_type: 'VISITOR', visitor_source_ids: ['9'], retention_days: 30, prefill: false };

describe('Pinterest audiences and customer sources', () => {
  it('registers one lazy shared catalog, validates typed rules and rejects raw identifiers', () => {
    const tools = pinterestTools(new Proxy({} as PinterestAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(new Set(tools.map(t => t.name)).size).toBe(tools.length); expect(tools.filter(t => t.name === 'pinterest_audiences')).toHaveLength(1);
    const tool = tools.find(t => t.name === 'pinterest_create_customer_list')!;
    expect(tool.input.safeParse({ account_id: A, name: 'QA', records_sha256: hashes, confirm_data_rights: true }).success).toBe(true);
    for (const input of [{ account_id: A, name: 'QA', records_sha256: ['someone@example.com'], confirm_data_rights: true }, { account_id: A, name: 'QA', records_sha256: hashes }, { account_id: A, name: 'QA', records_sha256: [hashes[0], hashes[0]], confirm_data_rights: true }]) expect(tool.input.safeParse(input).success).toBe(false);
    const create = tools.find(t => t.name === 'pinterest_create_audience')!;
    expect(create.input.safeParse({ account_id: A, name: 'QA', definition: visitor }).success).toBe(true);
    expect(create.input.safeParse({ account_id: A, name: 'QA', definition: { ...visitor, prefill: undefined } }).success).toBe(false);
  });
  it('labels received ownership, uses exact filters and refuses shared/missing-owner writes', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/audiences') ? { items: [{ ...audience, ad_account_id: S }], bookmark: 'next' } : undefined);
    const data = await provider.audiences.list({ account_id: A, ownership_type: 'RECEIVED', page_size: 50, bookmark: 'before' });
    expect(data.items[0]?.owned_by_advertiser).toBe(false); expect(data.next_cursor).toBe('next'); expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ ownership_type: 'RECEIVED', page_size: '50', bookmark: 'before' });
    for (const override of [{ ad_account_id: S }, { ad_account_id: undefined }, { id: S }]) {
      const wrong = fixture(call => call.url.pathname.endsWith(`/audiences/${U}`) ? { ...audience, ...override } : undefined);
      await expect(wrong.provider.audiences.get(A, U)).rejects.toThrow('ownership'); expect(writes(wrong.calls)).toEqual([]);
    }
  });
  it('binds edit widgets to native audience snapshots while processing count/status changes do not invalidate copy', async () => {
    let changed = false;
    const { provider } = fixture(call => call.url.pathname.endsWith(`/audiences/${U}`) ? { ...audience, ...(changed ? { status: 'READY', size: 500 } : {}) } : undefined);
    const before = await provider.audiences.get(A, U); changed = true;
    expect((await provider.audiences.get(A, U)).snapshot_hash).toBe(before.snapshot_hash);
    expect(before.creatives[0]?.actions[0]).toMatchObject({ tool: 'pinterest_update_audience', arguments: { account_id: A, audience_id: U, expected_snapshot_hash: before.snapshot_hash } });
  });
  it('creates VISITOR rules with explicit prefill/native source operators and owned tag checks', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { ...audience, ...body(call) } : undefined);
    const operation = op('pinterest_create_audience', { name: audience.name, definition: { ...visitor, event: 'pagevisit', event_source: ['web'], ingestion_source: ['tag'], url: ['https://owned.example/qa'] } });
    const preview = await provider.previewWrite(operation, guard); expect(preview.serverValidated).toBe(false); expect(writes(calls)).toEqual([]);
    expect((await provider.applyWrite(operation, guard)).resourceIds).toEqual([U]);
    expect(body(writes(calls)[0]!)).toEqual({ ad_account_id: A, name: audience.name, audience_type: 'VISITOR', rule: { visitor_source_id: ['9'], retention_days: 30, prefill: false, event: 'pagevisit', event_source: { '=': ['web'] }, ingestion_source: { '=': ['tag'] }, url: ['https://owned.example/qa'] } });
    expect(calls.some(c => c.url.pathname.includes('/user_account'))).toBe(false);
    const foreign = fixture(call => call.url.pathname.endsWith('/conversion_tags/9') ? { id: '9', ad_account_id: S } : undefined);
    await expect(foreign.provider.previewWrite(operation, guard)).rejects.toThrow('not owned'); expect(writes(foreign.calls)).toEqual([]);
  });
  it('creates CUSTOMER_LIST and ACTALIKE only from current owned source snapshots, preserving long IDs as strings', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { ...audience, ...body(call), rule: { ...body(call).rule, ...(body(call).audience_type === 'ACTALIKE' ? { percentage: String(body(call).rule.percentage) } : {}) } } : undefined);
    const source = await provider.audiences.getCustomerList(A, L), seedRead = await provider.audiences.get(A, S);
    await provider.applyWrite(op('pinterest_create_audience', { name: 'Customer QA', definition: { audience_type: 'CUSTOMER_LIST', customer_list_id: L, expected_source_hash: source.snapshot_hash } }), guard);
    await provider.applyWrite(op('pinterest_create_audience', { name: 'Actalike QA', definition: { audience_type: 'ACTALIKE', seeds: [{ audience_id: S, expected_snapshot_hash: seedRead.snapshot_hash }], country: 'US', percentage: 3 } }), guard);
    expect(body(writes(calls)[0]!).rule).toEqual({ customer_list_id: L }); expect(body(writes(calls)[1]!).rule).toEqual({ seed_id: [S], country: 'US', percentage: 3 });
    await expect(provider.previewWrite(op('pinterest_create_audience', { name: 'Stale', definition: { audience_type: 'ACTALIKE', seeds: [{ audience_id: S, expected_snapshot_hash: '0'.repeat(64) }], country: 'US', percentage: 3 } }), guard)).rejects.toThrow('seed audience'); expect(writes(calls)).toHaveLength(2);
  });
  it('keeps engagement websites token-owner scoped and passes only verified-owned campaign/ad references', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { ...audience, ...body(call) } : undefined);
    const operation = op('pinterest_create_audience', { name: 'Engagement QA', definition: { audience_type: 'ENGAGEMENT', engagement_domains: ['owned.example'], campaign_ids: [C], ad_ids: ['7'], engagement_type: 'save', engager_type: 1, retention_days: 30 } });
    await provider.applyWrite(operation, guard);
    expect(body(writes(calls)[0]!).rule).toEqual({ engagement_domain: ['owned.example'], campaign_id: [C], ad_id: ['7'], engagement_type: 'save', engager_type: 1, retention_days: 30 });
    const delegated = fixture(call => call.url.pathname === '/v5/user_account' ? { username: 'other-owner' } : undefined);
    await expect(delegated.provider.previewWrite(operation, guard)).rejects.toThrow('website inventory'); expect(writes(delegated.calls)).toEqual([]); expect(delegated.calls.some(c => c.url.pathname.endsWith('/websites'))).toBe(false);
    const wrongDomain = fixture(); await expect(wrongDomain.provider.previewWrite(op('pinterest_create_audience', { name: 'Wrong', definition: { audience_type: 'ENGAGEMENT', engagement_domains: ['unowned.example'] } }), guard)).rejects.toThrow('website inventory');
  });
  it('PATCHes only supplied audience copy, preserves rules/type, and detects stale or altered receipts', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { ...audience, ...body(call) } : undefined), current = await provider.audiences.get(A, U);
    const operation = op('pinterest_update_audience', { audience_id: U, expected_snapshot_hash: current.snapshot_hash, description: null }, 'update');
    expect((await provider.previewWrite(operation, guard)).fieldChanges).toEqual([{ field: 'Description', before: 'Original', after: '(cleared)' }]); expect(writes(calls)).toEqual([]);
    await provider.applyWrite(operation, guard); expect(body(writes(calls)[0]!)).toEqual({ operation_type: 'UPDATE', description: null });
    const mismatch = fixture(call => call.init.method === 'PATCH' ? { ...audience, ...body(call), audience_type: 'ACTALIKE' } : undefined);
    await expect(mismatch.provider.applyWrite(operation, guard)).rejects.toMatchObject({ details: { resource_ids: [U] } }); expect(writes(mismatch.calls)).toHaveLength(1);
    await expect(provider.previewWrite(op('pinterest_update_audience', { audience_id: U, expected_snapshot_hash: '0'.repeat(64), name: 'Wrong' }, 'update'), guard)).rejects.toThrow('changed');
  });
  it('scans target/derived audience usage and both sharing account types using native query shapes', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/ad_groups') ? { items: [{ id: G, ad_account_id: A, targeting_spec: { AUDIENCE_EXCLUDE: [U] } }] } : call.url.pathname.endsWith('/audiences') ? { items: [audience, { ...seed, audience_type: 'ACTALIKE', rule: { seed_id: [U] } }] } : call.url.pathname.endsWith('/audiences/shared/accounts') && call.url.searchParams.get('account_type') === 'BUSINESS_ACCOUNT' ? { items: [{ account_id: S, account_type: 'BUSINESS_ACCOUNT' }] } : undefined);
    const result = await provider.audiences.usage(A, U);
    expect(result.references).toMatchObject([{ kind: 'ad_group', id: G, targeting_dimensions: ['AUDIENCE_EXCLUDE'] }, { kind: 'derived_audience', id: S }]); expect(result.shared_accounts).toHaveLength(1); expect(result.scan_complete).toBe(true);
    expect(calls.find(c => c.url.pathname.endsWith('/ad_groups'))!.url.searchParams.get('entity_statuses')).toBe('ACTIVE,PAUSED,ARCHIVED,DRAFT,DELETED_DRAFT');
    expect(calls.filter(c => c.url.pathname.endsWith('/audiences/shared/accounts')).map(c => Object.fromEntries(c.url.searchParams))).toEqual([{ audience_id: U, account_type: 'AD_ACCOUNT', page_size: '100' }, { audience_id: U, account_type: 'BUSINESS_ACCOUNT', page_size: '100' }]);
    await expect(provider.previewWrite(op('pinterest_remove_audience', { audience_id: U, expected_context_hash: result.context_hash, confirm_permanent_removal: true }, 'remove'), guard)).rejects.toThrow('references'); expect(writes(calls)).toEqual([]);
  });
  it('replaces a complete same-type rule through usage context while preserving copy and native source defaults', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { ...audience, ...body(call), rule: { ...body(call).rule, native_default: true } } : undefined), context = await provider.audiences.usage(A, U);
    await provider.applyWrite(op('pinterest_replace_audience_rule', { audience_id: U, expected_snapshot_hash: context.snapshot_hash, expected_context_hash: context.context_hash, definition: { ...visitor, retention_days: 60 } }, 'update'), guard);
    expect(body(writes(calls)[0]!)).toEqual({ operation_type: 'UPDATE', rule: { visitor_source_id: ['9'], retention_days: 60, prefill: false } });
    const wrong = fixture(call => call.init.method === 'PATCH' ? { ...audience, ...body(call), name: 'Unexpected rename' } : undefined);
    await expect(wrong.provider.applyWrite(op('pinterest_replace_audience_rule', { audience_id: U, expected_snapshot_hash: context.snapshot_hash, expected_context_hash: context.context_hash, definition: visitor }, 'update'), guard)).rejects.toMatchObject({ details: { resource_ids: [U] } });
  });
  it('rejects changed usage context and foreign or incomplete inventory before removal', async () => {
    const { provider, calls } = fixture(), context = await provider.audiences.usage(A, U);
    await expect(provider.previewWrite(op('pinterest_remove_audience', { audience_id: U, expected_context_hash: '0'.repeat(64), confirm_permanent_removal: true }, 'remove'), guard)).rejects.toThrow('usage changed'); expect(writes(calls)).toEqual([]);
    const foreign = fixture(call => call.url.pathname.endsWith('/audiences') ? { items: [{ ...seed, ad_account_id: S }] } : undefined);
    await expect(foreign.provider.audiences.usage(A, U)).rejects.toThrow('foreign');
    let page = 0;
    const large = fixture(call => call.url.pathname.endsWith('/ad_groups') ? { items: [{ id: String(100 + page++), ad_account_id: A }], bookmark: `page${page}` } : undefined);
    const incomplete = await large.provider.audiences.usage(A, U); expect(incomplete.scan_complete).toBe(false);
    await expect(large.provider.previewWrite(op('pinterest_remove_audience', { audience_id: U, expected_context_hash: incomplete.context_hash, confirm_permanent_removal: true }, 'remove'), guard)).rejects.toThrow('incomplete'); expect(writes(large.calls)).toEqual([]);
    expect(context.scan_complete).toBe(true);
  });
  it('binds targeting roles and serving statuses while excluding an owner’s own account from external sharing', async () => {
    let active = false;
    const { provider } = fixture(call => call.url.pathname.endsWith('/ad_groups') ? { items: [{ id: G, ad_account_id: A, status: active ? 'ACTIVE' : 'PAUSED', targeting_spec: active ? { AUDIENCE_INCLUDE: [U] } : { AUDIENCE_EXCLUDE: [U] } }] } : call.url.pathname.endsWith('/audiences/shared/accounts') && call.url.searchParams.get('account_type') === 'AD_ACCOUNT' ? { items: [{ account_id: A, account_type: 'AD_ACCOUNT' }] } : undefined);
    const original = await provider.audiences.usage(A, U); expect(original.shared_accounts).toEqual([]); active = true;
    const next = await provider.audiences.usage(A, U); expect(next.context_hash).not.toBe(original.context_hash); expect(next.snapshot_hash).toBe(original.snapshot_hash);
    await expect(provider.previewWrite(op('pinterest_replace_audience_rule', { audience_id: U, expected_snapshot_hash: original.snapshot_hash, expected_context_hash: original.context_hash, definition: visitor }, 'update'), guard)).rejects.toThrow('usage changed');
  });
  it('does not treat missing or malformed targeting/derived-source data as proof of unused audiences', async () => {
    const missing = fixture(call => call.url.pathname.endsWith('/ad_groups') ? { items: [{ id: G, ad_account_id: A }] } : undefined);
    expect((await missing.provider.audiences.usage(A, U)).scan_complete).toBe(false);
    const derived = fixture(call => call.url.pathname.endsWith('/audiences') ? { items: [audience, { ...seed, audience_type: 'ACTALIKE', rule: {} }] } : undefined);
    expect((await derived.provider.audiences.usage(A, U)).scan_complete).toBe(false);
    const malformed = fixture(call => call.url.pathname.endsWith('/ad_groups') ? { items: [{ id: G, ad_account_id: A, targeting_spec: { AUDIENCE_INCLUDE: U } }] } : undefined);
    await expect(malformed.provider.audiences.usage(A, U)).rejects.toThrow('could not be inspected');
  });
  it('uses native PATCH REMOVE, never HTTP DELETE or a parent/delivery mutation', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? audience : undefined), context = await provider.audiences.usage(A, U);
    await provider.applyWrite(op('pinterest_remove_audience', { audience_id: U, expected_context_hash: context.context_hash, confirm_permanent_removal: true }, 'remove'), guard);
    expect(writes(calls)).toHaveLength(1); expect(writes(calls)[0]!.url.pathname).toBe(`/v5/ad_accounts/${A}/audiences/${U}`); expect(writes(calls)[0]!.init.method).toBe('PATCH'); expect(body(writes(calls)[0]!)).toEqual({ operation_type: 'REMOVE' });
  });
  it('uploads exact pre-hashed CSV records, keeps expanded matching false by default and previews no identifiers', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { ...list, ...body(call) } : undefined), operation = op('pinterest_create_customer_list', { name: list.name, records_sha256: hashes, confirm_data_rights: true });
    const preview = await provider.previewWrite(operation, guard); expect(JSON.stringify(preview)).not.toContain(hashes[0]); expect(preview.changes.join(' ')).toContain('2 unique'); expect(writes(calls)).toEqual([]);
    expect((await provider.applyWrite(operation, guard)).resourceIds).toEqual([L]); expect(body(writes(calls)[0]!)).toEqual({ name: list.name, list_type: 'EMAIL', is_nca: false, records: hashes.join(',') });
  });
  it('redacts unexpected records and native exception contents from source metadata reads', async () => {
    const { provider } = fixture(call => call.url.pathname.endsWith(`/customer_lists/${L}`) ? { ...list, records: hashes.join(','), records_v2: [{ email: 'private@example.com' }], exceptions: { raw_record: hashes[0] } } : undefined);
    const current = await provider.audiences.getCustomerList(A, L); expect(current.has_exceptions).toBe(true); expect(JSON.stringify(current)).not.toContain(hashes[0]); expect(JSON.stringify(current)).not.toContain('private@example.com');
  });
  it('binds membership writes to native batch counters and omits list type/name/matching mode from PATCH', async () => {
    let changed = false;
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/customer_lists/${L}`) ? { ...list, ...(changed ? { num_batches: 2, updated_time: list.updated_time + 1 } : {}) } : undefined), current = await provider.audiences.getCustomerList(A, L);
    const operation = op('pinterest_update_customer_list_records', { customer_list_id: L, expected_snapshot_hash: current.snapshot_hash, operation_type: 'REMOVE', records_sha256: hashes, confirm_data_rights: true }, 'update');
    await provider.applyWrite(operation, guard); expect(body(writes(calls)[0]!)).toEqual({ operation_type: 'REMOVE', records: hashes.join(',') });
    changed = true; await expect(provider.previewWrite(operation, guard)).rejects.toThrow('batches or metadata changed'); expect(writes(calls)).toHaveLength(1);
  });
  it('withholds native error text that reflects identifiers and never retries a rejected customer-list mutation', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? new Response(JSON.stringify({ message: `Bad record ${hashes[0]}`, code: 12 }), { status: 400 }) : undefined);
    let failure: unknown; try { await provider.applyWrite(op('pinterest_create_customer_list', { name: 'QA', records_sha256: hashes, confirm_data_rights: true }), guard); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ details: { http_status: 400 } }); expect(JSON.stringify(failure)).not.toContain(hashes[0]); expect(String(failure)).not.toContain(hashes[0]); expect(writes(calls)).toHaveLength(1);
  });
  it('keeps audience registry writes subject to preview/apply, account protection and single-use approval', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { ...audience, ...body(call) } : undefined), current = await provider.audiences.get(A, U);
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-pinterest-audiences-')); dirs.push(dir);
    const runtime = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))) });
    const input = { account_id: A, audience_id: U, expected_snapshot_hash: current.snapshot_hash, name: 'Renamed QA' };
    const preview = await runtime.registry.call('pinterest_update_audience', input, runtime.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]);
    await runtime.registry.call('pinterest_update_audience', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    await expect(runtime.registry.call('pinterest_update_audience', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow(); expect(writes(calls)).toHaveLength(1);
    const blocked = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(dir, 'blocked')), new AuditLog(path.join(dir, 'blocked-audit'))) });
    await expect(blocked.registry.call('pinterest_update_audience', input, blocked.ctx)).rejects.toThrow('protected'); expect(writes(calls)).toHaveLength(1);
  });
  it('preserves count/digest-only customer previews through the shared widget review adapter', async () => {
    const { provider, calls } = fixture();
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-pinterest-record-review-')); dirs.push(dir);
    const runtime = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))) });
    const result = await runtime.registry.call('pinterest_create_customer_list', { account_id: A, name: 'QA records', records_sha256: hashes, confirm_data_rights: true }, runtime.ctx) as { preview: unknown };
    expect(JSON.stringify(result.preview)).not.toContain(hashes[0]); expect(JSON.stringify(result.preview)).not.toContain(hashes[1]); expect(JSON.stringify(result.preview)).toContain('2 records'); expect(writes(calls)).toEqual([]);
  });
});
