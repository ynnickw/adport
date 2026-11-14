import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';

// X-owned v12 targeting references at docs2f701ee (2026-11-03): exact query
// filters, criterion envelopes and atomic JSON batch semantics/order/errors.
const A = 'a1', L = 'l1', C = 'c1';
const location = { id: 'geo1', line_item_id: L, targeting_type: 'LOCATION', targeting_value: 'country-us', operator_type: 'EQ', deleted: false };
const credentials = { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' };
type Row = Record<string, unknown>;
type Call = { url: URL; init: RequestInit };
const writes = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET');
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ provider: 'x', accountId: A, tool, payload, kind });
const guard = { forcePausedCreation: true };
function fixture(handler?: (call: Call) => unknown, initial: Row[] = [location]) {
  const calls: Call[] = []; let current = structuredClone(initial), sequence = 0;
  const client = new XAdsClient(credentials, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const route = call.url.pathname.replace('/12/', '');
    if (init.method === 'GET') {
      const data: Record<string, unknown> = { [`accounts/${A}`]: { id: A, name: 'Account', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false }, [`accounts/${A}/line_items/${L}`]: { id: L, name: null, campaign_id: C, currency: 'EUR', entity_status: 'PAUSED', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'ENGAGEMENTS' }, [`accounts/${A}/campaigns/${C}`]: { id: C, name: 'Campaign', currency: 'EUR', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null }, [`accounts/${A}/targeting_criteria`]: current, [`accounts/${A}/custom_audiences`]: [{ id: 'aud1', targetable: true, owner_account_id: A, permission_level: 'READ_WRITE', deleted: false }], [`accounts/${A}/promotable_users`]: [{ id: 'pu1', user_id: '123', promotable_user_type: 'FULL', deleted: false }], [`accounts/${A}/app_lists`]: [{ id: 'app1', name: 'Excluded apps' }] };
      if (data[route]) return Response.json({ data: data[route], next_cursor: null });
      if (route.startsWith(`accounts/${A}/targeting_criteria/`)) return Response.json({ data: current.find(value => value.id === route.split('/').at(-1)) });
      if (route.startsWith('targeting_criteria/')) return Response.json({ data: [{ targeting_value: 'en', name: 'English' }], next_cursor: null });
    }
    if (init.method === 'POST' && route === `accounts/${A}/targeting_criteria`) { const value = { id: `new${++sequence}`, ...Object.fromEntries(call.url.searchParams), deleted: false }; current.push(value); return Response.json({ data: value }); }
    if (init.method === 'DELETE') { const previous = current.find(value => value.id === route.split('/').at(-1))!; current = current.filter(value => value.id !== previous.id); return Response.json({ data: { ...previous, deleted: true } }); }
    if (init.method === 'POST' && route === `batch/accounts/${A}/targeting_criteria`) {
      const operations = JSON.parse(String(init.body)) as Array<{ operation_type: string; params: Row }>, data = operations.map(value => { if (value.operation_type === 'Delete') { const previous = current.find(row => row.id === value.params.targeting_criterion_id)!; current = current.filter(row => row.id !== previous.id); return { ...previous, deleted: true }; } const created = { id: `new${++sequence}`, ...value.params, deleted: false }; current.push(created); return created; });
      return Response.json({ data });
    }
    throw new Error(`Unexpected request ${init.method} ${route}`);
  });
  return { calls, client, provider: new XAdsProvider(client) };
}
const add = { line_item_id: L, targeting_type: 'LANGUAGE', targeting_value: 'en' };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('X native targeting discovery and criteria', () => {
  it('forwards only native dimension filters, with correct CSV and cursor handling', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/locations') ? { data: [{ targeting_value: 'country-us', name: 'United States' }], next_cursor: 'next' } : undefined);
    expect(await provider.targeting.options({ account_id: A, dimension: 'locations', q: 'New + York', country_code: 'US', location_type: 'CITIES', count: 1 })).toMatchObject({ truncated: true, next_cursor: 'next' });
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ count: '1', q: 'New + York', country_code: 'US', location_type: 'CITIES' });
    await provider.targeting.options({ account_id: A, dimension: 'events', count: 5, country_codes: ['US', 'DE'], event_types: ['SPORTS', 'MUSIC_AND_ENTERTAINMENT'] }); expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toMatchObject({ count: '5', country_codes: 'US,DE', event_types: 'SPORTS,MUSIC_AND_ENTERTAINMENT' });
  });
  it('does not send invented pagination to unpaged endpoints and makes truncation explicit', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/platform_versions') ? { data: [{ targeting_value: '1' }, { targeting_value: '2' }] } : undefined);
    const result = await provider.targeting.options({ account_id: A, dimension: 'platform_versions', q: 'iOS', count: 1 }); expect(result.items).toHaveLength(1); expect(result.truncated).toBe(true); expect(result.warning).toContain('Narrow'); expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ q: 'iOS' });
    await expect(provider.targeting.options({ account_id: A, dimension: 'tv_markets', q: 'unsupported' })).rejects.toThrow('not supported'); await expect(provider.targeting.options({ account_id: A, dimension: 'tv_shows' })).rejects.toThrow('require locale');
  });
  it('retains an oversized native page to avoid skipped choices and suppresses undocumented continuations', async () => {
    const { provider } = fixture(call => call.url.pathname.startsWith('/12/targeting_criteria/') ? { data: [{ targeting_value: '1' }, { targeting_value: '2' }], next_cursor: 'next' } : undefined);
    const paged = await provider.targeting.options({ account_id: A, dimension: 'languages', count: 1 }); expect(paged.items).toHaveLength(2); expect(paged.next_cursor).toBe('next'); expect(paged.warning).toContain('complete page');
    const unpaged = await provider.targeting.options({ account_id: A, dimension: 'platform_versions', count: 1 }); expect(unpaged.items).toHaveLength(1); expect(unpaged.truncated).toBe(true); expect(unpaged).not.toHaveProperty('next_cursor');
  });
  it('reads only verified line-item criteria, preserves native operators and rejects ignored filters', async () => {
    const { provider, calls } = fixture(); expect(await provider.targeting.criteria({ account_id: A, line_item_ids: [L] })).toMatchObject({ items: [location], truncated: false }); expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ line_item_ids: L, count: '100', with_deleted: 'false' });
    const foreign = fixture(call => call.url.pathname.endsWith('/targeting_criteria') ? { data: [{ ...location, line_item_id: 'other' }] } : undefined); await expect(foreign.provider.targeting.criteria({ account_id: A, line_item_ids: [L] })).rejects.toThrow('another line item');
  });
  it('adds one criterion only on apply and preserves the existing dimensions', async () => {
    const { provider, calls } = fixture(), operation = op('x_add_targeting_criterion', add); await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['new1'] }); expect(Object.fromEntries(writes(calls)[0]!.url.searchParams)).toEqual({ ...add, operator_type: 'EQ' }); expect((await provider.targeting.criteria({ account_id: A, line_item_ids: [L] })).items).toEqual(expect.arrayContaining([location]));
  });
  it('checks account-available targetable audience references before writes', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('x_add_targeting_criterion', { ...add, targeting_type: 'CUSTOM_AUDIENCE', targeting_value: 'foreign' }), guard)).rejects.toThrow('not in the account'); expect(writes(calls)).toEqual([]);
    const inactive = fixture(call => call.url.pathname.endsWith('/custom_audiences') ? { data: [{ id: 'aud1', targetable: false, deleted: false }] } : undefined); await expect(inactive.provider.previewWrite(op('x_add_targeting_criterion', { ...add, targeting_type: 'CUSTOM_AUDIENCE', targeting_value: 'aud1' }), guard)).rejects.toThrow('not targetable');
    await provider.applyWrite(op('x_add_targeting_criterion', { ...add, targeting_type: 'CUSTOM_AUDIENCE', targeting_value: 'aud1' }), guard); expect(writes(calls)).toHaveLength(1);
  });
  it('requires full promotable-user membership and exclusion-only available app lists', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('x_add_targeting_criterion', { ...add, targeting_type: 'FOLLOWERS_OF_USER', targeting_value: '999' }), guard)).rejects.toThrow('promotable_users'); await expect(provider.previewWrite(op('x_add_targeting_criterion', { ...add, targeting_type: 'APP_LIST', targeting_value: 'app1' }), guard)).rejects.toThrow('exclusion-only'); expect(writes(calls)).toEqual([]);
    await provider.applyWrite(op('x_add_targeting_criterion', { ...add, targeting_type: 'APP_LIST', targeting_value: 'app1', operator_type: 'NE' }), guard); expect(writes(calls)).toHaveLength(1);
  });
  it('requires engagement pairs in the final state and retains age/TV constraints', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('x_add_targeting_criterion', { ...add, targeting_type: 'ENGAGEMENT_TYPE', targeting_value: 'ENGAGEMENT' }), guard)).rejects.toThrow('configured together'); expect(writes(calls)).toEqual([]);
    const noLocation = fixture(undefined, []); await expect(noLocation.provider.previewWrite(op('x_add_targeting_criterion', { ...add, targeting_type: 'TV_SHOW', targeting_value: 'show1' }), guard)).rejects.toThrow('included location');
    const age = fixture(undefined, [{ ...location, targeting_type: 'AGE', targeting_value: 'AGE_25_TO_34' }]); await expect(age.provider.previewWrite(op('x_add_targeting_criterion', { ...add, targeting_type: 'AGE', targeting_value: 'AGE_35_TO_44' }), guard)).rejects.toThrow('only one age bucket');
  });
  it('warns when the last included geographic bound is removed even if exclusions remain', async () => {
    const { provider, calls } = fixture(undefined, [location, { ...location, id: 'excluded', targeting_value: 'country-fr', operator_type: 'NE' }]), operation = op('x_remove_targeting_criterion', { targeting_criterion_id: location.id }, 'remove');
    expect((await provider.previewWrite(operation, guard)).changes.join(' ')).toContain('last included LOCATION'); await provider.applyWrite(operation, guard); expect(writes(calls)[0]!.init.method).toBe('DELETE');
  });
  it('verifies operator readback when a create response omits it', async () => {
    const created = { ...location, ...add, id: 'new1', operator_type: 'EQ' };
    const { provider, calls } = fixture(call => { if (call.init.method === 'POST') { const { operator_type: _operator, ...missing } = created; return { data: missing }; } if (call.url.pathname.endsWith('/targeting_criteria/new1')) return { data: created }; });
    expect(await provider.applyWrite(op('x_add_targeting_criterion', add), guard)).toMatchObject({ resourceIds: ['new1'] }); expect(calls.filter(call => call.url.pathname.endsWith('/targeting_criteria/new1'))).toHaveLength(1);
  });
});

describe('X atomic JSON targeting batches', () => {
  const replacement = { line_item_id: L, remove: [location.id], add: [{ targeting_type: 'LOCATION', targeting_value: 'country-de' }] };
  it('shows removed values, applies one ordered JSON batch and signs the URL without treating JSON as form fields', async () => {
    const { provider, calls } = fixture(), operation = op('x_update_targeting', replacement, 'update'), preview = await provider.previewWrite(operation, guard); expect(preview.changes[0]).toContain('country-us'); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [location.id, 'new1'] }); const request = writes(calls)[0]!; expect(request.url.pathname).toBe(`/12/batch/accounts/${A}/targeting_criteria`); expect(request.url.search).toBe(''); expect(new Headers(request.init.headers).get('content-type')).toBe('application/json'); expect(JSON.parse(String(request.init.body))).toEqual([{ operation_type: 'Delete', params: { targeting_criterion_id: location.id } }, { operation_type: 'Create', params: { line_item_id: L, targeting_type: 'LOCATION', targeting_value: 'country-de', operator_type: 'EQ' } }]);
    const percent = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`), oauth = Object.fromEntries(new Headers(request.init.headers).get('authorization')!.replace(/^OAuth /, '').split(', ').map(pair => { const index = pair.indexOf('='); return [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 2, -1))]; })), { oauth_signature, ...rest } = oauth;
    const normalized = Object.entries(rest).map(([key, value]) => `${percent(key)}=${percent(value)}`).sort().join('&'), signatureBase = ['POST', request.url.origin + request.url.pathname, normalized].map(percent).join('&'); expect(oauth_signature).toBe(createHmac('sha1', `${credentials.consumerSecret}&${credentials.accessTokenSecret}`).update(signatureBase).digest('base64'));
  });
  it('configures an engagement pair atomically and validates its campaign source', async () => {
    const { provider, calls } = fixture(), operation = op('x_update_targeting', { line_item_id: L, add: [{ targeting_type: 'ENGAGEMENT_TYPE', targeting_value: 'ENGAGEMENT' }, { targeting_type: 'CAMPAIGN_ENGAGEMENT', targeting_value: C }] }, 'update'); await provider.applyWrite(operation, guard); expect(writes(calls)).toHaveLength(1); expect(JSON.parse(String(writes(calls)[0]!.init.body))).toHaveLength(2);
    const foreign = fixture(call => call.url.pathname.endsWith('/campaigns/source2') ? { data: { id: 'other', name: 'Foreign source', currency: 'EUR', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null } } : undefined); await expect(foreign.provider.previewWrite(op('x_update_targeting', { line_item_id: L, add: [{ targeting_type: 'ENGAGEMENT_TYPE', targeting_value: 'ENGAGEMENT' }, { targeting_type: 'CAMPAIGN_ENGAGEMENT', targeting_value: 'source2' }] }, 'update'), guard)).rejects.toThrow('ID mismatch'); expect(writes(foreign.calls)).toEqual([]);
  });
  it('loads shared source availability once per batch plan and rechecks it freshly on apply', async () => {
    let ready = true;
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/custom_audiences') ? { data: [{ id: 'aud1', targetable: ready, owner_account_id: 'shared-owner', permission_level: 'READ_ONLY', deleted: false }, { id: 'aud2', targetable: ready, owner_account_id: A, permission_level: 'READ_WRITE', deleted: false }], next_cursor: null } : undefined), operation = op('x_update_targeting', { line_item_id: L, add: [{ targeting_type: 'CUSTOM_AUDIENCE', targeting_value: 'aud1' }, { targeting_type: 'CUSTOM_AUDIENCE', targeting_value: 'aud2' }] }, 'update');
    await provider.previewWrite(operation, guard); expect(calls.filter(call => call.url.pathname.endsWith('/custom_audiences'))).toHaveLength(1); expect(writes(calls)).toEqual([]); ready = false;
    await expect(provider.applyWrite(operation, guard)).rejects.toThrow('not targetable'); expect(calls.filter(call => call.url.pathname.endsWith('/custom_audiences'))).toHaveLength(2); expect(writes(calls)).toEqual([]);
  });
  it('rejects foreign removal IDs, duplicate final criteria and removal of a required engagement partner', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('x_update_targeting', { ...replacement, remove: ['foreign'] }, 'update'), guard)).rejects.toThrow('must currently belong'); await expect(provider.previewWrite(op('x_update_targeting', { line_item_id: L, add: [{ targeting_type: 'LOCATION', targeting_value: location.targeting_value }] }, 'update'), guard)).rejects.toThrow('duplicated'); expect(writes(calls)).toEqual([]);
    const paired = fixture(undefined, [location, { ...location, id: 'eng1', targeting_type: 'ENGAGEMENT_TYPE', targeting_value: 'ENGAGEMENT' }, { ...location, id: 'src1', targeting_type: 'CAMPAIGN_ENGAGEMENT', targeting_value: C }]); await expect(paired.provider.previewWrite(op('x_update_targeting', { line_item_id: L, remove: ['eng1'] }, 'update'), guard)).rejects.toThrow('configured together');
  });
  it('retains accepted resource IDs from item-level errors without exposing native payloads or hashes', async () => {
    const secret = 'a'.repeat(64), { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: [{ id: 'native1' }, { id: secret }], operation_errors: [{ message: secret }] } : undefined), error = await provider.applyWrite(op('x_update_targeting', replacement, 'update'), guard).catch(error => error);
    expect(error.message).toContain('rejected batch operations'); expect(error.details).toEqual({ resource_ids: ['native1'] }); expect(JSON.stringify(error)).not.toContain(secret); expect(writes(calls)).toHaveLength(1);
  });
  it('rejects ordered receipt mismatches instead of claiming the batch applied correctly', async () => {
    const { provider } = fixture(call => call.init.method === 'POST' ? { data: [{ ...location, deleted: true }, { ...location, id: 'new1', targeting_value: 'wrong-country' }] } : undefined); await expect(provider.applyWrite(op('x_update_targeting', replacement, 'update'), guard)).rejects.toMatchObject({ details: { resource_ids: [location.id, 'new1'] } });
  });
  it('uses the exact normal preview/apply gate and protected-account checks for an atomic batch', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'x-targeting-')); dirs.push(directory); const { provider, calls } = fixture(), audit = new AuditLog(path.join(directory, 'audit')), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(directory, 'pending')), audit), runtime = await createContext({ engine, providerModules: [{ provider, tools: xTools(provider) }] });
    const args = { account_id: A, ...replacement }, pending = await runtime.registry.call('x_update_targeting', args, runtime.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]); await expect(runtime.registry.call('x_update_targeting', { ...args, remove: [], pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('differs'); await runtime.registry.call('x_update_targeting', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx); expect(writes(calls)).toHaveLength(1);
    const before = calls.length, blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(directory, 'blocked')), audit); await expect(blocked.validate(provider, op('x_update_targeting', replacement, 'update'))).rejects.toThrow('protected'); expect(calls).toHaveLength(before);
  });
});
