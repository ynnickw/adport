import { gzipSync } from 'node:zlib';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XAdsClient } from '../src/client.js';
import { XAdsAnalytics } from '../src/analytics.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';

// X-owned v12 references at 4e8f626: native app/tracking shapes, query encoding,
// entity/metric-group support and TOTAL framing. Conversion object contents are
// deliberately opaque synthetic examples, not a verified normalization contract.
const accountId = 'a1', resourceId = 't1';
const account = { id: accountId, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false };
const campaign = { id: 'c1', name: 'QA campaign', currency: 'EUR', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null };
const line = { id: 'l1', campaign_id: 'c1', name: 'QA ad group', currency: 'EUR', entity_status: 'ACTIVE', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'WEBSITE_CLICKS' };
const source = { id: resourceId, line_item_id: 'l1', tracking_tag_type: 'IMPRESSION_TAG', tracking_tag_url: 'https://tracker.example.test/a?foo=a+b&value=%20', deleted: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
const app = { id: 'app1', app_store_identifier: 'com.example.qa', os_type: 'ANDROID', conversion_type: 'INSTALL', post_view_attribution_window: 1, post_engagement_attribution_window: 14, retargeting_enabled: true, status: 'TRACKING', deleted: false };
const web = { id: 'web1', name: 'QA <pixel>', type: 'PURCHASE', status: 'TRACKING', deleted: false, click_window: 14, view_through_window: 1, retargeting_enabled: false, embed_code: '<script>globalThis.pixelExecuted=true</script>' };
type Row = Record<string, unknown>;
type Call = { url: URL; init: RequestInit };
type Options = { handler?: (call: Call, written: boolean) => unknown | Response; ignoreWrite?: boolean; readbackError?: boolean };
function fixture(options: Options = {}) {
  const calls: Call[] = [];let current: Row = structuredClone(source), written = false, job: Row;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const call = { url: new URL(String(input)), init };calls.push(call);
    const custom = options.handler?.(call, written);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const route = call.url.pathname.replace(`/12/accounts/${accountId}`, ''), params = Object.fromEntries(call.url.searchParams);
    const response = (data: unknown, paged = false) => Response.json({ data, ...(paged ? { next_cursor: null } : {}), request: { params: { account_id: accountId } } });
    const analytics = () => ({ data_type: 'stats', time_series_length: 1, request: { params: job }, data: (job.entity_ids as string[]).map(id => ({ id, id_data: [{ segment: null, metrics: { conversion_purchases: { metric: [2], order_quantity: [7], sale_amount: [99.25] }, conversion_custom: null, mobile_conversion_installs: { post_view: [3], post_engagement: [4], assisted: [9] }, impressions: [999] } }] })) });
    const fromQuery = () => ({ ...params, entity_ids: params.entity_ids!.split(','), metric_groups: params.metric_groups!.split(',') });
    if (call.url.hostname === 'ton.twimg.com') return new Response(gzipSync(JSON.stringify(analytics())));
    if (call.url.pathname === `/12/stats/accounts/${accountId}`) { job = fromQuery();return Response.json(analytics()); }
    if (call.url.pathname === `/12/stats/jobs/accounts/${accountId}`) {
      if (init.method === 'POST') job = fromQuery();
      const data = { ...job, id_str: '12345', account_id: accountId, status: 'SUCCESS', url: 'https://ton.twimg.com/advertiser-api-async-analytics/stats_job_12345.json.gz' };
      return Response.json({ data: init.method === 'POST' ? data : [data] });
    }
    if (init.method === 'GET') {
      if (route === '') return response(account);
      if (route === '/line_items') return response([line], true);
      if (route === '/campaigns') return response([campaign], true);
      if (route === '/line_items/l1') return response(line);
      if (route === '/campaigns/c1') return response(campaign);
      if (route === '/promoted_tweets/p1') return response({ id: 'p1', line_item_id: 'l1', tweet_id: '123456789123456789', entity_status: 'PAUSED', deleted: false });
      if (route === '/tracking_tags') return response([current], true);
      if (route === `/tracking_tags/${resourceId}`) {
        if (written && options.readbackError) return Response.json({}, { status: 403 });
        return response(current);
      }
      if (route === '/app_event_tags') return response([app], true);
      if (route === '/app_event_tags/app1') return response(app);
      if (route === '/web_event_tags') return response([web], true);
      if (route === '/web_event_tags/web1') return response(web);
    }
    if (route === '/tracking_tags' && init.method === 'POST') { written = true;current = { ...source, ...params };return response(current); }
    if (route === `/tracking_tags/${resourceId}` && ['PUT', 'DELETE'].includes(String(init.method))) { written = true;if (!options.ignoreWrite) current = { ...current, ...params, updated_at: '2026-11-05T00:00:00Z', ...(init.method === 'DELETE' ? { deleted: true } : {}) };return response(current); }
    throw new Error('Unexpected fixture resource');
  };
  const client = new XAdsClient({ consumerKey: 'inert', consumerSecret: 'inert', accessToken: 'inert', accessTokenSecret: 'inert' }, fetchImpl), analytics = new XAdsAnalytics(client, fetchImpl, async () => {}), provider = new XAdsProvider(client, analytics), tools = xTools(provider);
  const op = (tool: string, payload: Row): WriteOperation => ({ tool, provider: 'x', accountId, kind: tool === 'x_create_tracking_tag' ? 'create' : tool === 'x_delete_tracking_tag' ? 'remove' : 'update', payload });
  return { calls, provider, tools, service: provider.measurement, op, mutate: (value: Row) => { current = { ...current, ...value }; } };
}
const writes = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET');
const guard = { forcePausedCreation: true };
const report = { account_id: accountId, entity: 'CAMPAIGN', entity_ids: ['c1'], start_date: '2026-11-01', end_date: '2026-11-02', placement: 'ALL_ON_TWITTER', metric_group: 'WEB_CONVERSION' };
afterEach(() => vi.useRealTimers());
function recent() { vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-05T00:00:00Z')); }

describe('X native measurement inspection', () => {
  it('retains native app identity/windows and returns website embed code only as data', async () => {
    const f = fixture(), appResult = await f.service.listApp({ account_id: accountId, app_event_tag_ids: ['app1'], with_total_count: true, count: 1 });
    expect(appResult.data[0]).toEqual(app);expect(appResult.records[0]).toMatchObject({ post_view_window_days: 1, post_engagement_window_days: 14 });
    expect(await f.service.getApp({ account_id: accountId, app_event_tag_id: 'app1' })).toHaveProperty('data.app_store_identifier', 'com.example.qa');
    expect(await f.service.getWeb({ account_id: accountId, web_event_tag_id: 'web1' })).toHaveProperty('data.embed_code', web.embed_code);
    expect((await f.service.listWeb({ account_id: accountId })).records[0]).toMatchObject({ name: web.name, click_window_days: 14 });
    const native = f.calls.find(call => call.url.pathname.endsWith('/app_event_tags'))!;expect(native.url.searchParams.get('app_event_tag_ids')).toBe('app1');expect(native.url.searchParams.get('with_total_count')).toBe('true');expect(writes(f.calls)).toHaveLength(0);
  });
  it('retains oversized pages, exposes unknown completeness and omits total-count only on continuation', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/app_event_tags') ? { data: [app, { ...app, id: 'app2' }], ...(call.url.searchParams.has('cursor') ? {} : { next_cursor: 'next', total_count: 2 }) } : undefined });
    const first = await f.service.listApp({ account_id: accountId, count: 1, with_total_count: true });expect(first.data).toHaveLength(2);expect(first.complete).toBe(false);expect(first.warnings).toHaveLength(1);
    const next = await f.service.listApp({ account_id: accountId, count: 1, cursor: 'next', with_total_count: true });expect(next.complete).toBeNull();
    expect(f.calls.find(call => call.url.searchParams.has('cursor'))!.url.searchParams.has('with_total_count')).toBe(false);
  });
  it('verifies tracking-tag hierarchy and returns a stable account-bound configuration hash', async () => {
    const f = fixture(), first = await f.service.getTracking({ account_id: accountId, tracking_tag_id: resourceId });
    expect(first.data.configuration_hash).toMatch(/^[a-f0-9]{64}$/);expect((await f.service.listTracking({ account_id: accountId, line_item_ids: ['l1'], tracking_tag_ids: [resourceId] })).data[0]!.configuration_hash).toBe(first.data.configuration_hash);
    f.mutate({ updated_at: '2030-01-01T00:00:00Z' });expect((await f.service.getTracking({ account_id: accountId, tracking_tag_id: resourceId })).data.configuration_hash).toBe(first.data.configuration_hash);
    f.mutate({ tracking_tag_url: 'https://tracker.example.test/other' });expect((await f.service.getTracking({ account_id: accountId, tracking_tag_id: resourceId })).data.configuration_hash).not.toBe(first.data.configuration_hash);
  });
  it.each(['foreign-row', 'foreign-account', 'wrong-filter', 'deleted', 'duplicate', 'cursor-loop'])('rejects %s pages', async fault => {
    const f = fixture({ handler: call => {
      if (!call.url.pathname.endsWith('/app_event_tags')) return undefined;
      const row: Row = { ...app, ...(fault === 'foreign-row' ? { account_id: 'other' } : {}), ...(fault === 'wrong-filter' ? { id: 'other' } : {}), ...(fault === 'deleted' ? { deleted: true } : {}) };
      return { data: fault === 'duplicate' ? [row, row] : [row], next_cursor: fault === 'cursor-loop' ? 'same' : null, request: { params: { account_id: fault === 'foreign-account' ? 'other' : accountId } } };
    } });
    await expect(f.service.listApp({ account_id: accountId, app_event_tag_ids: ['app1'], ...(fault === 'cursor-loop' ? { cursor: 'same' } : {}) })).rejects.toThrow('x:');expect(writes(f.calls)).toHaveLength(0);
  });
  it.each(['id', 'account', 'request-id'])('rejects a single resource with mismatched %s', async fault => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/app_event_tags/app1') ? { data: { ...app, ...(fault === 'id' ? { id: 'other' } : {}), ...(fault === 'account' ? { account_id: 'other' } : {}) }, request: { params: { app_event_tag_id: fault === 'request-id' ? 'other' : 'app1', account_id: accountId } } } : undefined });
    await expect(f.service.getApp({ account_id: accountId, app_event_tag_id: 'app1' })).rejects.toThrow('x:');
  });
  it('rejects a tracking tag outside the selected parent hierarchy', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/line_items') ? { data: [], next_cursor: null } : undefined });await expect(f.service.listTracking({ account_id: accountId })).rejects.toThrow('hierarchy');
  });
  it('bounds parent checks to current-page IDs in native batches of at most 200', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({ ...source, id: `t${index}`, line_item_id: `l${index}` }));
    const f = fixture({ handler: call => {
      if (call.url.pathname.endsWith('/tracking_tags')) return { data: rows, next_cursor: 'more' };
      if (call.url.pathname.endsWith('/line_items')) return { data: call.url.searchParams.get('line_item_ids')!.split(',').map(id => ({ ...line, id })), next_cursor: null };
      return undefined;
    } });
    const result = await f.service.listTracking({ account_id: accountId, count: 200 });expect(result.data).toHaveLength(201);expect(result.complete).toBe(false);expect(result.warnings).toHaveLength(1);
    const parentReads = f.calls.filter(call => call.url.pathname.endsWith('/line_items'));expect(parentReads).toHaveLength(2);expect(parentReads.map(call => call.url.searchParams.get('line_item_ids')!.split(',').length)).toEqual([200, 1]);expect(f.calls.find(call => call.url.pathname.endsWith('/campaigns'))!.url.searchParams.get('campaign_ids')).toBe('c1');
  });
});

describe('X guarded third-party tracking configuration', () => {
  it('previews creation with reads only, signs exact query bytes and verifies independent readback', async () => {
    const f = fixture(), input = { line_item_id: 'l1', tracking_tag_type: 'IMPRESSION_TAG', tracking_tag_url: source.tracking_tag_url }, op = f.op('x_create_tracking_tag', input);
    const preview = await f.provider.previewWrite(op, guard);expect(preview.serverValidated).toBe(false);expect(preview.budgetDeltas).toEqual([]);expect(preview.review?.title).toBe('Associate impression tracker');expect(writes(f.calls)).toHaveLength(0);
    expect(await f.provider.applyWrite(op, guard)).toMatchObject({ applied: true, resourceIds: [resourceId] });
    const write = writes(f.calls)[0]!;expect(write.init.method).toBe('POST');expect(write.url.origin).toBe('https://ads-api.x.com');expect(write.url.pathname).toBe('/12/accounts/a1/tracking_tags');expect(write.url.searchParams.get('tracking_tag_url')).toBe(source.tracking_tag_url);expect(write.init.body).toBeUndefined();expect(new Headers(write.init.headers).get('authorization')).toContain('oauth_signature=');
    expect(f.calls.slice(f.calls.indexOf(write) + 1).some(call => call.url.pathname.endsWith('/tracking_tags/t1') && call.init.method === 'GET')).toBe(true);
  });
  it('changes only URL, preserves type/parent/extra configuration and verifies a deletion tombstone', async () => {
    const f = fixture();f.mutate({ native_extra: { setting: 'preserve' } });let current = (await f.service.getTracking({ account_id: accountId, tracking_tag_id: resourceId })).data;
    await f.provider.applyWrite(f.op('x_update_tracking_tag', { tracking_tag_id: resourceId, expected_configuration_hash: current.configuration_hash, tracking_tag_url: 'https://tracker.example.test/changed?a=1+2' }), guard);
    expect(Object.fromEntries(writes(f.calls)[0]!.url.searchParams)).toEqual({ tracking_tag_url: 'https://tracker.example.test/changed?a=1+2' });
    current = (await f.service.getTracking({ account_id: accountId, tracking_tag_id: resourceId })).data;expect(current).toMatchObject({ native_extra: { setting: 'preserve' }, line_item_id: 'l1', tracking_tag_type: 'IMPRESSION_TAG' });
    expect(await f.provider.applyWrite(f.op('x_delete_tracking_tag', { tracking_tag_id: resourceId, expected_configuration_hash: current.configuration_hash }), guard)).toMatchObject({ applied: true });
    expect(writes(f.calls).at(-1)!.init.method).toBe('DELETE');expect((await f.service.getTracking({ account_id: accountId, tracking_tag_id: resourceId, with_deleted: true })).data.deleted).toBe(true);
  });
  it('rejects stale snapshots and draft/deleted parents before mutation', async () => {
    const f = fixture(), op = f.op('x_update_tracking_tag', { tracking_tag_id: resourceId, expected_configuration_hash: 'a'.repeat(64), tracking_tag_url: 'https://tracker.example.test/change' });await expect(f.provider.applyWrite(op, guard)).rejects.toThrow('configuration changed');expect(writes(f.calls)).toHaveLength(0);
    for (const value of [{ entity_status: 'DRAFT' }, { deleted: true }]) {
      const f = fixture({ handler: call => call.url.pathname.endsWith('/line_items/l1') ? { data: { ...line, ...value } } : undefined });await expect(f.provider.previewWrite(f.op('x_create_tracking_tag', { line_item_id: 'l1', tracking_tag_type: 'CLICK_TRACKER', tracking_tag_url: source.tracking_tag_url }), guard)).rejects.toThrow('non-deleted, non-draft');expect(writes(f.calls)).toHaveLength(0);
    }
  });
  it.each(['http://tracker.example.test', 'https://user:pass@tracker.example.test', 'https://tracker.example.test/#fragment', 'javascript:alert(1)'])('rejects unsafe URL %s before reads', value => {
    const f = fixture(), tool = f.tools.find(tool => tool.name === 'x_create_tracking_tag')!;expect(tool.input.safeParse({ account_id: accountId, line_item_id: 'l1', tracking_tag_type: 'CLICK_TRACKER', tracking_tag_url: value }).success).toBe(false);expect(f.calls).toHaveLength(0);
  });
  it.each(['create', 'update', 'delete'])('retains known IDs after unverified %s without replay', async kind => {
    const f = fixture({ ...(kind === 'create' ? { readbackError: true } : { ignoreWrite: true }) }), hash = (await f.service.getTracking({ account_id: accountId, tracking_tag_id: resourceId })).data.configuration_hash;
    const input = kind === 'create' ? { line_item_id: 'l1', tracking_tag_type: 'IMPRESSION_TAG', tracking_tag_url: source.tracking_tag_url } : { tracking_tag_id: resourceId, expected_configuration_hash: hash, ...(kind === 'update' ? { tracking_tag_url: 'https://tracker.example.test/new' } : {}) };
    await expect(f.provider.applyWrite(f.op(`x_${kind}_tracking_tag`, input), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: [resourceId] } });expect(writes(f.calls)).toHaveLength(1);
  });
  it('retains an ID from a malformed native success and distinguishes pre-acceptance 403', async () => {
    const input = { line_item_id: 'l1', tracking_tag_type: 'IMPRESSION_TAG', tracking_tag_url: source.tracking_tag_url };
    const malformed = fixture({ handler: call => call.init.method === 'POST' ? { data: { id: resourceId }, request: 'invalid-envelope' } : undefined });await expect(malformed.provider.applyWrite(malformed.op('x_create_tracking_tag', input), guard)).rejects.toMatchObject({ details: { resource_ids: [resourceId] } });expect(writes(malformed.calls)).toHaveLength(1);
    const denied = fixture({ handler: call => call.init.method === 'POST' ? Response.json({}, { status: 403 }) : undefined });await expect(denied.provider.applyWrite(denied.op('x_create_tracking_tag', input), guard)).rejects.toMatchObject({ details: { http_status: 403 } });expect(writes(denied.calls)).toHaveLength(1);
  });
  it('uses the shared token hash, apply-time snapshot, one-use token and audit policy boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-x-measurement-')), f = fixture();
    try {
      const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: f.tools }] });
      const hash = (await f.service.getTracking({ account_id: accountId, tracking_tag_id: resourceId })).data.configuration_hash, args = { account_id: accountId, tracking_tag_id: resourceId, expected_configuration_hash: hash, tracking_tag_url: 'https://tracker.example.test/approved' };
      const preview = await runtime.registry.call('x_update_tracking_tag', args, runtime.ctx) as { pending_operation_id: string };expect(writes(f.calls)).toHaveLength(0);
      await expect(runtime.registry.call('x_update_tracking_tag', { ...args, tracking_tag_url: 'https://tracker.example.test/different', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
      expect(await runtime.registry.call('x_update_tracking_tag', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toHaveProperty('result.applied', true);
      await expect(runtime.registry.call('x_update_tracking_tag', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(writes(f.calls)).toHaveLength(1);
      const log = (await Promise.all((await readdir(join(dir, 'audit'))).map(file => readFile(join(dir, 'audit', file), 'utf8')))).join('');expect(log).toContain('applied');expect(log).toContain('x_update_tracking_tag');
      const before = f.calls.length, blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [accountId] }, new PendingStore(join(dir, 'blocked')), new AuditLog(join(dir, 'blocked-audit')));
      await expect(blocked.validate(f.provider, f.op('x_create_tracking_tag', { line_item_id: 'l1', tracking_tag_type: 'CLICK_TRACKER', tracking_tag_url: source.tracking_tag_url }))).rejects.toThrow('protected');expect(f.calls).toHaveLength(before);
      const next = { ...args, expected_configuration_hash: (await f.service.getTracking({ account_id: accountId, tracking_tag_id: resourceId })).data.configuration_hash, tracking_tag_url: 'https://tracker.example.test/next' }, pending = await runtime.registry.call('x_update_tracking_tag', next, runtime.ctx) as { pending_operation_id: string };
      f.mutate({ tracking_tag_url: 'https://tracker.example.test/concurrent' });await expect(runtime.registry.call('x_update_tracking_tag', { ...next, pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('configuration changed');expect(writes(f.calls)).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('X native conversion reporting', () => {
  it('preserves native objects/nulls without mixing order quantities, types, placements or revenue units', async () => {
    recent();const f = fixture(), result = await f.service.conversions(report);
    expect(result.normalized).toBe(false);expect(result.data[0]!.id_data[0]!.metrics).toEqual({ conversion_purchases: { metric: [2], order_quantity: [7], sale_amount: [99.25] }, conversion_custom: null });expect(result).not.toHaveProperty('conversions');expect(result).not.toHaveProperty('roas');
    const stats = f.calls.filter(call => call.url.pathname.includes('/stats/'));expect(stats).toHaveLength(1);expect(stats[0]!.init.method).toBe('GET');expect(stats[0]!.url.searchParams.get('metric_groups')).toBe('WEB_CONVERSION');expect(stats[0]!.url.searchParams.get('end_time')).toBe('2026-11-03T00:00:00.000Z');expect(result.records[0]!.placement).toBe('ALL_ON_TWITTER');
  });
  it('requests mobile conversions separately and verifies a promoted post parent', async () => {
    recent();const f = fixture(), result = await f.service.conversions({ ...report, entity: 'PROMOTED_TWEET', entity_ids: ['p1'], metric_group: 'MOBILE_CONVERSION' });expect(result.data[0]!.id_data[0]!.metrics).toEqual({ mobile_conversion_installs: { post_view: [3], post_engagement: [4], assisted: [9] } });expect(f.calls.find(call => call.url.pathname.includes('/stats/'))!.url.searchParams.get('metric_groups')).toBe('MOBILE_CONVERSION');expect(f.calls.some(call => call.url.pathname.endsWith('/line_items/l1'))).toBe(true);
  });
  it('preserves unknown conversion fields through trusted async download on historical reports', async () => {
    recent();const f = fixture(), result = await f.service.conversions({ ...report, entity: 'LINE_ITEM', entity_ids: ['l1'], start_date: '2026-09-01', end_date: '2026-09-30' });expect(result.data[0]!.id_data[0]!.metrics).toHaveProperty('conversion_purchases.sale_amount', [99.25]);expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);expect(f.calls.find(call => call.url.hostname === 'ton.twimg.com')!.init.headers).toBeUndefined();
  });
  it('uses exact account-local DST boundaries and rejects unknown historical timezone scope', async () => {
    recent();const f = fixture({ handler: call => call.url.pathname === '/12/accounts/a1' ? { data: { ...account, timezone: 'Europe/Berlin' } } : undefined });await f.service.conversions({ ...report, start_date: '2026-10-25', end_date: '2026-10-25' });const stats = f.calls.find(call => call.url.pathname.includes('/stats/'))!;expect(stats.url.searchParams.get('start_time')).toBe('2026-10-24T22:00:00.000Z');expect(stats.url.searchParams.get('end_time')).toBe('2026-10-25T23:00:00.000Z');
    const switched = fixture({ handler: call => call.url.pathname === '/12/accounts/a1' ? { data: { ...account, timezone_switch_at: '2026-11-02T00:00:00Z' } } : undefined });await expect(switched.service.conversions(report)).rejects.toThrow('timezone switch');expect(switched.calls.some(call => call.url.pathname.includes('/stats/'))).toBe(false);
  });
  it('rejects incorrect entity/scope results without returning partial conversions', async () => {
    recent();const f = fixture({ handler: call => call.url.pathname.endsWith('/campaigns/c1') ? { data: { ...campaign, id: 'other' } } : undefined });await expect(f.service.conversions(report)).rejects.toThrow('ID mismatch');expect(f.calls.some(call => call.url.pathname.includes('/stats/'))).toBe(false);
    const wrong = fixture({ handler: call => call.url.pathname === '/12/stats/accounts/a1' ? { data_type: 'stats', time_series_length: 1, data: [{ id: 'c1', id_data: [{ segment: null, metrics: { conversion_purchases: null } }] }], request: { params: { start_time: '2026-11-01T00:00:00Z', end_time: '2026-11-03T00:00:00Z', entity: 'CAMPAIGN', entity_ids: ['c1'], placement: 'TREND', granularity: 'TOTAL', metric_groups: ['WEB_CONVERSION'] } } } : undefined });await expect(wrong.service.conversions(report)).rejects.toThrow('scoped');
  });
  it('rejects a native analytics account echo that differs from the selected account', async () => {
    recent();const f = fixture({ handler: call => call.url.pathname === '/12/stats/accounts/a1' ? { data_type: 'stats', time_series_length: 1, data: [{ id: 'c1', id_data: [{ segment: null, metrics: { conversion_purchases: null } }] }], request: { params: { account_id: 'other', start_time: '2026-11-01T00:00:00Z', end_time: '2026-11-03T00:00:00Z', entity: 'CAMPAIGN', entity_ids: ['c1'], placement: 'ALL_ON_TWITTER', granularity: 'TOTAL', metric_groups: ['WEB_CONVERSION'] } } } : undefined });await expect(f.service.conversions(report)).rejects.toThrow('scoped');
  });
  it.each([{ end_date: '2026-12-02' }, { entity_ids: ['c1', 'c1'] }, { metric_group: 'WEB_CONVERSION,MOBILE_CONVERSION' }, { entity: 'ACCOUNT' }, { end_date: '2026-10-31' }])('rejects unbounded/unsupported input %o before requests', async values => {
    const f = fixture();await expect(f.service.conversions({ ...report, ...values })).rejects.toThrow();expect(f.calls).toHaveLength(0);
  });
});
