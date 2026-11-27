import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, CredentialStore } from '@adport/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GravityClient } from '../src/client.js';
import { GravityProvider } from '../src/provider.js';
import { gravityTools, listConversions } from '../src/tools.js';
import { createGravityModule } from '../src/index.js';

// Synthetic fixtures shaped after the official Gravity advertiser Dashboard API
// reference examples, reviewed 2026-11-27. See docs/providers/gravity.md.
const info = { advertiser_id: 'abc-123', name: 'Acme Corp', email: 'ads@example.com' };
const campaign = {
  campaign_id: 'camp-456', name: 'Summer Sale', status: 'active', is_active: true, daily_budget: 100.0, budget_type: 'daily',
  landing_page: 'https://example.com/summer', campaign_objective: 'conversions', billing_model: 'cpm', created_at: '2025-05-01T00:00:00',
  start_time: '2025-05-01T00:00:00', end_time: null, delivery_status: 'eligible', delivery_issues: [],
  impressions: 350000, clicks: 1800, spend: 875.5, conversions: 42, click_through_conversions: 40, view_through_conversions: 2, conversion_value: 4200.0,
};
const metrics = (spend: number, impressions: number, clicks: number, conversions: number, revenue: number | null) => ({
  data: [], total_impressions: impressions, total_clicks: clicks, total_spend: spend, total_conversions: conversions, total_revenue: revenue,
});

type Route = { method?: string; path: string; reply: unknown | ((url: URL, init: RequestInit) => unknown); status?: number; headers?: Record<string, string> };
function fixture(routes: Route[]) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = routes.find(r => url.pathname === `/advertiser-dashboard/${r.path}` && (r.method ?? 'GET') === init.method);
    if (!route) throw new Error(`Unexpected request ${init.method} ${url.pathname}`);
    const reply = typeof route.reply === 'function' ? (route.reply as (u: URL, i: RequestInit) => unknown)(url, init) : route.reply;
    return Response.json(reply, { status: route.status ?? 200, headers: route.headers });
  }) as unknown as typeof fetch;
  const provider = new GravityProvider(new GravityClient({ apiKey: 'grv-test-secret' }, fetchImpl));
  return { provider, calls };
}
const infoRoute: Route = { path: 'info', reply: info };
const guard = { forcePausedCreation: true };
const body = (call: { init: RequestInit }) => JSON.parse(String(call.init.body));
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });

describe('Gravity transport and accounts', () => {
  it('lists the key-bound advertiser with X-API-Key auth, no redirects and no email', async () => {
    const { provider, calls } = fixture([infoRoute]);
    const accounts = await provider.listAccounts();
    expect(accounts).toEqual([{ provider: 'gravity', id: 'abc-123', name: 'Acme Corp', currency: 'USD', timezone: 'UTC' }]);
    expect(JSON.stringify(accounts)).not.toContain('example.com');
    expect(calls[0]!.url.href).toBe('https://platform.trygravity.com/advertiser-dashboard/info');
    expect(calls[0]!.init.headers).toMatchObject({ 'x-api-key': 'grv-test-secret' });
    expect(calls[0]!.init.headers).not.toHaveProperty('authorization');
    expect(calls[0]!.init.redirect).toBe('error');
  });
  it('preserves the structured error code returned by the public advertiser endpoint', async () => {
    const { provider } = fixture([{ path: 'info', status: 401, reply: { detail: 'Missing API key',
      error: { code: 'auth_missing', message: 'No API key was sent with this request.', retryable: false } } }]);
    await expect(provider.listAccounts()).rejects.toMatchObject({ details: { http_status: 401, provider_code: 'auth_missing' } });
    const offline = new GravityProvider(new GravityClient({ apiKey: 'fixture' }, async () => { throw new TypeError('fetch failed'); }));
    await expect(offline.listAccounts()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('redacts the API key and surfaces detail messages and codes', async () => {
    const { provider } = fixture([{ path: 'info', status: 401, reply: { detail: 'Invalid API key grv-test-secret' } }]);
    const error = await provider.listAccounts().then(() => new Error('expected failure'), (e: Error) => e);
    expect(error.message).toMatch(/gravity: HTTP 401/);
    expect(error.message).toContain('Invalid API key');
    expect(error.message).not.toContain('grv-test-secret');
    const conflict = fixture([infoRoute, { path: 'campaigns/camp-456', reply: { ...campaign, status: 'paused' } },
      { method: 'PATCH', path: 'campaigns/camp-456', status: 409, reply: { detail: { code: 'capi_event_not_received', event_type: 'purchase', message: 'No live CAPI event' } } }]);
    const op = { provider: 'gravity', accountId: 'abc-123', tool: 'gravity_set_campaign_status', kind: 'update' as const, payload: { campaign_id: 'camp-456', status: 'active' } };
    await expect(conflict.provider.applyWrite(op, guard)).rejects.toMatchObject({ message: expect.stringContaining('No live CAPI event'), details: { http_status: 409, provider_code: 'capi_event_not_received' } });
  });
  it('explains rate limits with Retry-After', async () => {
    const { provider } = fixture([{ path: 'info', status: 429, reply: {}, headers: { 'retry-after': '3' } }]);
    await expect(provider.listAccounts()).rejects.toThrow(/retry after 3 s/);
  });
  it('rejects another account id than the key advertiser', async () => {
    const { provider } = fixture([infoRoute]);
    await expect(provider.listCampaigns('other-advertiser')).rejects.toThrow(/does not match/);
  });
  it('rejects malformed responses rather than returning empty success', async () => {
    const { provider } = fixture([infoRoute, { path: 'campaigns', reply: { campaigns: 'nope' } }]);
    await expect(provider.listCampaigns('abc-123')).rejects.toThrow(/malformed/);
  });
  it('passes list filters as query parameters', async () => {
    const { provider, calls } = fixture([infoRoute, { path: 'campaigns', reply: { campaigns: [campaign] } }, { path: 'ad-groups', reply: [] }]);
    expect((await provider.listCampaigns('abc-123', 'paused')).items).toHaveLength(1);
    await provider.listAdGroups('abc-123', 'camp-456', true);
    expect(calls[1]!.url.searchParams.get('status')).toBe('paused');
    expect(Object.fromEntries(calls[2]!.url.searchParams)).toEqual({ campaign_id: 'camp-456', include_archived: 'true' });
  });
});

describe('Gravity reporting', () => {
  const range = { start: '2026-11-01', end: '2026-11-07' };
  it('reports account totals for an inclusive UTC date range', async () => {
    const { provider, calls } = fixture([infoRoute, { path: 'metrics', reply: metrics(875.5, 350000, 1800, 42, 4200) }]);
    const report = await provider.report({ level: 'account', metrics: ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'conversions', 'cpa', 'conversion_value', 'roas'], dateRange: range });
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ start_date: '2026-11-01', end_date: '2026-11-07', tz: 'UTC' });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ provider: 'gravity', accountId: 'abc-123', currency: 'USD', entity: { level: 'account', id: 'abc-123', name: 'Acme Corp' } });
    const m = report.rows[0]!.metrics;
    expect(m).toMatchObject({ spend: 875.5, impressions: 350000, clicks: 1800, conversions: 42, conversion_value: 4200 });
    expect(m.ctr).toBeCloseTo(1800 / 350000 * 100);
    expect(m.cpm).toBeCloseTo(875.5 / 350);
    expect(m.roas).toBeCloseTo(4200 / 875.5);
  });
  it('reads one metrics series per campaign and omits ratios with a zero denominator', async () => {
    const other = { ...campaign, campaign_id: 'camp-789', name: 'Draft', status: 'draft' };
    const { provider, calls } = fixture([infoRoute, { path: 'campaigns', reply: { campaigns: [campaign, other] } },
      { path: 'metrics', reply: (url: URL) => url.searchParams.get('campaign_id') === 'camp-456' ? metrics(20, 1000, 40, 4, 80) : metrics(0, 0, 0, 0, null) }]);
    const report = await provider.report({ level: 'campaign', metrics: ['spend', 'clicks', 'ctr', 'cpc', 'conversion_value', 'roas'], dateRange: range });
    expect(calls.filter(c => c.url.pathname.endsWith('/metrics')).map(c => c.url.searchParams.get('campaign_id'))).toEqual(['camp-456', 'camp-789']);
    expect(report.rows.map(r => r.entity)).toEqual([{ level: 'campaign', id: 'camp-456', name: 'Summer Sale', status: 'active' }, { level: 'campaign', id: 'camp-789', name: 'Draft', status: 'draft' }]);
    expect(report.rows[0]!.metrics).toEqual({ spend: 20, clicks: 40, ctr: 4, cpc: 0.5, conversion_value: 80, roas: 4 });
    expect(report.rows[1]!.metrics).toEqual({ spend: 0, clicks: 0 });
    const limited = await provider.report({ level: 'campaign', metrics: ['spend'], dateRange: range, limit: 1 });
    expect(limited).toMatchObject({ rows: [expect.anything()], truncated: true });
  });
  it('pages ad group metrics by offset while truncated', async () => {
    const group = (id: string) => ({ ad_group_id: id, campaign_id: 'camp-456', name: id, status: 'active', group_type: 'generative', total_impressions: 10, total_clicks: 1, total_spend: 0.5, total_conversions: 0, total_revenue: null, data: [] });
    const pages = [
      { ad_groups: [group('adg-1'), group('adg-2')], total_ad_groups: 3, offset: 0, truncated: true },
      { ad_groups: [group('adg-3')], total_ad_groups: 3, offset: 2, truncated: false },
    ];
    const { provider, calls } = fixture([infoRoute, { path: 'ad-group-metrics', reply: () => pages.shift() }]);
    const report = await provider.report({ level: 'ad_group', metrics: ['spend', 'conversions', 'cpa'], dateRange: range });
    expect(calls.filter(c => c.url.pathname.endsWith('/ad-group-metrics')).map(c => c.url.searchParams.get('offset'))).toEqual(['0', '2']);
    expect(report.rows.map(r => r.entity.id)).toEqual(['adg-1', 'adg-2', 'adg-3']);
    expect(report.rows[0]!.metrics).toEqual({ spend: 0.5, conversions: 0 });
    const first = { ad_groups: [group('adg-1')], total_ad_groups: 2, offset: 0, truncated: true };
    const capped = fixture([infoRoute, { path: 'ad-group-metrics', reply: first }]);
    await expect(capped.provider.report({ level: 'ad_group', metrics: ['spend'], dateRange: range, limit: 1 })).resolves.toMatchObject({ truncated: true });
    expect(capped.calls.filter(c => c.url.pathname.endsWith('/ad-group-metrics'))).toHaveLength(1);
    for (const last of [{ ...first, offset: 1, truncated: false }, { ...first, ad_groups: [group('adg-2')], truncated: false }]) {
      const pages = [first, last];
      const bad = fixture([infoRoute, { path: 'ad-group-metrics', reply: () => pages.shift() }]);
      await expect(bad.provider.report({ level: 'ad_group', metrics: ['spend'], dateRange: range })).rejects.toThrow(/overlapping|offset/);
    }
    const stuck = fixture([infoRoute, { path: 'ad-group-metrics', reply: { ad_groups: [], total_ad_groups: 3, truncated: true } }]);
    await expect(stuck.provider.report({ level: 'ad_group', metrics: ['spend'], dateRange: range })).rejects.toThrow(/truncated but the page is empty/);
  });
  it('reports the ad level from ad unit metrics without conversions', async () => {
    const { provider } = fixture([infoRoute, { path: 'ad-unit-metrics', reply: { ad_units: [{ ad_unit_id: 'ad-123', campaign_id: 'camp-456', name: 'Brand Voice', data_source: 'ad_unit_stats', total_impressions: 19784, total_clicks: 131, total_spend: 88.2, data: [] }, { ad_unit_id: 'ad-123', campaign_id: 'camp-789', name: 'Brand Voice', data_source: 'campaign_fallback', total_spend: 8, total_conversions: 3 }] } }]);
    const report = await provider.report({ level: 'ad', metrics: ['spend', 'clicks', 'conversions'], dateRange: range });
    expect(report.rows).toMatchObject([
      { entity: { level: 'ad', id: 'camp-456/ad-123', name: 'Brand Voice · camp-456' }, metrics: { spend: 88.2, clicks: 131 } },
      { entity: { id: 'camp-789/ad-123', name: 'Brand Voice · camp-789 (campaign totals)' }, metrics: { spend: 8 } },
    ]);
    expect(report.rows[1]!.metrics).not.toHaveProperty('conversions');
  });
});

describe('Gravity conversions and billing', () => {
  it('follows next_cursor pages up to the requested limit and refuses a repeated cursor', async () => {
    const conversion = (id: string) => ({ conversion_id: id, event_type: 'purchase', value_cents: 9999, currency: 'USD', conversion_timestamp: '2025-05-20T14:30:00', campaign_id: 'camp-456', source: 'capi', is_attributed: true, attribution_type: 'click_through' });
    const pages = [
      { conversions: [conversion('conv-2')], total_conversions: 2, total_view_through_conversions: 0, has_more: true, next_cursor: 'conv-1' },
      { conversions: [conversion('conv-1')], total_click_through_conversions: 2, has_more: false, next_cursor: null },
    ];
    const { provider, calls } = fixture([infoRoute, { path: 'conversions', reply: () => pages.shift() }]);
    const result = await listConversions(provider, { account_id: 'abc-123', event_type: 'purchase', limit: 100 });
    expect(result.items.map(c => c.conversion_id)).toEqual(['conv-2', 'conv-1']);
    expect(result).toMatchObject({ total_conversions: 2, total_click_through_conversions: 2, total_view_through_conversions: 0 });
    const second = calls.filter(c => c.url.pathname.endsWith('/conversions'))[1]!.url.searchParams;
    expect(Object.fromEntries(second)).toEqual({ limit: '99', cursor: 'conv-1', event_type: 'purchase' });
    const loop = fixture([infoRoute, { path: 'conversions', reply: { conversions: [conversion('conv-2')], has_more: true, next_cursor: 'conv-1' } }]);
    await expect(listConversions(loop.provider, { account_id: 'abc-123', limit: 500 })).rejects.toThrow(/pagination/);
  });
  it('reads the billing summary for the key advertiser only', async () => {
    const { provider } = fixture([infoRoute, { path: 'billing', reply: { total_spend_dollars: 875.5, total_billed_dollars: 800, unbilled_dollars: 75.5, credits_dollars: 0, billing_enabled: true } }]);
    const billing = gravityTools(provider).find(tool => tool.name === 'gravity_billing')!;
    await expect(billing.handler({ account_id: 'abc-123' } as never, {} as never)).resolves.toMatchObject({ unbilled_dollars: 75.5 });
    await expect(billing.handler({ account_id: 'nope' } as never, {} as never)).rejects.toThrow(/does not match/);
  });
  it('reads only the selected group and reports the native ad count and truncation', async () => {
    const ad = { id: 'ad-1', ad_group_id: 'group-1', status: 'paused', headline: 'Test' };
    const group = { id: 'group-1', campaign_id: 'camp-456', name: 'Manual group', status: 'paused', ads: [ad], ads_total: 4 };
    const { provider } = fixture([infoRoute, { path: 'ad-groups/group-1', reply: group }]);
    const rt = await createContext({ providerModules: [{ provider, tools: gravityTools(provider) }] });
    const args = { account_id: info.advertiser_id, ad_group_id: 'group-1' };
    expect(await rt.registry.call('gravity_ads', args, rt.ctx)).toEqual({ items: [ad], total_count: 4, truncated: true });
    await expect(rt.registry.call('gravity_ads', { ...args, account_id: 'foreign' }, rt.ctx)).rejects.toThrow(/does not match/);
    const mismatch = fixture([infoRoute, { path: 'ad-groups/group-1', reply: { ...group, id: 'group-2' } }]);
    const bad = await createContext({ providerModules: [{ provider: mismatch.provider, tools: gravityTools(mismatch.provider) }] });
    await expect(bad.registry.call('gravity_ads', args, bad.ctx)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('reads a specific ad, pixel health and dated conversion totals using the advertiser API contracts', async () => {
    const ad = { id: 'ad-901', source: 'manual', status: 'paused', review_status: 'pending', headline: 'Trail shoes' };
    const pixel = { pixel_id: 'pix-123', name: 'Shop', url: 'https://example.org', is_active: true, is_functional: null };
    const stats = { total: 12, time_series: [{ date: '2026-11-02T00:00:00', conversions: 12 }], by_event_type: [{ event_type: 'lead', total: 12 }] };
    const { provider, calls } = fixture([infoRoute, { path: 'ads/ad-901', reply: ad }, { path: 'pixels', reply: [{ ...pixel, internal: 'private' }] },
      { path: 'events/conversion-stats', reply: stats }]);
    const runtime = await createContext({ providerModules: [{ provider, tools: gravityTools(provider) }] });
    const read = (name: string, fields: object) => runtime.registry.call(name, { account_id: info.advertiser_id, ...fields }, runtime.ctx);
    expect(await read('gravity_get_ad', { ad_id: ad.id })).toEqual(ad);
    expect(await read('gravity_pixels', {})).toEqual({ items: [pixel] });
    expect(await read('gravity_conversion_stats', { start_date: '2026-11-01', end_date: '2026-11-03', event_type: 'lead' })).toEqual(stats);
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ start_date: '2026-11-01', end_date: '2026-11-03', event_type: 'lead' });
    await expect(read('gravity_conversion_stats', { days: 2, start_date: '2026-11-01' })).rejects.toThrow();
    await expect(read('gravity_pixels', { account_id: 'unselected' })).rejects.toThrow(/does not match/);
  });
});

describe('Gravity guarded writes', () => {
  it('refuses authored ads in generative groups and mismatched create receipts', async () => {
    const ad = { headline: 'Trail shoes', copy: 'Grip every trail.', cta: 'Shop', landing_page: 'https://example.org/trail', ad_group_id: 'group' };
    const group = { id: 'group', campaign_id: campaign.campaign_id, name: 'Trail', status: 'paused' };
    const op = { provider: 'gravity', accountId: info.advertiser_id, kind: 'create' as const };
    const wrongGroup = fixture([infoRoute, { path: 'ad-groups/group', reply: { ...group, group_type: 'generative' } }]);
    await expect(wrongGroup.provider.previewWrite({ ...op, tool: 'gravity_create_ad', payload: ad }, guard)).rejects.toThrow(/manual ad group/);
    expect(wrongGroup.calls.every(call => call.init.method === 'GET')).toBe(true);
    const { provider } = fixture([infoRoute, { path: 'campaigns/camp-456', reply: campaign }, { path: 'ad-groups/group', reply: { ...group, group_type: 'manual' } },
      { path: 'ad-groups', method: 'POST', reply: { ...group, group_type: 'manual', campaign_id: 'different' } },
      { path: 'ad-groups/group/ads', method: 'POST', reply: { ...ad, id: 'created-ad', campaign_id: campaign.campaign_id, source: 'manual', status: 'active' } },
      { path: 'pixels', method: 'POST', reply: { pixel_id: 'created-pixel', name: 'Another', url: 'https://wrong.example.org', is_active: true, is_functional: null } }]);
    for (const [tool, payload, id] of [
      ['gravity_create_ad_group', { campaign_id: campaign.campaign_id, name: group.name, group_type: 'manual' }, group.id],
      ['gravity_create_ad', ad, 'created-ad'], ['gravity_create_pixel', { url: 'https://example.org' }, 'created-pixel'],
    ] as const) {
      await expect(provider.applyWrite({ ...op, tool, payload }, guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: [id] } });
    }
  });
  const createInput = { name: 'Launch', landing_page: 'https://example.com/launch', status: 'active', campaign_objective: 'clicks', daily_budget_micros: 50_000_000, context: 'Email signature software for teams', brand_name: 'Acme', allowed_countries: ['US', 'FR'] };
  it('creates a campaign with one generative ad group, coerces active to paused and converts micros to dollars', async () => {
    const { provider, calls } = fixture([infoRoute, { method: 'POST', path: 'campaigns', status: 201, reply: (_url: URL, init: RequestInit) => {
      const sent = JSON.parse(String(init.body));
      return { ...campaign, campaign_id: 'camp-new', name: sent.name, status: sent.status, campaign_objective: sent.campaign_objective, daily_budget: sent.daily_budget, ad_groups: [{ id: 'adg-new', campaign_id: 'camp-new', name: sent.ad_groups[0].name, group_type: 'generative', status: 'active', ads: [], ads_total: 0 }] };
    } }]);
    const op = { provider: 'gravity', accountId: 'abc-123', tool: 'gravity_create_campaign', kind: 'create' as const, payload: createInput };
    const preview = await provider.previewWrite(op, guard);
    expect(preview).toMatchObject({ serverValidated: false, coercions: ['status coerced to paused by policy (paused_creation)'], budgetDeltas: [{ target: 'new campaign daily_budget', toMicros: 50_000_000 }] });
    expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(0);
    expect(await provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: ['camp-new', 'adg-new'] });
    expect(body(calls.find(c => c.init.method === 'POST')!)).toEqual({
      name: 'Launch', landing_page: 'https://example.com/launch', status: 'paused', campaign_objective: 'clicks', budget_type: 'daily', daily_budget: 50,
      allowed_countries: ['US', 'FR'], ad_groups: [{ name: 'Launch (Generative)', group_type: 'generative', context: 'Email signature software for teams', brand_name: 'Acme' }],
    });
  });
  it('keeps drafts as drafts and rejects receipt mismatches with the new id', async () => {
    const { provider, calls } = fixture([infoRoute, { method: 'POST', path: 'campaigns', reply: { ...campaign, campaign_id: 'camp-new', name: 'Launch', status: 'active', campaign_objective: 'clicks', daily_budget: 50, ad_groups: [] } }]);
    const op = { provider: 'gravity', accountId: 'abc-123', tool: 'gravity_create_campaign', kind: 'create' as const, payload: { ...createInput, status: 'draft' } };
    expect((await provider.previewWrite(op, guard)).coercions).toEqual([]);
    await expect(provider.applyWrite(op, guard)).rejects.toMatchObject({ message: expect.stringMatching(/receipt mismatch/), details: { resource_ids: ['camp-new'] } });
    expect(body(calls.find(c => c.init.method === 'POST')!).status).toBe('draft');
  });
  it('reconciles a campaign receipt that points to another campaign’s group', async () => {
    const receipt = { ...campaign, campaign_id: 'camp-new', name: 'Launch', status: 'paused', campaign_objective: 'clicks', daily_budget: 50,
      ad_groups: [{ id: 'other-group', name: 'Launch (Generative)', group_type: 'generative', campaign_id: 'other-campaign', status: 'active' }] };
    const { provider } = fixture([infoRoute, { method: 'POST', path: 'campaigns', reply: receipt }]);
    await expect(provider.applyWrite({ provider: 'gravity', accountId: 'abc-123', tool: 'gravity_create_campaign', kind: 'create', payload: createInput }, guard))
      .rejects.toMatchObject({ details: { resource_ids: ['camp-new'] } });
  });
  it('validates budgets, schedules and conversion settings locally', async () => {
    const { provider } = fixture([infoRoute]);
    const op = (payload: Record<string, unknown>) => ({ provider: 'gravity', accountId: 'abc-123', tool: 'gravity_create_campaign', kind: 'create' as const, payload: { ...createInput, ...payload } });
    await expect(provider.previewWrite(op({ daily_budget_micros: 1_234_567 }), guard)).rejects.toThrow(/whole cents/);
    await expect(provider.previewWrite(op({ total_budget_micros: 100_000_000 }), guard)).rejects.toThrow(/exactly one/);
    await expect(provider.previewWrite(op({ daily_budget_micros: undefined, total_budget_micros: 100_000_000 }), guard)).rejects.toThrow(/end_time/);
    await expect(provider.previewWrite(op({ campaign_objective: 'conversions' }), guard)).rejects.toThrow(/conversion_type/);
    await expect(provider.previewWrite(op({ keywords: ['x'] }), guard)).rejects.toThrow();
  });
  it('changes the existing budget type with a before/after delta and refuses a type change', async () => {
    const { provider, calls } = fixture([infoRoute, { path: 'campaigns/camp-456', reply: campaign },
      { method: 'PATCH', path: 'campaigns/camp-456', reply: { ...campaign, daily_budget: 150.25 } }]);
    const op = { provider: 'gravity', accountId: 'abc-123', tool: 'gravity_set_budget', kind: 'update' as const, payload: { campaign_id: 'camp-456', budget_micros: 150_250_000 } };
    const preview = await provider.previewWrite(op, guard);
    expect(preview.budgetDeltas).toEqual([{ target: 'campaign camp-456 daily_budget', fromMicros: 100_000_000, toMicros: 150_250_000 }]);
    expect(preview.fieldChanges).toEqual([{ field: 'daily_budget', before: '100000000', after: '150250000' }]);
    expect(await provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: ['camp-456'] });
    expect(body(calls.find(c => c.init.method === 'PATCH')!)).toEqual({ daily_budget: 150.25 });
    await expect(provider.previewWrite({ ...op, payload: { ...op.payload, field: 'total_budget' } }, guard)).rejects.toThrow(/uses a daily budget/);
  });
  it('uses a known budget baseline and refuses ambiguous or missing budgets', async () => {
    const op = { provider: 'gravity', accountId: 'abc-123', tool: 'gravity_set_budget', kind: 'update' as const, payload: { campaign_id: 'camp-456', field: 'total_budget', budget_micros: 120_000_000 } };
    const read = (fields: object) => fixture([infoRoute, { path: 'campaigns/camp-456', reply: { ...campaign, budget_type: null, daily_budget: null, ...fields } }]).provider;
    expect((await read({ total_budget: 100 }).previewWrite(op, guard)).budgetDeltas[0]?.fromMicros).toBe(100_000_000);
    await expect(read({ daily_budget: 10, total_budget: 100 }).previewWrite(op, guard)).rejects.toThrow(/budget type/);
    await expect(read({ budget_type: 'total' }).previewWrite(op, guard)).rejects.toThrow(/policy checks/);
    expect((await read({ bid_strategy: 'target_cpa' }).previewWrite({ ...op, payload: { ...op.payload, field: 'daily_budget' } }, guard)).budgetDeltas[0]?.fromMicros).toBeUndefined();
  });
  it('pauses campaigns and ad groups with a status receipt check', async () => {
    const group = { id: 'adg-789', campaign_id: 'camp-456', name: 'Summer (Generative)', group_type: 'generative', status: 'active', ads: [], ads_total: 0 };
    const { provider, calls } = fixture([infoRoute, { path: 'ad-groups/adg-789', reply: group },
      { method: 'PATCH', path: 'ad-groups/adg-789', reply: (_url: URL, init: RequestInit) => ({ ...group, status: JSON.parse(String(init.body)).status }) },
      { path: 'campaigns/camp-456', reply: campaign }, { method: 'PATCH', path: 'campaigns/camp-456', reply: campaign }]);
    const groupOp = { provider: 'gravity', accountId: 'abc-123', tool: 'gravity_set_ad_group_status', kind: 'update' as const, payload: { ad_group_id: 'adg-789', status: 'paused' } };
    expect((await provider.previewWrite(groupOp, guard)).fieldChanges).toEqual([{ field: 'status', before: 'active', after: 'paused' }]);
    expect(await provider.applyWrite(groupOp, guard)).toEqual({ applied: true, resourceIds: ['adg-789'] });
    expect(body(calls.find(c => c.init.method === 'PATCH')!)).toEqual({ status: 'paused' });
    const campaignOp = { provider: 'gravity', accountId: 'abc-123', tool: 'gravity_set_campaign_status', kind: 'update' as const, payload: { campaign_id: 'camp-456', status: 'paused' } };
    await expect(provider.applyWrite(campaignOp, guard)).rejects.toMatchObject({ details: { resource_ids: ['camp-456'] } });
  });
  it('refuses to change generated ads', async () => {
    const ad = { id: 'ad-901', ad_group_id: 'adg-789', campaign_id: 'camp-456', headline: 'Hi', status: 'active', source: 'generated', review_status: 'approved' };
    const { provider } = fixture([infoRoute, { path: 'ads/ad-901', reply: ad }]);
    const op = { provider: 'gravity', accountId: 'abc-123', tool: 'gravity_set_ad_status', kind: 'update' as const, payload: { ad_id: 'ad-901', status: 'paused' } };
    await expect(provider.previewWrite(op, guard)).rejects.toThrow(/only manual ads/);
  });
});

describe('Gravity module wiring', () => {
  it('previews and applies each write through the registry and enforces the budget cap', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'adport-gravity-policy-')); dirs.push(home);
    vi.stubEnv('ADPORT_HOME', home);
    const group = { id: 'adg-1', campaign_id: campaign.campaign_id, name: 'Generative group', group_type: 'generative', status: 'active' };
    const ad = { id: 'manual-1', ad_group_id: group.id, name: 'Manual ad', source: 'manual', status: 'active' };
    const update = (entity: object) => (_: URL, init: RequestInit) => ({ ...entity, ...JSON.parse(String(init.body)) });
    const manual = { ...group, id: 'manual-group', name: 'Trail runners', group_type: 'manual' };
    const newCampaign = { ...campaign, campaign_id: 'qa-created', name: 'QA draft', daily_budget: 50, campaign_objective: 'clicks', status: 'paused',
      ad_groups: [{ ...group, campaign_id: 'qa-created', name: 'QA draft (Generative)' }] };
    const { provider, calls } = fixture([infoRoute, { path: 'campaigns', method: 'POST', reply: newCampaign },
      { path: 'campaigns/camp-456', reply: campaign }, { path: 'campaigns/camp-456', method: 'PATCH', reply: update(campaign) },
      { path: 'ad-groups/adg-1', reply: group }, { path: 'ad-groups/adg-1', method: 'PATCH', reply: update(group) },
      { path: 'ads/manual-1', reply: ad }, { path: 'ads/manual-1', method: 'PATCH', reply: update(ad) },
      { path: 'ad-groups', method: 'POST', reply: update(manual) }, { path: 'ad-groups/manual-group', reply: manual },
      { path: 'ad-groups/manual-group/ads', method: 'POST', reply: update({ ...ad, ad_group_id: manual.id, campaign_id: campaign.campaign_id }) },
      { path: 'pixels', method: 'POST', reply: update({ pixel_id: 'px-1', is_active: true, is_functional: null }) },
    ]);
    const runtime = await createContext({ providerModules: [{ provider, tools: gravityTools(provider) }] });
    const cases = [
      ['gravity_create_campaign', { name: 'QA draft', landing_page: 'https://example.com', campaign_objective: 'clicks', status: 'active', context: 'Fixture context', daily_budget_micros: 50_000_000 }],
      ['gravity_set_campaign_status', { campaign_id: campaign.campaign_id, status: 'paused' }],
      ['gravity_set_ad_group_status', { ad_group_id: group.id, status: 'paused' }],
      ['gravity_set_ad_status', { ad_id: ad.id, status: 'paused' }],
      ['gravity_set_budget', { campaign_id: campaign.campaign_id, budget_micros: 110_000_000 }],
      ['gravity_create_ad_group', { campaign_id: campaign.campaign_id, name: manual.name, group_type: 'manual', status: 'active' }],
      ['gravity_create_ad', { ad_group_id: manual.id, headline: 'Trail shoes', copy: 'Grip every trail.', cta: 'Explore', landing_page: 'https://example.org/trail', status: 'active' }],
      ['gravity_create_pixel', { name: 'Shop pixel', url: 'https://example.org' }],
    ] as const;
    const mutations = () => calls.filter(call => call.init.method !== 'GET').length;
    for (const [tool, fields] of cases) {
      const args = { account_id: info.advertiser_id, ...fields };
      const before = mutations();
      const preview = await runtime.registry.call(tool, args, runtime.ctx) as { pending_operation_id: string };
      expect(preview).toMatchObject({ status: 'pending_validation', applied: false, preview: { serverValidated: false } });
      expect(mutations()).toBe(before);
      const approved = { ...args, pending_operation_id: preview.pending_operation_id };
      expect(await runtime.registry.call(tool, approved, runtime.ctx)).toMatchObject({ status: 'applied', applied: true });
      expect(mutations()).toBe(before + 1);
    }
    expect(body(calls.find(call => call.init.method === 'POST')!)).toMatchObject({ status: 'paused' });
    for (const call of calls.filter(call => call.init.method === 'POST' && /ad-groups/.test(call.url.pathname))) {
      expect(body(call)).toMatchObject({ status: 'paused' });
    }
    await expect(runtime.registry.call('gravity_set_budget', { account_id: info.advertiser_id, campaign_id: campaign.campaign_id, budget_micros: 200_000_000 }, runtime.ctx))
      .rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(mutations()).toBe(cases.length);
  });

  it('loads from stored credentials or GRAVITY_API_KEY and registers the tools once', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-gravity-')); dirs.push(dir);
    const store = new CredentialStore(dir);
    vi.stubEnv('GRAVITY_API_KEY', '');
    expect(await createGravityModule(store)).toBeUndefined();
    vi.stubEnv('GRAVITY_API_KEY', 'grv-env');
    const module = await createGravityModule(store);
    expect(module?.provider.id).toBe('gravity');
    const names = module!.tools.map(tool => tool.name);
    expect(names).toEqual(['gravity_list_campaigns', 'gravity_ad_groups', 'gravity_ads', 'gravity_get_ad', 'gravity_pixels', 'gravity_conversion_stats', 'gravity_conversions', 'gravity_billing',
      'gravity_create_campaign', 'gravity_set_campaign_status', 'gravity_set_ad_group_status', 'gravity_set_ad_status', 'gravity_set_budget', 'gravity_create_ad_group', 'gravity_create_ad', 'gravity_create_pixel']);
    expect(module!.tools.filter(tool => tool.annotations.readOnly).map(tool => tool.name)).toEqual(names.slice(0, 8));
    for (const tool of module!.tools.filter(t => !t.annotations?.readOnly)) expect(tool.input.shape.pending_operation_id).toBeDefined();
    vi.stubEnv('GRAVITY_API_KEY', '');
    await store.set({ provider: 'gravity', source: 'byo', data: { api_key: 'grv-stored' } });
    expect((await createGravityModule(store))?.provider.id).toBe('gravity');
  });
});

it('requires Gravity write permission to preview an edit and spend permission to increase a budget or activate', async () => {
  const { provider, calls } = fixture([{ path: 'info', reply: info }, { path: 'campaigns/camp-456', reply: campaign }]);
  const read = new GravityProvider(provider.api, ['read']);
  const edit = new GravityProvider(provider.api, ['read', 'write']);
  const status = { provider: 'gravity', accountId: 'abc-123', tool: 'gravity_set_campaign_status', kind: 'update' as const, payload: { campaign_id: 'camp-456', status: 'active' } };
  await expect(read.previewWrite(status, guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  expect(calls).toHaveLength(0);
  await expect(edit.previewWrite(status, guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  const budget = { ...status, tool: 'gravity_set_budget', payload: { campaign_id: 'camp-456', field: 'daily_budget', budget_micros: 200_000_000 } };
  await expect(edit.applyWrite(budget, guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  await expect(edit.previewWrite({ ...budget, payload: { ...budget.payload, budget_micros: 50_000_000 } }, guard)).resolves.toMatchObject({ serverValidated: false });
  expect(calls.every(request => request.init.method === 'GET')).toBe(true);
});
