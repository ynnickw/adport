import { gzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, CredentialStore, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type NormalizedQuery } from '@adport/core';
import { XAdsClient, type XParams } from '../src/client.js';
import { XAdsAnalytics, X_PLACEMENTS, xAccountMidnight } from '../src/analytics.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';
import { createXModule, resolveXCredentials } from '../src/index.js';

// Official X analytics reference (2026-08-31): time_series_length, id_data,
// metric arrays, id_str jobs and ton.twimg.com gzip downloads. Synthetic data.
const credentials = { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' };
const account = { id: 'a1', name: 'Synthetic account', timezone: 'UTC', timezone_switch_at: null, approval_status: 'ACCEPTED', deleted: false };
const campaign = { id: 'c1', name: 'Synthetic campaign', currency: 'EUR', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_001, total_budget_amount_local_micro: null };
const query: NormalizedQuery = { accountIds: ['a1'], level: 'campaign', dateRange: { start: '2026-08-25', end: '2026-08-27' }, metrics: ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'conversions', 'conversion_value'] };
const metrics = { billed_charge_local_micro: [2_000_000], impressions: [1000], url_clicks: [20] };
function params(url: URL) {
  const raw = Object.fromEntries(url.searchParams);
  return { ...raw, start_time: raw.start_time!, end_time: raw.end_time!, placement: raw.placement!, entity: raw.entity!, granularity: raw.granularity!, entity_ids: raw.entity_ids!.split(','), metric_groups: raw.metric_groups!.split(',') };
}
function stats(p: ReturnType<typeof params>) {
  return { data_type: 'stats', time_series_length: 1, request: { params: p }, data: p.entity_ids.map(id => ({ id, id_data: [{ segment: null, metrics }] })) };
}
type Call = { url: URL; init: RequestInit };
function setup(override?: (call: Call) => unknown | Response | undefined) {
  const calls: Call[] = [];
  let job: Record<string, unknown>;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), call = { url, init }; calls.push(call);
    const custom = override?.(call);
    if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (url.hostname === 'ton.twimg.com') return new Response(gzipSync(JSON.stringify(stats(job as ReturnType<typeof params>))));
    if (url.pathname.includes('/stats/jobs/')) {
      if (init.method === 'POST') {
        job = { ...params(url), id_str: '1120829647711653888', account_id: 'a1', status: 'PROCESSING', url: null };
        return Response.json({ data: job });
      }
      job = { ...job!, status: 'SUCCESS', url: 'https://ton.twimg.com/advertiser-api-async-analytics/stats_job_1120829647711653888.json.gz' };
      return Response.json({ data: [job] });
    }
    if (url.pathname.includes('/stats/accounts/')) return Response.json(stats(params(url)));
    if (url.pathname.endsWith('/campaigns/c1')) return Response.json({ data: { ...campaign, ...(init.method === 'PUT' ? { daily_budget_amount_local_micro: Number(url.searchParams.get('daily_budget_amount_local_micro')) } : {}) } });
    if (url.pathname.endsWith('/campaigns')) return Response.json({ data: [campaign], next_cursor: null });
    return Response.json({ data: account });
  };
  const client = new XAdsClient(credentials, fetchImpl), analytics = new XAdsAnalytics(client, fetchImpl, async () => {});
  return { client, analytics, provider: new XAdsProvider(client, analytics), calls };
}
const dirs: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), 'adport-x-')); dirs.push(dir); return dir; }
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });
function recent() { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-31T00:00:00Z')); }

describe('X normalized reporting', () => {
  it('sums all placements and maps micros and link clicks, not engagement clicks', async () => {
    recent(); const { provider, calls } = setup();
    const result = await provider.report(query);
    expect(result.rows[0]!.metrics).toEqual({ spend: 6, impressions: 3000, clicks: 60, ctr: 2, cpc: 0.1, cpm: 2 });
    const analytics = calls.filter(c => c.url.pathname.includes('/stats/'));
    expect(analytics.map(c => c.url.searchParams.get('placement'))).toEqual([...X_PLACEMENTS]);
    expect(analytics[0]!.url.searchParams.get('end_time')).toBe('2026-08-28T00:00:00.000Z');
    expect(analytics[0]!.url.searchParams.get('metric_groups')).toBe('BILLING,ENGAGEMENT');
    expect(analytics.every(c => c.init.method === 'GET')).toBe(true);
  });
  it('aggregates campaign billing for account reports instead of querying unsupported ACCOUNT billing', async () => {
    recent(); const { provider, calls } = setup(({ url }) => url.pathname.endsWith('/campaigns') ? { data: [campaign, { ...campaign, id: 'c2' }] } : undefined);
    const result = await provider.report({ ...query, level: 'account', limit: 1 });
    expect(result.rows).toHaveLength(1); expect(result.rows[0]!.metrics.spend).toBe(12);
    expect(calls.filter(c => c.url.pathname.includes('/stats/')).every(c => c.url.searchParams.get('entity') === 'CAMPAIGN')).toBe(true);
  });
  it('refuses mixed-currency account totals', async () => {
    const { provider } = setup(({ url }) => url.pathname.endsWith('/campaigns') ? { data: [campaign, { ...campaign, id: 'c2', currency: 'USD' }] } : undefined);
    await expect(provider.report({ ...query, level: 'account' })).rejects.toThrow('different currencies');
  });
  it('handles DST local-midnight boundaries exactly', async () => {
    expect(new Date(xAccountMidnight('2026-03-29', 'Europe/Berlin')).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(new Date(xAccountMidnight('2026-03-30', 'Europe/Berlin')).toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(() => xAccountMidnight('2026-08-25', 'Asia/Kolkata')).toThrow('whole UTC hour');
    expect(() => xAccountMidnight('2026-02-30', 'UTC')).toThrow();
    expect(() => xAccountMidnight('2026-08-25', 'invalid')).toThrow('timezone');
  });
  it('does not relabel historical dates under a newer account timezone', async () => {
    const { provider } = setup(({ url }) => url.pathname.endsWith('/accounts/a1') ? { data: { ...account, timezone_switch_at: '2026-08-26T00:00:00Z' } } : undefined);
    await expect(provider.report(query)).rejects.toThrow('timezone switch');
  });
  it('chunks entity filters into at most 20 IDs and marks row limits', async () => {
    recent(); const campaigns = Array.from({ length: 21 }, (_, i) => ({ ...campaign, id: `c${i}` }));
    const { provider, calls } = setup(({ url }) => url.pathname.endsWith('/campaigns') ? { data: campaigns } : undefined);
    expect((await provider.report(query)).rows).toHaveLength(21);
    expect(calls.filter(c => c.url.pathname.includes('/stats/'))).toHaveLength(6);
    const result = await provider.report({ ...query, limit: 2 }); expect(result.rows).toHaveLength(2); expect(result.truncated).toBe(true);
  });
  it('preserves known null-as-zero and omits a metric missing from any placement', async () => {
    recent(); const { provider } = setup(({ url }) => {
      if (!url.pathname.includes('/stats/')) return undefined;
      const data = stats(params(url));
      data.data[0]!.id_data[0]!.metrics = { ...metrics, billed_charge_local_micro: null as never, url_clicks: url.searchParams.get('placement') === 'TREND' ? undefined as never : [20] };
      return data;
    });
    expect((await provider.report(query)).rows[0]!.metrics).toEqual({ spend: 0, impressions: 3000, cpm: 0 });
  });
  it.each(['wrong-date', 'wrong-placement', 'missing-row', 'duplicate-row', 'segmented'])('rejects %s responses', async fault => {
    recent(); const { provider } = setup(({ url }) => {
      if (!url.pathname.includes('/stats/')) return undefined;
      const data = stats(params(url));
      if (fault === 'wrong-date') data.request.params.start_time = '2000-01-01T00:00:00Z';
      if (fault === 'wrong-placement') data.request.params.placement = 'OTHER';
      if (fault === 'missing-row') data.data = [];
      if (fault === 'duplicate-row') data.data.push(data.data[0]!);
      if (fault === 'segmented') data.data[0]!.id_data[0]!.segment = 'unexpected' as never;
      return data;
    });
    await expect(provider.report(query)).rejects.toThrow('x:');
  });
  it('requests only the metric group needed and declines unsupported-only metrics', async () => {
    recent(); const { provider, calls } = setup();
    await provider.report({ ...query, metrics: ['spend'] });
    expect(calls.find(c => c.url.pathname.includes('/stats/'))!.url.searchParams.get('metric_groups')).toBe('BILLING');
    await expect(provider.report({ ...query, metrics: ['conversions'] })).rejects.toThrow('not yet verified');
  });
  it('reports line items and disambiguates promoted ad IDs from other creative types', async () => {
    recent(); const line = { id: 'l1', name: 'Line item', campaign_id: 'c1', currency: 'EUR', entity_status: 'ACTIVE', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'ENGAGEMENTS' };
    const { provider } = setup(({ url }) => url.pathname.endsWith('/line_items') ? { data: [line] } : url.pathname.endsWith('/promoted_tweets') ? { data: [{ id: 'p1', line_item_id: 'l1', tweet_id: '880290790664060928', entity_status: 'ACTIVE', deleted: false }] } : url.pathname.endsWith('/media_creatives') ? { data: [] } : undefined);
    expect((await provider.report({ ...query, level: 'ad_group' })).rows[0]!.entity.id).toBe('l1');
    expect((await provider.report({ ...query, level: 'ad' })).rows[0]!.entity.id).toBe('PROMOTED_TWEET:p1');
  });
});

describe('X asynchronous analytics contracts', () => {
  it('single-flights identical job requests', async () => {
    const { analytics, calls } = setup();
    const p: XParams = { start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-02T00:00:00Z', entity: 'CAMPAIGN', entity_ids: 'c1', granularity: 'TOTAL', metric_groups: 'ENGAGEMENT', placement: 'ALL_ON_TWITTER' };
    const result = await Promise.all([analytics.totals('a1', p, true), analytics.totals('a1', p, true)]);
    expect(result[0]).toEqual(result[1]); expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(1);
  });
  it('rejects a newly created job for the wrong account before polling or downloading', async () => {
    const { provider, calls } = setup(({ url, init }) => init.method === 'POST' ? { data: { ...params(url), account_id: 'other', id_str: '1120829647711653888', status: 'PROCESSING', url: null } } : undefined);
    await expect(provider.report({ ...query, dateRange: { start: '2020-01-01', end: '2020-01-01' } })).rejects.toThrow('scope');
    expect(calls.some(c => c.url.searchParams.has('job_ids'))).toBe(false);
  });
  it('rejects malformed downloaded data without leaking raw response contents', async () => {
    const { provider } = setup(({ url }) => url.hostname === 'ton.twimg.com' ? new Response(gzipSync('private-invalid-json')) : undefined);
    const error = await provider.report({ ...query, dateRange: { start: '2020-01-01', end: '2020-01-01' } }).catch(e => e);
    expect(error.message).toContain('invalid or oversized'); expect(error.message).not.toContain('private-invalid-json');
  });
  it('bounds decompression output to prevent oversized report archives', async () => {
    const { provider } = setup(({ url }) => url.hostname === 'ton.twimg.com' ? new Response(gzipSync('x'.repeat(21 * 1024 * 1024))) : undefined);
    await expect(provider.report({ ...query, dateRange: { start: '2020-01-01', end: '2020-01-01' } })).rejects.toThrow('oversized');
  });
  it('queues long reports, polls exact string job IDs, and downloads gzip without credentials', async () => {
    const { provider, calls } = setup();
    const result = await provider.report({ ...query, dateRange: { start: '2026-07-01', end: '2026-07-31' } });
    expect(result.rows[0]!.metrics.spend).toBe(12); // two chunks, three placements
    expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(6);
    const poll = calls.find(c => c.url.searchParams.has('job_ids'))!;
    expect(poll.url.searchParams.get('job_ids')).toBe('1120829647711653888');
    const download = calls.find(c => c.url.hostname === 'ton.twimg.com')!;
    expect(download.init.headers).toBeUndefined(); expect(download.init.redirect).toBe('error');
  });
  it('uses async reporting for older short periods as well', async () => {
    const { provider, calls } = setup();
    await provider.report({ ...query, dateRange: { start: '2020-01-01', end: '2020-01-01' } });
    expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(3);
  });
  it('retains a processing job handle on bounded timeout and resumes without creating another', async () => {
    const p: XParams = { start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-02T00:00:00Z', entity: 'CAMPAIGN', entity_ids: 'c1', granularity: 'TOTAL', metric_groups: 'ENGAGEMENT', placement: 'ALL_ON_TWITTER' };
    let polls = 0;
    const { analytics, calls } = setup(({ url }) => {
      if (!url.searchParams.has('job_ids')) return undefined;
      if (++polls > 15) return undefined;
      return { data: [{ ...p, entity_ids: ['c1'], metric_groups: ['ENGAGEMENT'], account_id: 'a1', id_str: '1120829647711653888', status: 'PROCESSING', url: null }] };
    });
    await expect(analytics.totals('a1', p, true)).rejects.toThrow('still processing');
    expect((await analytics.totals('a1', p, true)).data).toHaveLength(1);
    expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(1);
  });
  it.each(['https://evil.test/a.gz', 'http://ton.twimg.com/a.gz', 'https://ton.twimg.com/advertiser-api-async-analytics/stats_job_999.json.gz'])('rejects untrusted/mismatched download URL %s', async unsafe => {
    const { provider, calls } = setup(({ url }) => url.searchParams.has('job_ids') ? { data: [{ start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-02T00:00:00Z', entity: 'CAMPAIGN', entity_ids: ['c1'], granularity: 'TOTAL', metric_groups: ['BILLING', 'ENGAGEMENT'], placement: 'ALL_ON_TWITTER', account_id: 'a1', id_str: '1120829647711653888', status: 'SUCCESS', url: unsafe }] } : undefined);
    await expect(provider.report({ ...query, dateRange: { start: '2026-07-01', end: '2026-07-01' } })).rejects.toThrow('untrusted');
    expect(calls.every(c => c.url.hostname === 'ads-api.x.com')).toBe(true);
  });
});

describe('X shared safety gate and module', () => {
  it('requires an exact pending token, rejects changed args and protected accounts, and applies once', async () => {
    const dir = await temp(), audit = new AuditLog(path.join(dir, 'audit')), { provider, calls } = setup();
    const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), audit);
    const runtime = await createContext({ engine, providerModules: [{ provider, tools: xTools(provider) }] });
    const input = { account_id: 'a1', campaign_id: 'c1', budget_type: 'DAILY', budget_micros: 11_000_001 };
    const pending = await runtime.registry.call('x_set_budget', input, runtime.ctx) as { pending_operation_id: string };
    expect(calls.every(c => c.init.method === 'GET')).toBe(true);
    await expect(runtime.registry.call('x_set_budget', { ...input, ...pending, budget_micros: 12_000_000 }, runtime.ctx)).rejects.toThrow('differs');
    await runtime.registry.call('x_set_budget', { ...input, ...pending }, runtime.ctx);
    expect(calls.filter(c => c.init.method === 'PUT')).toHaveLength(1);
    await expect(runtime.registry.call('x_set_budget', { ...input, budget_micros: 50_000_000 }, runtime.ctx)).rejects.toThrow('budget-delta cap');
    expect(provider.standardActions().pauseCampaign!('a1', 'c1').tool).toBe('x_set_campaign_status');
    const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: ['a1'] }, new PendingStore(path.join(dir, 'blocked')), audit);
    await expect(protectedEngine.validate(provider, { tool: 'x_set_budget', provider: 'x', accountId: 'a1', kind: 'update', payload: input })).rejects.toThrow('protected');
  });
  it('selects a complete stored or environment grant without merging partial secrets', async () => {
    const store = new CredentialStore(await temp());
    for (const field of ['CONSUMER_KEY', 'CONSUMER_SECRET', 'ACCESS_TOKEN', 'ACCESS_TOKEN_SECRET']) vi.stubEnv(`X_${field}`, '');
    await store.set({ provider: 'x', source: 'byo', data: { consumer_key: 'stored' } });
    vi.stubEnv('X_CONSUMER_SECRET', 'secret'); vi.stubEnv('X_ACCESS_TOKEN', 'token'); vi.stubEnv('X_ACCESS_TOKEN_SECRET', 'token-secret');
    expect(await resolveXCredentials(store)).toBeUndefined(); expect(await createXModule(store)).toBeUndefined();
    vi.stubEnv('X_CONSUMER_KEY', 'environment');
    expect(await resolveXCredentials(store)).toMatchObject({ consumerKey: 'environment' });
    expect((await createXModule(store))!.tools.map(t => t.name)).toContain('x_set_budget');
  });
});
