import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { PinterestAdsClient, PINTEREST_TOKEN_URL } from '../src/client.js';
import { PinterestAdsProvider } from '../src/provider.js';
import { pinterestTools } from '../src/tools.js';

// Native wire contracts from Pinterest-owned OpenAPI5.28.0, fetched2026-11-03.
const A = '549000000001', C = '549000000002', G = '549000000003', AD = '549000000004', PIN = '1234567890123456789';
const campaign = { id: C, ad_account_id: A, name: 'QA campaign', status: 'PAUSED', is_campaign_budget_optimization: false };
const group = { id: G, ad_account_id: A, campaign_id: C, name: 'QA group', status: 'PAUSED', budget_type: 'DAILY', budget_in_micro_currency: 100_000_000, bid_in_micro_currency: 1_000_000, bid_strategy_type: 'MAX_BID', targeting_spec: { LOCATION: ['DE'], INTEREST: ['11'] }, optimization_goal_metadata: { conversion_tag_v3_goal_metadata: { conversion_tag_id: '9', cpa_goal_value_in_micro_currency: '5000000' } } };
const ad = { id: AD, ad_account_id: A, campaign_id: C, ad_group_id: G, pin_id: PIN, creative_type: 'REGULAR', name: 'QA ad', status: 'PAUSED', destination_url: 'https://example.com' };
const guard = { forcePausedCreation: true };
type Call = { url: URL; init: RequestInit };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function fixture(handler?: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new PinterestAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === PINTEREST_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (init.method === 'GET') {
      if (call.url.pathname.endsWith(`/campaigns/${C}`)) return Response.json(campaign);
      if (call.url.pathname.endsWith(`/ad_groups/${G}`)) return Response.json(group);
      if (call.url.pathname.endsWith(`/ads/${AD}`)) return Response.json(ad);
      if (call.url.pathname.endsWith('/conversion_tags/9')) return Response.json({ id: '9', ad_account_id: A });
    }
    throw new Error(`Unexpected request ${init.method} ${call.url.pathname}`);
  });
  return { provider: new PinterestAdsProvider(client), calls };
}
const body = (call: Call) => JSON.parse(String(call.init.body));
const writes = (calls: Call[]) => calls.filter(c => c.init.method !== 'GET' && c.url.href !== PINTEREST_TOKEN_URL);
function op(tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation { return { provider: 'pinterest', accountId: A, tool, kind, payload }; }
const successful = (call: Call, current: object) => ({ items: [{ data: { ...current, ...body(call)[0] }, exceptions: [] }] });

describe('Pinterest account-owned child workflows', () => {
  it('constructs the catalog lazily without reading a provider or duplicating tools', () => {
    const provider = new Proxy({} as PinterestAdsProvider, { get() { throw new Error('Provider read during catalog construction'); } });
    const tools = pinterestTools(provider); expect(new Set(tools.map(t => t.name)).size).toBe(tools.length); expect(tools.some(t => t.name === 'pinterest_create_ad_group')).toBe(true);
  });
  it('reads an exact native child ID and verifies its parent without relying on a filtered collection', async () => {
    const { provider, calls } = fixture(); expect(await provider.creatives.getEntity(A, 'ad_groups', G)).toEqual(group);
    expect(calls.slice(1).map(call => call.url.pathname)).toEqual([`/v5/ad_accounts/${A}/ad_groups/${G}`, `/v5/ad_accounts/${A}/campaigns/${C}`]);
    expect(writes(calls)).toEqual([]);
  });
  it('forces paused creation and posts native array bodies with micro bids and explicit targeting expansion', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? successful(call, group) : undefined);
    const operation = op('pinterest_create_ad_group', { name: 'QA group', campaign_id: C, billable_event: 'IMPRESSION', bid_strategy_type: 'MAX_BID', bid_in_micro_currency: 1_000_000, budget_in_micro_currency: 100_000_000, targeting_spec: { LOCATION: ['DE'] }, status: 'ACTIVE' }, 'create');
    const preview = await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]); expect(preview.coercions).toContain('status coerced to PAUSED by policy (paused_creation)');
    expect(preview.budgetDeltas.map(d => d.toMicros)).toEqual([100_000_000, 1_000_000]);
    await provider.applyWrite(operation, guard);
    const request = writes(calls)[0]!; expect(request.url.pathname).toBe(`/v5/ad_accounts/${A}/ad_groups`);
    expect(body(request)).toEqual([{ ...operation.payload, status: 'PAUSED', budget_type: 'DAILY', pacing_delivery_type: 'STANDARD', auto_targeting_enabled: false }]);
  });
  it('keeps CBO budgets at campaign level and refuses an accidental child budget', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/campaigns/${C}`) ? { ...campaign, is_campaign_budget_optimization: true } : undefined);
    await expect(provider.previewWrite(op('pinterest_create_ad_group', { name: 'QA group', campaign_id: C, billable_event: 'IMPRESSION', bid_strategy_type: 'MAX_BID', bid_in_micro_currency: 1_000_000, budget_in_micro_currency: 100_000_000, targeting_spec: { LOCATION: ['DE'] } }, 'create'), guard)).rejects.toThrow('CBO campaigns own');
    expect(writes(calls)).toEqual([]);
  });
  it('preserves targeting dimensions and treats an empty legacy age array as a clear', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? successful(call, group) : undefined);
    await provider.applyWrite(op('pinterest_update_ad_group', { ad_group_id: G, targeting_spec: { INTEREST: ['22'], AGE_BUCKET: [], MINIMUM_AGE: '18', MAXIMUM_AGE: '65+' } }), guard);
    expect(body(writes(calls)[0]!)[0]).toEqual({ id: G, targeting_spec: { LOCATION: ['DE'], INTEREST: ['22'], AGE_BUCKET: [], MINIMUM_AGE: '18', MAXIMUM_AGE: '65+' } });
  });
  it('checks nested string micro CPA targets against the current value and preserves the tag ID', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? successful(call, group) : undefined);
    const operation = op('pinterest_update_ad_group', { ad_group_id: G, optimization_goal_metadata: { conversion_tag_v3_goal_metadata: { cpa_goal_value_in_micro_currency: '6000000' } } });
    expect((await provider.previewWrite(operation, guard)).budgetDeltas).toEqual([{ target: `ad group ${G} cpa_goal_value_in_micro_currency`, fromMicros: 5_000_000, toMicros: 6_000_000 }]);
    await provider.applyWrite(operation, guard);
    expect(body(writes(calls)[0]!)[0].optimization_goal_metadata.conversion_tag_v3_goal_metadata).toEqual({ conversion_tag_id: '9', cpa_goal_value_in_micro_currency: '6000000' });
  });
  it('rejects foreign conversion tags and foreign parent accounts before writing', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/conversion_tags/9') ? { id: '9', ad_account_id: G } : undefined);
    await expect(provider.previewWrite(op('pinterest_update_ad_group', { ad_group_id: G, optimization_goal_metadata: { conversion_tag_v3_goal_metadata: { conversion_tag_id: '9' } } }), guard)).rejects.toThrow('not owned'); expect(writes(calls)).toEqual([]);
    const foreign = fixture(call => call.url.pathname.endsWith(`/campaigns/${C}`) ? { ...campaign, ad_account_id: G } : undefined);
    await expect(foreign.provider.applyWrite(op('pinterest_set_ad_status', { ad_id: AD, status: 'PAUSED' }), guard)).rejects.toThrow('mismatch'); expect(writes(foreign.calls)).toEqual([]);
  });
  it('creates paused ads using long native Pin IDs without changing the original Pin', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? successful(call, ad) : undefined);
    await provider.applyWrite(op('pinterest_create_ad', { ad_group_id: G, pin_id: PIN, creative_type: 'REGULAR', name: 'QA ad', status: 'ACTIVE' }, 'create'), guard);
    expect(body(writes(calls)[0]!)[0]).toEqual({ ad_group_id: G, pin_id: PIN, creative_type: 'REGULAR', name: 'QA ad', status: 'PAUSED' });
    expect(calls.every(c => !c.url.pathname.startsWith('/v5/pins'))).toBe(true);
  });
  it('refuses Pin replacement on a published ad and patches only requested metadata', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? successful(call, ad) : undefined);
    await expect(provider.previewWrite(op('pinterest_update_ad', { ad_id: AD, pin_id: '22' }), guard)).rejects.toThrow('only be replaced');
    await provider.applyWrite(op('pinterest_update_ad', { ad_id: AD, destination_url: 'https://example.com/new' }), guard);
    expect(body(writes(calls)[0]!)).toEqual([{ id: AD, destination_url: 'https://example.com/new' }]);
  });
  it('retains native DAILY budget type and policy-checks current/proposed micros', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? successful(call, group) : undefined);
    const operation = op('pinterest_set_ad_group_budget', { ad_group_id: G, budget_micros: 110_000_000 });
    expect((await provider.previewWrite(operation, guard)).budgetDeltas).toEqual([{ target: `ad group ${G} budget_in_micro_currency`, fromMicros: 100_000_000, toMicros: 110_000_000 }]);
    await provider.applyWrite(operation, guard); expect(body(writes(calls)[0]!)).toEqual([{ id: G, budget_in_micro_currency: 110_000_000 }]);
  });
  it('returns created IDs when a batch item reports exceptions and refuses silent money/status mismatches', async () => {
    const failing = fixture(call => call.init.method === 'PATCH' ? { items: [{ data: group, exceptions: [{ code: 'PARTIAL_ERROR' }] }] } : undefined);
    try { await failing.provider.applyWrite(op('pinterest_set_ad_group_budget', { ad_group_id: G, budget_micros: 110_000_000 }), guard); throw Error('Expected failure'); } catch (error) { expect(error).toMatchObject({ details: { resource_ids: [G] } }); }
    const mismatch = fixture(call => call.init.method === 'PATCH' ? { items: [{ data: group, exceptions: [] }] } : undefined);
    await expect(mismatch.provider.applyWrite(op('pinterest_set_ad_group_budget', { ad_group_id: G, budget_micros: 110_000_000 }), guard)).rejects.toThrow('money mismatch');
    await expect(mismatch.provider.applyWrite(op('pinterest_update_ad_group', { ad_group_id: G, optimization_goal_metadata: { conversion_tag_v3_goal_metadata: { cpa_goal_value_in_micro_currency: '6000000' } } }), guard)).rejects.toThrow('optimization receipt mismatch');
  });
  it('uses native bookmark parameters and exposes explicit truncation on advertiser configuration reads', async () => {
    const { provider, calls } = fixture(() => ({ items: [group], bookmark: 'next+page=' }));
    const result = await provider.creatives.page({ account_id: A, page_size: 2, campaign_ids: [C, G] }, 'ad_groups');
    expect(result).toMatchObject({ truncated: true, next_cursor: 'next+page=' }); expect(calls[1]!.url.searchParams.getAll('campaign_ids')).toEqual([`${C},${G}`]); expect(calls[1]!.url.searchParams.get('entity_statuses')!.split(',')).toContain('ARCHIVED');
  });
  it('preserves native targeting option arrays and the selected advertiser query parameter', async () => {
    const { provider, calls } = fixture(() => [{ value: 'DE', name: 'Germany' }]);
    expect(await provider.creatives.targetingOptions(A, 'LOCATION')).toEqual([{ value: 'DE', name: 'Germany' }]);
    expect(calls[1]!.url.pathname).toBe('/v5/resources/targeting/LOCATION'); expect(calls[1]!.url.searchParams.get('ad_account_id')).toBe(A);
  });
  it('keeps gallery actions bound to the displayed account and real native destination', async () => {
    const { provider } = fixture(() => ({ items: [ad], bookmark: null }));
    const result = await provider.creatives.ads({ account_id: A, page_size: 50 });
    expect(result.creatives[0]).toMatchObject({ id: AD, account_id: A, landing_urls: ['https://example.com'], media: [] });
    expect(result.creatives[0]!.actions.map(action => action.arguments)).toEqual([{ account_id: A, ad_id: AD }, { account_id: A, ad_id: AD }]);
  });
  it('hydrates only referenced Pins and renders native image/copy without modifying Pins', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/pins/${PIN}`) ? { id: PIN, title: 'Actual Pin title', description: 'Actual Pin copy', media: { media_type: 'image', images: { original: { url: 'https://i.pinimg.com/qa.png', width: 640, height: 640 } } } } : { items: [ad], bookmark: null });
    const result = await provider.creatives.ads({ account_id: A, page_size: 50, include_pin_details: true });
    expect(result.creatives[0]).toMatchObject({ headlines: ['Actual Pin title'], descriptions: ['Actual Pin copy'], media: [{ type: 'image', url: 'https://i.pinimg.com/qa.png' }] });
    expect(calls.at(-1)!.url.searchParams.get('ad_account_id')).toBe(A); expect(writes(calls)).toEqual([]);
    expect(calls[1]!.url.searchParams.has('include_pin_details')).toBe(false);
  });
  it('keeps account ad settings available and reports missing Pin scopes accurately', async () => {
    const { provider } = fixture(call => call.url.pathname.endsWith(`/pins/${PIN}`) ? Response.json({}, { status: 403 }) : { items: [ad], bookmark: null });
    const result = await provider.creatives.ads({ account_id: A, page_size: 50, include_pin_details: true });
    expect(result.creatives).toHaveLength(1); expect(result.creatives[0]!.media).toEqual([]); expect(result.warnings[0]?.message).toContain('boards:read');
  });
  it('retains shared preview/apply binding and budget caps for new child tools', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? successful(call, group) : undefined);
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-pinterest-creative-')); dirs.push(dir);
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))), providerModules: [{ provider, tools: pinterestTools(provider) }] });
    const args = { account_id: A, ad_group_id: G, budget_micros: 110_000_000 };
    const preview = await runtime.registry.call('pinterest_set_ad_group_budget', args, runtime.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]);
    await expect(runtime.registry.call('pinterest_set_ad_group_budget', { ...args, budget_micros: 111_000_000, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow('differs');
    await runtime.registry.call('pinterest_set_ad_group_budget', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx); expect(writes(calls)).toHaveLength(1);
    await expect(runtime.registry.call('pinterest_set_ad_group_budget', { ...args, budget_micros: 150_000_000 }, runtime.ctx)).rejects.toThrow('cap');
  });
});
