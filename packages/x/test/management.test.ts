import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';

// Native query-only requests and response fields follow X-owned v12 reference
// at xdevplatform/docs2f701ee, fetched2026-11-03. No SDK code is executed.
const A = 'a1', C = 'c1', L = 'l1';
const account = { id: A, name: 'Synthetic account', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false };
const campaign = { id: C, name: 'Campaign', currency: 'EUR', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 40_000_000, total_budget_amount_local_micro: null };
const line = { id: L, name: null, campaign_id: C, currency: 'EUR', entity_status: 'PAUSED', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'ENGAGEMENTS', bid_strategy: 'MAX', bid_amount_local_micro: 1_000_001, daily_budget_amount_local_micro: 10_000_001, total_budget_amount_local_micro: 40_000_001, start_time: '2026-11-10T00:00:00Z', end_time: '2026-11-11T00:00:00Z', standard_delivery: true };
const create = { campaign_id: C, name: 'QA + Ü', objective: 'ENGAGEMENTS', product_type: 'PROMOTED_TWEETS', placements: ['ALL_ON_TWITTER'], bid_strategy: 'MAX', bid_micros: 1_000_001, daily_budget_micros: 10_000_001, total_budget_micros: 40_000_001, start_time: line.start_time, end_time: line.end_time, status: 'ACTIVE' };
type Call = { url: URL; init: RequestInit };
const writes = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET');
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'x', accountId: A, tool, payload, kind });
const guard = { forcePausedCreation: true };
const web = { id: 'web1', name: 'QA purchase', type: 'PURCHASE', click_window: 14, view_through_window: 1, retargeting_enabled: false, status: 'UNTRACKED', deleted: false, embed_code: '<script>inert</script>' };
function fixture(handler?: (call: Call) => unknown) {
  const calls: Call[] = []; let current: Record<string, unknown> = structuredClone(line);
  const client = new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const native = call.url.pathname.replace('/12/', '');
    if (init.method === 'GET') {
      const values: Record<string, unknown> = { [`accounts/${A}`]: account, [`accounts/${A}/web_event_tags/web1`]: web, [`accounts/${A}/line_items/${L}`]: current, [`accounts/${A}/line_items`]: [], [`accounts/${A}/promoted_tweets`]: [], [`accounts/${A}/media_creatives`]: [], [`accounts/${A}/promoted_accounts`]: [], [`accounts/${A}/campaigns/${C}`]: campaign, 'line_items/placements': [{ product_type: 'PROMOTED_TWEETS', placements: [['ALL_ON_TWITTER']] }] };
      if (values[native]) return Response.json({ data: values[native], next_cursor: null });
    }
    if (['POST', 'PUT'].includes(String(init.method)) && native.startsWith(`accounts/${A}/line_items`)) {
      const params = Object.fromEntries([...call.url.searchParams].map(([key, value]) => [key, key.endsWith('_local_micro') ? Number(value) : ['placements', 'categories'].includes(key) ? value.split(',') : key === 'standard_delivery' ? value === 'true' : value]));
      current = { ...current, ...params }; return Response.json({ data: current });
    }
    if (init.method === 'DELETE') return Response.json({ data: { ...current, deleted: true } });
    throw new Error(`Unexpected request ${init.method} ${native}`);
  });
  return { provider: new XAdsProvider(client), calls };
}
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('X line-item lifecycle and wire format', () => {
  it('binds a current account-owned primary event and native conversion goal on paused creation', async () => {
    const f = fixture(), current = (await f.provider.measurement.getWeb({ account_id: A, web_event_tag_id: 'web1' })).data;
    const payload = { ...create, objective: 'WEBSITE_CLICKS', goal: 'WEBSITE_CONVERSIONS', primary_web_event_tag: 'web1', expected_web_event_tag_hash: current.configuration_hash }, operation = op('x_create_line_item', payload, 'create');
    const preview = await f.provider.previewWrite(operation, guard);expect(preview.review?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Primary event', after: 'QA purchase · web1' }), expect.objectContaining({ label: 'Goal', after: 'WEBSITE_CONVERSIONS' }), expect.objectContaining({ label: 'Status', after: 'PAUSED' })]));expect(preview.coercions).toContain('entity_status coerced to PAUSED by policy (paused_creation)');expect(writes(f.calls)).toHaveLength(0);
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ applied: true, resourceIds: [L] });const write = writes(f.calls)[0]!;expect(write.url.searchParams.get('primary_web_event_tag')).toBe('web1');expect(write.url.searchParams.get('goal')).toBe('WEBSITE_CONVERSIONS');expect(write.url.searchParams.get('entity_status')).toBe('PAUSED');expect(write.url.searchParams.has('expected_web_event_tag_hash')).toBe(false);expect(write.init.body).toBeUndefined();expect(f.calls.slice(f.calls.indexOf(write) + 1).some(call => call.url.pathname.endsWith('/line_items/l1'))).toBe(true);
  });
  it('rejects missing tag/hash, invalid goal and undocumented objective combinations before mutation', async () => {
    const f = fixture(), schema = xTools(f.provider).find(value => value.name === 'x_create_line_item')!.input;
    for (const value of [{ goal: 'WEBSITE_CONVERSIONS' }, { primary_web_event_tag: 'web1' }, { expected_web_event_tag_hash: 'a'.repeat(64) }, { goal: 'INVENTED_GOAL' }]) expect(schema.safeParse({ ...create, account_id: A, ...value }).success).toBe(false);
    for (const goal of ['SITE_VISITS', 'APP_PURCHASES', 'APP_CLICKS', 'APP_INSTALLS']) await expect(f.provider.previewWrite(op('x_create_line_item', { ...create, goal }, 'create'), guard)).rejects.toThrow('goal is not documented');expect(writes(f.calls)).toHaveLength(0);
  });
  it('rejects changed/deleted/foreign primary tags before creation, while volatile diagnostics do not invalidate the snapshot', async () => {
    let patch: Record<string, unknown> = {}, f = fixture(call => call.url.pathname.endsWith('/web_event_tags/web1') ? { data: { ...web, ...patch } } : undefined);
    const hash = (await f.provider.measurement.getWeb({ account_id: A, web_event_tag_id: 'web1' })).data.configuration_hash, payload = { ...create, primary_web_event_tag: 'web1', expected_web_event_tag_hash: hash };
    patch = { status: 'TRACKING', last_tracked_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z' };expect((await f.provider.measurement.getWeb({ account_id: A, web_event_tag_id: 'web1' })).data.configuration_hash).toBe(hash);
    for (const value of [{ type: 'SIGN_UP' }, { click_window: 30 }, { deleted: true }, { account_id: 'other' }, { id: 'other' }]) { patch = value;await expect(f.provider.applyWrite(op('x_create_line_item', payload, 'create'), guard)).rejects.toThrow('x:'); }expect(writes(f.calls)).toHaveLength(0);
  });
  it('retains created IDs and never replays after mismatched measurement readback', async () => {
    let created = false;const f = fixture(call => { if (call.init.method === 'POST') created = true;if (created && call.init.method === 'GET' && call.url.pathname.endsWith('/line_items/l1')) return { data: { ...line, objective: 'WEBSITE_CLICKS', goal: 'LINK_CLICKS', primary_web_event_tag: 'other' } };return undefined; });
    const hash = (await f.provider.measurement.getWeb({ account_id: A, web_event_tag_id: 'web1' })).data.configuration_hash;await expect(f.provider.applyWrite(op('x_create_line_item', { ...create, objective: 'WEBSITE_CLICKS', goal: 'WEBSITE_CONVERSIONS', primary_web_event_tag: 'web1', expected_web_event_tag_hash: hash }, 'create'), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: [L] } });expect(writes(f.calls)).toHaveLength(1);
  });
  it('rechecks the approved event snapshot through the shared pending-token boundary before any create', async () => {
    let tagType = 'PURCHASE';const f = fixture(call => call.url.pathname.endsWith('/web_event_tags/web1') ? { data: { ...web, type: tagType } } : undefined), directory = await mkdtemp(path.join(tmpdir(), 'x-conversion-setup-'));dirs.push(directory);
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(directory, 'pending')), new AuditLog(path.join(directory, 'audit'))), providerModules: [{ provider: f.provider, tools: xTools(f.provider) }] });
    const hash = (await f.provider.measurement.getWeb({ account_id: A, web_event_tag_id: 'web1' })).data.configuration_hash, args = { account_id: A, ...create, objective: 'WEBSITE_CLICKS', goal: 'WEBSITE_CONVERSIONS', primary_web_event_tag: 'web1', expected_web_event_tag_hash: hash };
    const preview = await runtime.registry.call('x_create_line_item', args, runtime.ctx) as { pending_operation_id: string };expect(writes(f.calls)).toHaveLength(0);tagType = 'SIGN_UP';await expect(runtime.registry.call('x_create_line_item', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow('configuration changed');expect(writes(f.calls)).toHaveLength(0);
  });
  it('builds a unique serializable catalog lazily', () => { const provider = new Proxy({} as XAdsProvider, { get() { throw new Error('Eager provider access'); } }), tools = xTools(provider); expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length); for (const tool of tools) expect(() => z.toJSONSchema(tool.input)).not.toThrow(); });
  it('creates a paused line item using signed query params, exact micros and native boolean/dates', async () => {
    const { provider, calls } = fixture(), operation = op('x_create_line_item', create, 'create'), preview = await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]); expect(preview.coercions[0]).toContain('PAUSED'); expect(preview.budgetDeltas.map(value => value.toMicros)).toEqual([1_000_001, 10_000_001, 40_000_001]);
    expect(await provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [L] }); const request = writes(calls)[0]!; expect(request.url.pathname).toBe(`/12/accounts/${A}/line_items`); expect(request.init.body).toBeUndefined(); expect(Object.fromEntries(request.url.searchParams)).toEqual({ campaign_id: C, name: 'QA + Ü', objective: 'ENGAGEMENTS', product_type: 'PROMOTED_TWEETS', placements: 'ALL_ON_TWITTER', start_time: line.start_time, end_time: line.end_time, entity_status: 'PAUSED', bid_strategy: 'MAX', standard_delivery: 'true', bid_amount_local_micro: '1000001', daily_budget_amount_local_micro: '10000001', total_budget_amount_local_micro: '40000001' }); expect(new Headers(request.init.headers).get('authorization')).toMatch(/^OAuth /);
  });
  it.each([
    { ...create, objective: 'REACH', bid_strategy: 'MAX' },
    { ...create, bid_strategy: 'AUTO' },
    { ...create, bid_strategy: 'TARGET' },
    { ...create, objective: 'APP_INSTALLS' },
    { ...create, placements: ['PUBLISHER_NETWORK'] },
    { ...create, end_time: '2026-11-09T00:00:00Z' },
  ])('rejects native-ineligible or misleading create settings before mutation', async input => { const { provider, calls } = fixture(); await expect(provider.previewWrite(op('x_create_line_item', input, 'create'), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]); });
  it('records native automatic platform targeting for explicitly selected app-store identifiers', async () => {
    const { provider, calls } = fixture(), input = { ...create, objective: 'APP_INSTALLS', android_app_store_identifier: 'dev.adport.qa' }, operation = op('x_create_line_item', input, 'create'); expect((await provider.previewWrite(operation, guard)).changes[0]).toContain('add platform targeting'); await provider.applyWrite(operation, guard); expect(writes(calls)[0]!.url.searchParams.get('android_app_store_identifier')).toBe('dev.adport.qa');
  });
  it('validates the native nested placement combinations before creating a line item', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('x_create_line_item', { ...create, placements: ['TWITTER_SEARCH'] }, 'create'), guard)).rejects.toThrow('placement combination is unavailable'); expect(writes(calls)).toEqual([]);
    expect((await provider.lineItemPlacements()).data).toEqual([{ product_type: 'PROMOTED_TWEETS', placements: [['ALL_ON_TWITTER']] }]);
  });
  it('rejects siblings of a different campaign objective/product and wrong parent IDs', async () => {
    const siblings = fixture(call => call.url.pathname.endsWith('/line_items') ? { data: [{ ...line, objective: 'VIDEO_VIEWS' }], next_cursor: null } : undefined); await expect(siblings.provider.previewWrite(op('x_create_line_item', create, 'create'), guard)).rejects.toThrow('share product_type'); expect(writes(siblings.calls)).toEqual([]);
    const parent = fixture(call => call.url.pathname.endsWith(`/campaigns/${C}`) ? { data: { ...campaign, id: 'other' } } : undefined); await expect(parent.provider.previewWrite(op('x_create_line_item', create, 'create'), guard)).rejects.toThrow('ID mismatch');
  });
  it('edits only supplied metadata, keeping native status, other bounds, budgets and bid', async () => {
    const { provider, calls } = fixture(); await provider.applyWrite(op('x_update_line_item', { line_item_id: L, name: 'Edited' }), guard); expect(Object.fromEntries(writes(calls)[0]!.url.searchParams)).toEqual({ name: 'Edited' });
    await expect(provider.previewWrite(op('x_update_line_item', { line_item_id: L, start_time: '2026-11-12T00:00:00Z' }), guard)).rejects.toThrow('merged end time'); expect(writes(calls)).toHaveLength(1);
  });
  it('changes child status through native PUT after proving the account/campaign hierarchy', async () => { const { provider, calls } = fixture(); await provider.applyWrite(op('x_set_line_item_status', { line_item_id: L, status: 'PAUSED' }), guard); expect(writes(calls)[0]!.init.method).toBe('PUT'); expect(Object.fromEntries(writes(calls)[0]!.url.searchParams)).toEqual({ entity_status: 'PAUSED' }); });
  it.each(['budget', 'bidding'])('reads current integer micros for %s and preserves the other monetary settings', async kind => {
    const { provider, calls } = fixture(), operation = kind === 'budget' ? op('x_set_line_item_budget', { line_item_id: L, budget_type: 'DAILY', budget_micros: 11_000_001 }) : op('x_set_line_item_bidding', { line_item_id: L, bid_micros: 1_100_001 });
    expect((await provider.previewWrite(operation, guard)).budgetDeltas[0]).toMatchObject({ fromMicros: kind === 'budget' ? 10_000_001 : 1_000_001, toMicros: kind === 'budget' ? 11_000_001 : 1_100_001 }); await provider.applyWrite(operation, guard); expect(Object.fromEntries(writes(calls)[0]!.url.searchParams)).toEqual(kind === 'budget' ? { daily_budget_amount_local_micro: '11000001' } : { bid_amount_local_micro: '1100001' });
  });
  it('refuses removal of a monetary bid cap via AUTO and an inverted daily/total cap', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('x_set_line_item_bidding', { line_item_id: L, bid_strategy: 'AUTO' }), guard)).rejects.toThrow('removing a monetary bid cap'); await expect(provider.previewWrite(op('x_set_line_item_budget', { line_item_id: L, budget_type: 'DAILY', budget_micros: 50_000_000 }), guard)).rejects.toThrow('daily budget'); expect(writes(calls)).toEqual([]);
  });
  it('keeps returned IDs when the server violates paused creation or changes an omitted cap', async () => {
    const active = fixture(call => call.init.method === 'POST' ? { data: { ...line, name: create.name, entity_status: 'ACTIVE' } } : undefined); await expect(active.provider.applyWrite(op('x_create_line_item', create, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [L] } });
    const changed = fixture(call => call.init.method === 'PUT' ? { data: { ...line, daily_budget_amount_local_micro: 11_000_001, total_budget_amount_local_micro: null } } : undefined); await expect(changed.provider.applyWrite(op('x_set_line_item_budget', { line_item_id: L, budget_type: 'DAILY', budget_micros: 11_000_001 }), guard)).rejects.toMatchObject({ details: { resource_ids: [L] } });
  });
  it('requires child-first cleanup and confirms native deleted receipt', async () => {
    const { provider, calls } = fixture(); expect(await provider.applyWrite(op('x_delete_line_item', { line_item_id: L }, 'remove'), guard)).toMatchObject({ resourceIds: [L] }); expect(writes(calls)[0]!.init.method).toBe('DELETE');
    const linked = fixture(call => call.url.pathname.endsWith('/promoted_tweets') ? { data: [{ id: 'ad1', line_item_id: L, tweet_id: '123', entity_status: 'ACTIVE', deleted: false }], next_cursor: null } : undefined); await expect(linked.provider.previewWrite(op('x_delete_line_item', { line_item_id: L }, 'remove'), guard)).rejects.toThrow('remove line-item promotions'); expect(writes(linked.calls)).toEqual([]);
  });
  it('uses exact pending tokens, budget caps and protected-account checks through the normal registry', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'x-management-')); dirs.push(directory); const { provider, calls } = fixture(), audit = new AuditLog(path.join(directory, 'audit')), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(directory, 'pending')), audit), runtime = await createContext({ engine, providerModules: [{ provider, tools: xTools(provider) }] });
    const args = { account_id: A, line_item_id: L, budget_type: 'DAILY', budget_micros: 11_000_001 }, pending = await runtime.registry.call('x_set_line_item_budget', args, runtime.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]); await expect(runtime.registry.call('x_set_line_item_budget', { ...args, budget_micros: 11_000_002, pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('differs'); await runtime.registry.call('x_set_line_item_budget', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx); expect(writes(calls)).toHaveLength(1);
    await expect(runtime.registry.call('x_set_line_item_budget', { ...args, budget_micros: 25_000_000 }, runtime.ctx)).rejects.toThrow('budget-delta cap'); const blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(directory, 'blocked')), audit); await expect(blocked.validate(provider, op('x_set_line_item_status', { line_item_id: L, status: 'PAUSED' }))).rejects.toThrow('protected');
  });
});
