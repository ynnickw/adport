import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { PinterestAdsClient, PINTEREST_TOKEN_URL } from '../src/client.js';
import { PinterestAdsProvider } from '../src/provider.js';
import { pinterestTools } from '../src/tools.js';

// Request/response shapes verified against Pinterest-owned v5 OpenAPI5.28.0 on2026-11-04.
const A = '549000000001', C = '549000000002', G = '549000000003', K = '383791336903426391';
const campaign = { id: C, ad_account_id: A, name: 'QA campaign', status: 'PAUSED' }, group = { id: G, ad_account_id: A, campaign_id: C, name: 'QA group', status: 'PAUSED' };
const row = { id: K, parent_id: G, parent_type: 'ad_group', value: 'private qa keyword', match_type: 'EXACT', archived: false, bid: null };
const parent = { type: 'ad_group' as const, ad_group_id: G }, guard = { forcePausedCreation: true };
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
    if (call.url.pathname === `/v5/ad_accounts/${A}`) return Response.json({ id: A });
    if (call.url.pathname.endsWith(`/campaigns/${C}`)) return Response.json(campaign);
    if (call.url.pathname.endsWith(`/ad_groups/${G}`)) return Response.json(group);
    if (call.url.pathname.endsWith('/keywords') && init.method === 'GET') return Response.json({ items: [row] });
    throw new Error(`Unexpected ${init.method} ${call.url.pathname}`);
  });
  return { provider: new PinterestAdsProvider(client), calls };
}
const writes = (calls: Call[]) => calls.filter(c => c.init.method !== 'GET' && c.url.href !== PINTEREST_TOKEN_URL);
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ provider: 'pinterest', accountId: A, tool, payload, kind });

describe('Pinterest keyword ownership, native lifecycle and planning', () => {
  it('builds one lazy tool catalog and rejects deprecated bids, duplicate entries and positive account/campaign keywords', () => {
    const tools = pinterestTools(new Proxy({} as PinterestAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(new Set(tools.map(v => v.name)).size).toBe(tools.length);
    const tool = tools.find(t => t.name === 'pinterest_create_keywords')!, common = { account_id: A, parent, expected_parent_hash: 'a'.repeat(64), keywords: [{ value: 'qa', match_type: 'EXACT' }] };
    expect(tool.input.safeParse(common).success).toBe(true);
    for (const input of [{ ...common, keywords: [{ value: 'qa', match_type: 'EXACT', bid: 123 }] }, { ...common, parent: { type: 'account' } }, { ...common, parent: { type: 'campaign', campaign_id: C } }, { ...common, keywords: [common.keywords[0], common.keywords[0]] }]) expect(tool.input.safeParse(input).success).toBe(false);
    expect(tools.find(t => t.name === 'pinterest_keywords')?.pagination).toEqual({ cursorInput: 'bookmark' });
  });
  it('sends explicit parent and CSV match-type filters with bookmark pagination', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/keywords') ? { items: [row], bookmark: 'next' } : undefined);
    const result = await provider.keywords.list({ account_id: A, parent, page_size: 25, bookmark: 'before', match_types: ['EXACT', 'PHRASE'] });
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ page_size: '25', bookmark: 'before', ad_group_id: G, match_types: 'EXACT,PHRASE' });
    expect(result.items[0]?.snapshot_hash).toMatch(/^[a-f0-9]{64}$/); expect(result.next_cursor).toBe('next');
    expect(result.creatives[0]?.actions[0]).toMatchObject({ tool: 'pinterest_archive_keywords', arguments: { account_id: A, parent, expected_parent_hash: result.parent_snapshot_hash, keywords: [{ keyword_id: K, expected_snapshot_hash: result.items[0]!.snapshot_hash }] }, fields: [] });
    expect(writes(calls)).toEqual([]);
  });
  it('keeps the account default at account-level exclusions and scopes campaign reads separately', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/keywords') ? { items: [{ ...row, parent_id: call.url.searchParams.get('campaign_id') ?? A, parent_type: call.url.searchParams.has('campaign_id') ? 'campaign' : 'advertiser', match_type: 'EXACT_NEGATIVE' }] } : undefined);
    await provider.keywords.list({ account_id: A, parent: { type: 'account' }, page_size: 10 }); expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ page_size: '10' });
    await provider.keywords.list({ account_id: A, parent: { type: 'campaign', campaign_id: C }, page_size: 10 }); expect(calls.at(-1)!.url.searchParams.get('campaign_id')).toBe(C);
  });
  it.each([{ ...row, parent_id: A }, { ...row, parent_type: 'advertiser' }, { ...row, match_type: 'BROAD' }])('rejects parent/match-type mismatches before a write %#', async wrong => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/keywords') ? { items: [wrong] } : undefined);
    await expect(provider.keywords.list({ account_id: A, parent, page_size: 25, match_types: ['EXACT'] })).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it.each([{ items: [], bookmark: 'more' }, { items: [row], bookmark: 'same' }, { items: [row, row] }])('rejects invalid native pages %#', async data => {
    const { provider } = fixture(call => call.url.pathname.endsWith('/keywords') ? data : undefined);
    await expect(provider.keywords.list({ account_id: A, parent, page_size: 1, bookmark: 'same' })).rejects.toThrow('pagination');
  });
  it('POSTs native parent_id/keywords object, omitting deprecated bid and internal snapshots', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { keywords: [row], errors: [] } : undefined);
    const context = await provider.keywords.context(A, parent), input = { parent, expected_parent_hash: context.parent_snapshot_hash, keywords: [{ value: row.value, match_type: 'EXACT' }] };
    expect((await provider.previewWrite(op('pinterest_create_keywords', input), guard)).serverValidated).toBe(false); expect(writes(calls)).toEqual([]);
    expect((await provider.applyWrite(op('pinterest_create_keywords', input), guard)).resourceIds).toEqual([K]);
    expect(body(writes(calls)[0]!)).toEqual({ parent_id: G, keywords: [{ value: row.value, match_type: 'EXACT' }] });
  });
  it('blocks positive keywords on serving parents under paused_creation and permits a genuinely paused ancestor', async () => {
    let paused = false;
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/campaigns/${C}`) ? { ...campaign, status: paused ? 'PAUSED' : 'ACTIVE' } : call.url.pathname.endsWith(`/ad_groups/${G}`) ? { ...group, status: 'ACTIVE' } : undefined);
    let context = await provider.keywords.context(A, parent);
    await expect(provider.previewWrite(op('pinterest_create_keywords', { parent, expected_parent_hash: context.parent_snapshot_hash, keywords: [{ value: 'qa', match_type: 'EXACT' }] }), guard)).rejects.toThrow('paused parent');
    paused = true; context = await provider.keywords.context(A, parent);
    await expect(provider.previewWrite(op('pinterest_create_keywords', { parent, expected_parent_hash: context.parent_snapshot_hash, keywords: [{ value: 'qa', match_type: 'EXACT' }] }), guard)).resolves.toMatchObject({ budgetDeltas: [] }); expect(writes(calls)).toEqual([]);
  });
  it('finds an exact keyword across pages before archiving and PATCHes only id/archived', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/keywords') ? call.init.method === 'PATCH' ? { keywords: [{ ...row, archived: true }], errors: [] } : call.url.searchParams.has('bookmark') ? { items: [row] } : { items: [{ ...row, id: '383791336903426390' }], bookmark: 'next' } : undefined);
    const current = await provider.keywords.get(A, parent, K);
    expect((await provider.applyWrite(op('pinterest_archive_keywords', { parent, expected_parent_hash: current.parent_snapshot_hash, keywords: [{ keyword_id: K, expected_snapshot_hash: current.snapshot_hash }] }, 'update'), guard)).resourceIds).toEqual([K]);
    expect(body(writes(calls)[0]!)).toEqual({ keywords: [{ id: K, archived: true }] });
  });
  it('rejects changed parent status and keyword snapshots rather than silently applying', async () => {
    let changed = false;
    const { provider, calls } = fixture(call => changed && call.url.pathname.endsWith(`/ad_groups/${G}`) ? { ...group, status: 'ACTIVE' } : undefined);
    const current = await provider.keywords.get(A, parent, K); changed = true;
    await expect(provider.previewWrite(op('pinterest_archive_keywords', { parent, expected_parent_hash: current.parent_snapshot_hash, keywords: [{ keyword_id: K, expected_snapshot_hash: current.snapshot_hash }] }, 'update'), guard)).rejects.toThrow('parent state changed');
    const fresh = await provider.keywords.get(A, parent, K);
    await expect(provider.previewWrite(op('pinterest_archive_keywords', { parent, expected_parent_hash: fresh.parent_snapshot_hash, keywords: [{ keyword_id: K, expected_snapshot_hash: '0'.repeat(64) }] }, 'update'), guard)).rejects.toThrow('contents'); expect(writes(calls)).toEqual([]);
  });
  it.each([{ keywords: [row], errors: [{ data: { id: null }, error_messages: ['native failure'] }] }, { keywords: [{ id: K }], errors: [] }, { keywords: [{ ...row, parent_id: A }], errors: [] }])('retains returned IDs on partial/incomplete/foreign receipts without mutation retries %#', async data => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? data : undefined), context = await provider.keywords.context(A, parent);
    await expect(provider.applyWrite(op('pinterest_create_keywords', { parent, expected_parent_hash: context.parent_snapshot_hash, keywords: [{ value: row.value, match_type: 'EXACT' }] }), guard)).rejects.toMatchObject({ details: { resource_ids: [K] } }); expect(writes(calls)).toHaveLength(1);
  });
  it('preserves native frequency ranges and missing metrics rather than inventing volumes', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/keywords/metrics') ? { data: [{ keyword: 'qa one', metrics: { keyword_query_volume: '5M+' } }] } : undefined);
    const result = await provider.keywords.metrics({ account_id: A, country_code: 'US', keywords: ['qa one', 'qa two'] });
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ country_code: 'US', keywords: 'qa one,qa two' }); expect(result.planning.rows).toEqual([{ keyword: 'qa one', volume: '5M+' }, { keyword: 'qa two', volume: null }]); expect(writes(calls)).toEqual([]);
  });
  it('rejects unsupported native metrics markets without substituting a country or making a request', async () => {
    const { provider, calls } = fixture();
    const tool = pinterestTools(provider).find(value => value.name === 'pinterest_keyword_metrics')!;
    expect(tool.input.safeParse({ account_id: A, country_code: 'DE', keywords: ['qa'] }).success).toBe(false);
    await expect(provider.keywords.metrics({ account_id: A, country_code: 'DE', keywords: ['qa'] })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it('keeps real registry invocation behind protected-account and one-use policy gates', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { keywords: [row], errors: [] } : undefined), context = await provider.keywords.context(A, parent);
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-pinterest-keywords-')); dirs.push(dir);
    const runtime = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))) });
    const input = { account_id: A, parent, expected_parent_hash: context.parent_snapshot_hash, keywords: [{ value: row.value, match_type: 'EXACT' }] };
    const preview = await runtime.registry.call('pinterest_create_keywords', input, runtime.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]);
    await runtime.registry.call('pinterest_create_keywords', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    await expect(runtime.registry.call('pinterest_create_keywords', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow(); expect(writes(calls)).toHaveLength(1);
    const blocked = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(dir, 'blocked')), new AuditLog(path.join(dir, 'blocked-audit'))) });
    await expect(blocked.registry.call('pinterest_create_keywords', input, blocked.ctx)).rejects.toThrow('protected'); expect(writes(calls)).toHaveLength(1);
  });
});
