import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '@adport/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenAIAdsClient } from '../src/client.js';
import { OpenAIAdsProvider } from '../src/provider.js';
import { openaiTools } from '../src/tools.js';
import { createOpenAIModule } from '../src/index.js';

// Synthetic fixtures shaped after the official OpenAI Ads API v1 OpenAPI 2.3.0
// schemas and guide examples, reviewed 2026-11-17. See docs/providers/openai.md.
const account = { id: 'adacct_123', name: 'Example', status: 'active', timezone: 'Europe/Paris', currency_code: 'EUR', url: 'https://example.com', preview_url: null, review: { status: 'approved' } };
const campaign = { id: 'cmpn_123', name: 'Launch', status: 'active', description: null, created_at: 1, updated_at: 1, product_feed_id: null, start_time: null, end_time: null, budget: { lifetime_spend_limit_micros: 500_000_000, daily_spend_limit_micros: 50_000_000 }, bidding_type: 'clicks' };
const list = (data: unknown[], hasMore = false, lastId: string | null = null) => ({ object: 'list', data, first_id: null, last_id: lastId, has_more: hasMore });

type Route = { method?: string; path: string; reply: unknown | ((url: URL, init: RequestInit) => unknown); status?: number };
function fixture(routes: Route[]) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = routes.find(r => url.pathname === `/v1/${r.path}` && (r.method ?? 'GET') === init.method);
    if (!route) throw new Error(`Unexpected request ${init.method} ${url.pathname}`);
    const reply = typeof route.reply === 'function' ? (route.reply as (u: URL, i: RequestInit) => unknown)(url, init) : route.reply;
    return Response.json(reply, { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  const provider = new OpenAIAdsProvider(new OpenAIAdsClient({ apiKey: 'sk-test-secret' }, fetchImpl));
  return { provider, calls };
}
const accountRoute: Route = { path: 'ad_account', reply: account };
const guard = { forcePausedCreation: true };
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });

describe('OpenAI Ads transport and accounts', () => {
  it('lists the key-bound ad account with bearer auth and no redirects', async () => {
    const { provider, calls } = fixture([accountRoute]);
    expect(await provider.listAccounts()).toEqual([{ provider: 'openai', id: 'adacct_123', name: 'Example', currency: 'EUR', timezone: 'Europe/Paris', status: 'active' }]);
    expect(calls[0]!.url.href).toBe('https://api.ads.openai.com/v1/ad_account');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer sk-test-secret' });
    expect(calls[0]!.init.redirect).toBe('error');
  });
  it('redacts the API key from provider errors', async () => {
    const { provider } = fixture([{ path: 'ad_account', status: 401, reply: { error: { message: 'bad key sk-test-secret' } } }]);
    const error = await provider.listAccounts().then(() => new Error("expected failure"), (e: Error) => e);
    expect(error.message).toMatch(/openai: HTTP 401/);
    expect(error.message).not.toContain('sk-test-secret');
  });
  it('rejects another account id than the key account', async () => {
    const { provider } = fixture([accountRoute]);
    await expect(provider.listCampaigns('adacct_other')).rejects.toThrow(/does not match/);
  });
  it('follows after cursors and refuses a repeated cursor', async () => {
    const pages = [list([campaign], true, 'cmpn_123'), list([{ ...campaign, id: 'cmpn_456' }])];
    const { provider, calls } = fixture([accountRoute, { path: 'campaigns', reply: () => pages.shift() }]);
    const result = await provider.listCampaigns('adacct_123');
    expect(result.items.map(c => c.id)).toEqual(['cmpn_123', 'cmpn_456']);
    expect(calls.filter(c => c.url.pathname === '/v1/campaigns')[1]!.url.searchParams.get('after')).toBe('cmpn_123');
    const loop = fixture([accountRoute, { path: 'campaigns', reply: list([campaign], true, 'cmpn_123') }]);
    await expect(loop.provider.listCampaigns('adacct_123')).rejects.toThrow(/pagination/);
  });
  it('rejects malformed responses rather than returning empty success', async () => {
    const { provider } = fixture([accountRoute, { path: 'campaigns', reply: { data: 'nope' } }]);
    await expect(provider.listCampaigns('adacct_123')).rejects.toThrow(/malformed/);
  });
});

describe('OpenAI Ads reporting', () => {
  it('requests account insights for an inclusive date range and normalizes metrics', async () => {
    const { provider, calls } = fixture([accountRoute, { path: 'ad_account/insights', reply: list([
      { id: 'r1', start_time: 1, end_time: 2, campaign_id: 'cmpn_123', campaign_name: 'Launch', campaign_status: 'active', impressions: 1000, clicks: 40, spend: 20, conversions: 4, order_created_attributed_sales: 80 },
      { id: 'r2', start_time: 1, end_time: 2, campaign_id: 'cmpn_456', campaign_name: 'Other', impressions: 0, clicks: 0, spend: 0, conversions: null, order_created_attributed_sales: null },
    ]) }]);
    const report = await provider.report({ level: 'campaign', metrics: ['spend', 'clicks', 'ctr', 'cpc', 'conversions', 'roas'], dateRange: { start: '2026-11-01', end: '2026-11-07' } });
    const params = calls.find(c => c.url.pathname === '/v1/ad_account/insights')!.url.searchParams;
    expect(params.get('aggregation_level')).toBe('campaign');
    expect(params.get('time_granularity')).toBe('none');
    expect(JSON.parse(params.getAll('time_ranges')[0]!)).toEqual({ type: 'date_range', since: '2026-11-01', until: '2026-11-07' });
    expect(params.getAll('fields')).toEqual(['campaign.id', 'campaign.name', 'campaign.status', 'campaign.impressions', 'campaign.clicks', 'campaign.spend', 'conversions', 'order_created_attributed_sales']);
    expect(report.rows[0]).toEqual({ provider: 'openai', accountId: 'adacct_123', currency: 'EUR', entity: { level: 'campaign', id: 'cmpn_123', name: 'Launch', status: 'active' }, metrics: { spend: 20, clicks: 40, ctr: 4, cpc: 0.5, conversions: 4, roas: 4 } });
    expect(report.rows[1]!.metrics).toEqual({ spend: 0, clicks: 0 });
  });
  it('queries each account once even when listed twice', async () => {
    const { provider, calls } = fixture([accountRoute, { path: 'ad_account/insights', reply: list([{ id: 'r', start_time: 1, end_time: 2, impressions: 5 }]) }]);
    const report = await provider.report({ accountIds: ['adacct_123', 'adacct_123'], level: 'account', metrics: ['impressions'], dateRange: { start: '2026-11-01', end: '2026-11-01' } });
    expect(report.rows).toHaveLength(1);
    expect(calls.filter(c => c.url.pathname === '/v1/ad_account/insights')).toHaveLength(1);
  });
  it('maps account level to ad_account rows', async () => {
    const { provider, calls } = fixture([accountRoute, { path: 'ad_account/insights', reply: list([{ id: 'r', start_time: 1, end_time: 2, impressions: 5, spend: 1 }]) }]);
    const report = await provider.report({ level: 'account', metrics: ['impressions'], dateRange: { start: '2026-11-01', end: '2026-11-01' } });
    expect(calls.at(-1)!.url.searchParams.get('aggregation_level')).toBe('ad_account');
    expect(calls.at(-1)!.url.searchParams.getAll('fields').slice(0, 3)).toEqual(['ad_account.id', 'ad_account.name', 'ad_account.impressions']);
    expect(report.rows[0]!.entity).toEqual({ level: 'account', id: 'adacct_123', name: 'Example', status: 'active' });
  });
});

describe('OpenAI Ads guarded writes', () => {
  it('forces paused creation, sends an idempotency key and checks the receipt', async () => {
    const { provider, calls } = fixture([accountRoute, { method: 'POST', path: 'campaigns', reply: (_url: URL, init: RequestInit) => ({ ...campaign, id: 'cmpn_new', ...JSON.parse(String(init.body)) }) }]);
    const op = { provider: 'openai', accountId: 'adacct_123', tool: 'openai_create_campaign', kind: 'create' as const, payload: { name: 'New', status: 'active', daily_spend_limit_micros: 10_000_000, target_countries: ['FR'], start_time: '2026-12-01T00:00:00Z' } };
    const preview = await provider.previewWrite(op, guard);
    expect(preview.coercions).toEqual(['status coerced to paused by policy (paused_creation)']);
    expect(preview.budgetDeltas).toEqual([{ target: 'new campaign daily_spend_limit_micros', toMicros: 10_000_000 }]);
    expect(calls.some(c => c.init.method === 'POST')).toBe(false);
    expect(await provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: ['cmpn_new'] });
    const post = calls.find(c => c.init.method === 'POST')!;
    expect(JSON.parse(String(post.init.body))).toEqual({ name: 'New', status: 'paused', budget: { daily_spend_limit_micros: 10_000_000 }, start_time: 1796083200, targeting: { locations: { countries: ['FR'] } } });
    expect((post.init.headers as Record<string, string>)['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('requires a spend limit on creation', async () => {
    const { provider } = fixture([accountRoute]);
    await expect(provider.previewWrite({ provider: 'openai', accountId: 'adacct_123', tool: 'openai_create_campaign', kind: 'create', payload: { name: 'New' } }, guard)).rejects.toThrow();
  });
  it('updates one spend limit, keeps the other and reports the delta', async () => {
    const { provider, calls } = fixture([accountRoute, { path: 'campaigns/cmpn_123', reply: campaign },
      { method: 'POST', path: 'campaigns/cmpn_123', reply: (_u: URL, init: RequestInit) => ({ ...campaign, ...JSON.parse(String(init.body)) }) }]);
    const op = { provider: 'openai', accountId: 'adacct_123', tool: 'openai_set_budget', kind: 'update' as const, payload: { campaign_id: 'cmpn_123', budget_micros: 70_000_000 } };
    expect((await provider.previewWrite(op, guard)).budgetDeltas).toEqual([{ target: 'campaign cmpn_123 daily_spend_limit_micros', fromMicros: 50_000_000, toMicros: 70_000_000 }]);
    await provider.applyWrite(op, guard);
    expect(JSON.parse(String(calls.find(c => c.init.method === 'POST')!.init.body))).toEqual({ budget: { lifetime_spend_limit_micros: 500_000_000, daily_spend_limit_micros: 70_000_000 } });
  });
  it.each([
    ['openai_set_campaign_status', 'campaigns', { campaign_id: 'cmpn_123' }],
    ['openai_set_ad_group_status', 'ad_groups', { ad_group_id: 'cmpn_123' }],
    ['openai_set_ad_status', 'ads', { ad_id: 'cmpn_123' }],
  ])('%s uses the pause action and verifies the receipt', async (tool, resource, ids) => {
    const { provider, calls } = fixture([accountRoute, { path: `${resource}/cmpn_123`, reply: campaign }, { method: 'POST', path: `${resource}/cmpn_123/pause`, reply: { ...campaign, status: 'paused' } }]);
    const op = { provider: 'openai', accountId: 'adacct_123', tool, kind: 'update' as const, payload: { ...ids, status: 'paused' } };
    expect((await provider.previewWrite(op, guard)).changes).toEqual(['~ cmpn_123 status: active → paused']);
    expect(await provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: ['cmpn_123'] });
    expect(calls.at(-1)!.url.pathname).toBe(`/v1/${resource}/cmpn_123/pause`);
  });
  it('fails loudly on a status receipt mismatch', async () => {
    const { provider } = fixture([accountRoute, { path: 'campaigns/cmpn_123', reply: campaign }, { method: 'POST', path: 'campaigns/cmpn_123/pause', reply: campaign }]);
    await expect(provider.applyWrite({ provider: 'openai', accountId: 'adacct_123', tool: 'openai_set_campaign_status', kind: 'update', payload: { campaign_id: 'cmpn_123', status: 'paused' } }, guard)).rejects.toThrow(/receipt mismatch/);
  });
  it('rejects unknown write tools', async () => {
    const { provider } = fixture([accountRoute]);
    await expect(provider.previewWrite({ provider: 'openai', accountId: 'adacct_123', tool: 'openai_delete_everything', kind: 'remove', payload: {} }, guard)).rejects.toThrow(/unsupported/);
  });
});

describe('OpenAI Ads module', () => {
  it('registers guarded write tools with pending operation ids', () => {
    const { provider } = fixture([]);
    const tools = openaiTools(provider);
    expect(tools.map(t => t.name)).toEqual(['openai_conversion_sources', 'openai_conversion_event_settings', 'openai_conversion_events', 'openai_conversion_insights', 'openai_list_campaigns', 'openai_ad_groups', 'openai_ads', 'openai_create_campaign', 'openai_set_campaign_status', 'openai_set_ad_group_status', 'openai_set_ad_status', 'openai_set_budget']);
    for (const tool of tools.filter(t => !t.annotations.readOnly)) expect(tool.input.shape.pending_operation_id).toBeDefined();
  });
  it('loads from stored credentials or OPENAI_ADS_API_KEY', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'adport-openai-')); dirs.push(home);
    vi.stubEnv('ADPORT_HOME', home);
    vi.stubEnv('OPENAI_ADS_API_KEY', '');
    expect(await createOpenAIModule(new CredentialStore())).toBeUndefined();
    vi.stubEnv('OPENAI_ADS_API_KEY', 'sk-env');
    expect((await createOpenAIModule(new CredentialStore()))?.provider.id).toBe('openai');
  });
});

describe('OpenAI Ads conversion reads', () => {
  const tool = (provider: OpenAIAdsProvider, name: string) => openaiTools(provider).find(t => t.name === name)! as unknown as { input: { safeParse: (value: unknown) => { success: boolean } }; handler: (input: unknown, ctx: never) => Promise<unknown> };
  const ctx = {} as never;
  it('lists received events without their payloads', async () => {
    const { provider, calls } = fixture([accountRoute, { path: 'conversions/events', reply: { object: 'list', data: [
      { data_source_id: 'src_1', event_type: 'registration_completed', custom_event_name: null, action_source: 'website', event_timestamp_ms: 1795996800000, received_at_ms: 1795996860000, api_channel: 'conversions_api', event_data_json: '{"user":{"email":"hashed"}}' },
    ] } }]);
    const result = await tool(provider, 'openai_conversion_events').handler({ account_id: 'adacct_123', pixel_id: 'px_1', limit: 50 }, ctx) as { events: Array<Record<string, unknown>> };
    expect(calls.at(-1)!.url.search).toBe('?pid=px_1&limit=50');
    expect(result.events[0]).toMatchObject({ event_type: 'registration_completed', api_channel: 'conversions_api', received_at: '2026-11-30T00:01:00.000Z' });
    expect(result.events[0]).not.toHaveProperty('event_data_json');
  });
  it('posts account-level conversion insights for an inclusive date range', async () => {
    const { provider, calls } = fixture([accountRoute, { method: 'POST', path: 'conversions/insights', reply: { object: 'list', count: 1, account_currency: 'USD', data: [{ entity_id: 'adacct_123', conversions: 12, click_through_conversions: 10, view_through_conversions: 2, order_created_attributed_sales: '120.5', order_created_attributed_sales_currency: 'USD' }] } }]);
    const result = await tool(provider, 'openai_conversion_insights').handler({ account_id: 'adacct_123', since: '2026-11-01', until: '2026-11-07', aggregation_level: 'campaign', time_granularity: 'none', include_events: false }, ctx) as { data: Array<{ conversions: number }> };
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ aggregation_level: 'campaign', time_granularity: 'none', time_ranges: ['{"type":"date_range","since":"2026-11-01","until":"2026-11-07"}'], group_by_entity: false });
    expect(result.data[0]!.conversions).toBe(12);
  });
  it('rejects event names without the event expansion and checks the account first', async () => {
    const { provider } = fixture([accountRoute]);
    expect(tool(provider, 'openai_conversion_insights').input.safeParse({ account_id: 'adacct_123', since: '2026-11-01', until: '2026-11-07', event_names: ['Signup'] }).success).toBe(false);
    await expect(tool(provider, 'openai_conversion_sources').handler({ account_id: 'adacct_other' }, ctx)).rejects.toThrow(/does not match/);
  });
});
