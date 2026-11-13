import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { RedditAdsClient, REDDIT_TOKEN_URL } from '../src/client.js';
import { RedditAdsProvider } from '../src/provider.js';
import { audienceUsers, sendEvents } from '../src/management-tools.js';
import { redditTools } from '../src/tools.js';

// Native paths, envelopes, enums and units verified against Reddit's current v3
// OpenAPI fetched2026-11-03; pre-hashed keys follow Reddit's About Match Keys.
const A = 'a2_test', C = 'campaign-1', U = 'audience-1', S = 'saved-1', P = 'pixel-1', H = 'a'.repeat(64), J = 'b'.repeat(64);
const audience = { id: U, ad_account_id: A, name: 'Customers', type: 'CUSTOMER_LIST', status: 'VALID' };
const saved = { id: S, ad_account_id: A, name: 'Saved', type: 'REDDIT_AUDIENCE', status: 'VALID', active_ad_groups_count: 3, targeting: { communities: ['t5_keep'], geolocations: ['US'], expand_targeting: false } };
type Call = { url: URL; init: RequestInit };
const body = (call: Call) => JSON.parse(String(call.init.body));
const mutations = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET' && call.url.href !== REDDIT_TOKEN_URL);
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'reddit', accountId: A, tool, payload, kind });
const guard = { forcePausedCreation: true };
function fixture(handler?: (call: Call) => unknown) {
  const calls: Call[] = [], client = new RedditAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', userAgent: 'desktop:adport.test:v0.7 (by /u/adporttest)' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === REDDIT_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const value = handler?.(call); if (value !== undefined) return value instanceof Response ? value : Response.json(value);
    const read: Record<string, unknown> = { [`ad_accounts/${A}/custom_audiences`]: [audience], [`custom_audiences/${U}`]: audience, [`ad_accounts/${A}/saved_audiences`]: [saved], [`saved_audiences/${S}`]: saved, [`ad_accounts/${A}/pixels`]: [{ id: P, business_id: 'business-1' }], [`campaigns/${C}`]: { id: C, ad_account_id: A, configured_status: 'PAUSED' }, [`pixels/${P}/last_fired_at`]: { purchase: null, page_visit: '2026-11-02T12:00:00Z' } };
    const key = call.url.pathname.replace('/api/v3/', '');
    if (init.method === 'GET' && read[key]) return Response.json({ data: read[key], pagination: {} });
    throw new Error(`Unexpected fixture request ${init.method} ${key}`);
  });
  return { calls, provider: new RedditAdsProvider(client) };
}
const users = { audience_id: U, action_type: 'ADD' as const, column_order: ['EMAIL_SHA256' as const, 'MAID_SHA256' as const], user_data: [[H, J]] };
const event = { event_at: 1_793_620_800_000, action_source: 'WEBSITE' as const, type: { tracking_type: 'PURCHASE' as const }, metadata: { conversion_id: 'stable-order-123', currency: 'EUR', value: 12.34 }, user: { email: H, ip_address: '192.0.2.1', user_agent: 'QA' }, event_source_url: 'https://example.com/complete', click_id: 'private-click' };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true }); });

describe('Reddit native custom and saved audiences', () => {
  it('creates an empty customer audience only on apply and checks the native receipt', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: { id: U, ad_account_id: A, ...body(call).data } } : undefined), operation = op('reddit_create_customer_audience', { name: 'New customers' }, 'create');
    await provider.previewWrite(operation, guard); expect(mutations(calls)).toEqual([]);
    const result = await provider.applyWrite(operation, guard); expect(result.resourceIds).toEqual([U]); expect(mutations(calls)[0]!.url.pathname).toBe(`/api/v3/ad_accounts/${A}/custom_audiences`); expect(body(mutations(calls)[0]!)).toEqual({ data: { name: 'New customers', type: 'CUSTOMER_LIST' } });
    const malformed = fixture(call => call.init.method === 'POST' ? { data: { id: U, ad_account_id: 'other', ...body(call).data } } : undefined);
    await expect(malformed.provider.applyWrite(operation, guard)).rejects.toMatchObject({ details: { resource_ids: [U] } });
  });
  it('creates pixel retargeting with exact native event/window fields and proves Pixel availability', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: { id: U, ad_account_id: A, ...body(call).data } } : undefined);
    const input = { name: 'Visitors', pixel_audience_config: { pixel_ids: [P], targetings: ['PAGE_VISIT', 'CUSTOM'], custom_targetings: ['pricing'], lookback_window_days: 30 } };
    await provider.applyWrite(op('reddit_create_pixel_audience', input, 'create'), guard); expect(body(mutations(calls)[0]!)).toEqual({ data: { ...input, type: 'PIXEL_RETARGETING' } });
    await expect(provider.previewWrite(op('reddit_create_pixel_audience', { ...input, pixel_audience_config: { ...input.pixel_audience_config, pixel_ids: ['foreign'] } }, 'create'), guard)).rejects.toThrow('not in the account');
    await expect(provider.previewWrite(op('reddit_create_pixel_audience', { ...input, pixel_audience_config: { ...input.pixel_audience_config, lookback_window_days: 91 } }, 'create'), guard)).rejects.toThrow();
  });
  it('verifies engagement campaign ownership and uses native uppercase tracking types', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: { id: U, ad_account_id: A, ...body(call).data } } : undefined);
    const input = { name: 'Viewers', engagement_audience_config: { campaign_ids: [C], tracking_types: ['VIDEO_WATCHED_50_PERCENT'], lookback_window_days: 180 } };
    await provider.applyWrite(op('reddit_create_engagement_audience', input, 'create'), guard); expect(body(mutations(calls)[0]!)).toEqual({ data: { ...input, type: 'ENGAGEMENT_RETARGETING' } });
    const foreign = fixture(call => call.url.pathname === `/api/v3/campaigns/${C}` ? { data: { id: C, ad_account_id: 'foreign' } } : undefined); await expect(foreign.provider.previewWrite(op('reddit_create_engagement_audience', input, 'create'), guard)).rejects.toThrow('ownership'); expect(mutations(foreign.calls)).toEqual([]);
  });
  it.each(['ADD', 'REMOVE'] as const)('uses PATCH for %s membership and keeps identifier rows out of preview', async action_type => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? new Response(null, { status: 204 }) : undefined), input = { ...users, action_type }, operation = op('reddit_update_audience_users', input);
    const preview = await provider.previewWrite(operation, guard); expect(JSON.stringify(preview)).not.toContain(H); expect(JSON.stringify(preview)).not.toContain(J); expect(preview.changes[0]).toContain('EMAIL_SHA256,MAID_SHA256'); expect(mutations(calls)).toEqual([]);
    const result = await provider.applyWrite(operation, guard), { audience_id, ...data } = input; expect(mutations(calls)[0]!.url.pathname).toBe(`/api/v3/custom_audiences/${audience_id}/users`); expect(body(mutations(calls)[0]!)).toEqual({ data }); expect(result.details).toMatchObject({ submitted_rows: 1, payload_sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') });
  });
  it.each([
    { ...users, column_order: ['EMAIL_SHA256'], user_data: [[H, J]] },
    { ...users, column_order: ['EMAIL_SHA256', 'EMAIL_SHA256'] },
    { ...users, user_data: [[H.toUpperCase(), J]] },
    { ...users, user_data: [['person@example.com', J]] },
    { ...users, user_data: [[H, J], [H, J]] },
  ])('rejects malformed, unhashed or duplicate membership rows', input => { expect(audienceUsers.safeParse(input).success).toBe(false); });
  it.each([
    { ...audience, ad_account_id: 'foreign' },
    { ...audience, type: 'PIXEL_RETARGETING' },
    { ...audience, customer_list_config: { origin: 'LIVE_RAMP', origin_client_id: 'provider' } },
  ])('rejects foreign or externally managed membership before writes', async value => {
    const { provider, calls } = fixture(call => call.url.pathname === `/api/v3/custom_audiences/${U}` ? { data: value } : undefined); await expect(provider.previewWrite(op('reddit_update_audience_users', users), guard)).rejects.toThrow(); expect(mutations(calls)).toEqual([]);
  });
  it('permits an available shared audience read and denies deletion of it', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/api/v3/custom_audiences/${U}` ? { data: { ...audience, ad_account_id: 'foreign' } } : undefined);
    expect(await provider.management.audience(A, U)).toMatchObject({ ad_account_id: 'foreign' }); await expect(provider.previewWrite(op('reddit_delete_audience', { audience_id: U }, 'remove'), guard)).rejects.toThrow('shared audiences'); expect(mutations(calls)).toEqual([]);
  });
  it('deletes through the documented custom-audience endpoint and requires an empty native receipt', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined);
    expect(await provider.applyWrite(op('reddit_delete_audience', { audience_id: U }, 'remove'), guard)).toMatchObject({ applied: true, resourceIds: [U] }); expect(mutations(calls)[0]!.url.pathname).toBe(`/api/v3/custom_audiences/${U}`);
    const bad = fixture(call => call.init.method === 'DELETE' ? { data: { id: 'unexpected' } } : undefined); await expect(bad.provider.applyWrite(op('reddit_delete_audience', { audience_id: U }, 'remove'), guard)).rejects.toThrow('unexpected empty mutation receipt');
  });
  it('creates saved targeting with explicit expansion off and merges edits without dropping dimensions', async () => {
    const { provider, calls } = fixture(call => ['POST', 'PATCH'].includes(String(call.init.method)) ? { data: { ...saved, ...body(call).data } } : undefined);
    await provider.applyWrite(op('reddit_create_saved_audience', { name: 'New', targeting: { geolocations: ['CA'] } }, 'create'), guard); expect(body(mutations(calls)[0]!)).toEqual({ data: { name: 'New', type: 'REDDIT_AUDIENCE', targeting: { expand_targeting: false, geolocations: ['CA'] } } });
    const operation = op('reddit_update_saved_audience', { saved_audience_id: S, targeting: { geolocations: ['CA'] } }); expect((await provider.previewWrite(operation, guard)).changes[0]).toContain('Active ad groups: 3'); await provider.applyWrite(operation, guard); expect(body(mutations(calls)[1]!)).toEqual({ data: { targeting: { ...saved.targeting, geolocations: ['CA'] } } });
    await provider.applyWrite(op('reddit_delete_saved_audience', { saved_audience_id: S }, 'remove'), guard); expect(mutations(calls)[2]!.init.method).toBe('PATCH'); expect(body(mutations(calls)[2]!)).toEqual({ data: { status: 'DELETED' } });
  });
  it('refuses unknown saved targeting and unavailable audience references instead of resetting them', async () => {
    const unknown = fixture(call => call.url.pathname === `/api/v3/saved_audiences/${S}` ? { data: { ...saved, targeting: { ...saved.targeting, future_dimension: ['value'] } } } : undefined);
    await expect(unknown.provider.previewWrite(op('reddit_update_saved_audience', { saved_audience_id: S, targeting: { communities: [] } }), guard)).rejects.toThrow('unsupported fields'); expect(mutations(unknown.calls)).toEqual([]);
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('reddit_create_saved_audience', { name: 'Foreign reference', targeting: { custom_audience_ids: ['foreign'] } }, 'create'), guard)).rejects.toThrow('not available'); expect(mutations(calls)).toEqual([]);
  });
  it('keeps the shared policy gate exact and stores no audience identifiers in its audit summaries', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'reddit-audience-')); dirs.push(directory);
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? new Response(null, { status: 204 }) : undefined), audit = new AuditLog(path.join(directory, 'audit')), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(directory, 'pending')), audit), runtime = await createContext({ engine, providerModules: [{ provider, tools: redditTools(provider) }] });
    const args = { ...users, account_id: A }, pending = await runtime.registry.call('reddit_update_audience_users', args, runtime.ctx) as { pending_operation_id: string }; expect(mutations(calls)).toEqual([]);
    await expect(runtime.registry.call('reddit_update_audience_users', { ...args, action_type: 'REMOVE', pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('differs');
    await runtime.registry.call('reddit_update_audience_users', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx); expect(mutations(calls)).toHaveLength(1);
    const entries = await audit.read(); expect(entries.map(entry => entry.event)).toContain('applied'); expect(JSON.stringify(entries)).not.toContain(H); expect(JSON.stringify(entries)).not.toContain(J);
    const blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(directory, 'blocked')), audit); await expect(blocked.validate(provider, op('reddit_update_audience_users', users))).rejects.toThrow('protected');
  });
});

describe('Reddit measurement and native conversion events', () => {
  it('reads native Pixel activity without manufacturing missing timestamps and rejects foreign cursors', async () => {
    const { provider } = fixture(); expect(await provider.management.lastFired(A, P)).toEqual({ pixel_id: P, last_fired_at: { purchase: null, page_visit: '2026-11-02T12:00:00Z' } });
    await expect(provider.management.list({ account_id: A, page_size: 10, cursor: 'https://ads-api.reddit.com/api/v3/ad_accounts/foreign/pixels' }, 'pixels')).rejects.toThrow('scope');
    await expect(provider.management.lastFired(A, 'foreign')).rejects.toThrow('not in the account');
  });
  it('binds test events, native milliseconds and base-currency values while redacting preview data', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: { message: 'Successfully processed 1 conversion events.' } } : undefined), operation = op('reddit_send_conversion_events', { pixel_id: P, test_id: 'events-manager-test', events: [event] }, 'create');
    const preview = await provider.previewWrite(operation, guard); expect(preview.summary).toContain('TEST'); for (const hidden of [H, 'stable-order-123', 'private-click', '192.0.2.1', 'https://example.com/complete']) expect(JSON.stringify(preview)).not.toContain(hidden); expect(mutations(calls)).toEqual([]); expect(preview.budgetDeltas).toEqual([]);
    const result = await provider.applyWrite(operation, guard); expect(mutations(calls)[0]!.url.pathname).toBe(`/api/v3/pixels/${P}/conversion_events`); expect(body(mutations(calls)[0]!)).toEqual({ data: { test_id: 'events-manager-test', events: [event] } }); expect(result.details).toMatchObject({ mode: 'TEST', submitted_events: 1, note: 'Native acceptance does not prove attribution or final processing.' });
  });
  it('makes real measurement explicit and keeps the stable native deduplication ID', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: { message: 'Accepted' } } : undefined), operation = op('reddit_send_conversion_events', { pixel_id: P, mode: 'LIVE', events: [event] }, 'create');
    expect((await provider.previewWrite(operation, guard)).changes[0]).toContain('affect attribution and optimization'); await provider.applyWrite(operation, guard); expect(body(mutations(calls)[0]!)).toEqual({ data: { events: [event] } });
  });
  it.each([
    { pixel_id: P, events: [event] },
    { pixel_id: P, mode: 'LIVE', test_id: 'test', events: [event] },
    { pixel_id: P, test_id: 'test', events: [event, event] },
    { pixel_id: P, test_id: 'test', events: [{ ...event, metadata: { value: 12.34, currency: 'EUR' } }] },
    { pixel_id: P, test_id: 'test', events: [{ ...event, user: { email: 'person@example.com' } }] },
    { pixel_id: P, test_id: 'test', events: [{ ...event, metadata: { conversion_id: 'id', value: 12.34 } }] },
    { pixel_id: P, test_id: 'test', events: [{ ...event, type: { tracking_type: 'CUSTOM' } }] },
  ])('rejects ambiguous modes, duplicate/missing IDs and invalid event/match-key fields', input => { expect(sendEvents.safeParse(input).success).toBe(false); });
  it('does not submit to unavailable Pixels or report success from a malformed native receipt', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { data: {} } : undefined);
    await expect(provider.previewWrite(op('reddit_send_conversion_events', { pixel_id: 'foreign', test_id: 'test', events: [event] }, 'create'), guard)).rejects.toThrow('not in the account'); expect(mutations(calls)).toEqual([]);
    await expect(provider.applyWrite(op('reddit_send_conversion_events', { pixel_id: P, test_id: 'test', events: [event] }, 'create'), guard)).rejects.toThrow('no processing message'); expect(mutations(calls)).toHaveLength(1);
  });
});
