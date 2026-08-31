import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, CredentialStore, DEFAULT_POLICY, PolicyEngine, PendingStore, AuditLog, type NormalizedQuery, type WriteOperation } from '@adport/core';
import { PinterestAdsClient, PINTEREST_TOKEN_URL, buildPinterestAuthUrl, exchangePinterestCode } from '../src/client.js';
import { PinterestAdsProvider } from '../src/provider.js';
import { accountSchema } from '../src/schemas.js';
import { pinterestTools } from '../src/tools.js';
import { createPinterestModule, resolvePinterestCredentials } from '../src/index.js';

// Official Pinterest OpenAPI 5.28.0 contracts, inspected 2026-08-31:
// https://github.com/pinterest/api-description/blob/main/v5/openapi.json
// Synthetic values, not a live-account capture. CampaignBatchItem is the
// current write response; old {items:[{campaign:...}]} fixtures are incorrect.
const ACCOUNT = '549755885175', CAMPAIGN = '626736533506', SECOND = '626736533507';
const creds = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' };
const account = { id: ACCOUNT, name: 'Synthetic EUR account', currency: 'EUR', country: 'DE' };
const campaign = { id: CAMPAIGN, ad_account_id: ACCOUNT, name: 'Campaign', status: 'ACTIVE', daily_spend_cap: 100_000_000, lifetime_spend_cap: null, is_campaign_budget_optimization: true, is_flexible_daily_budgets: false };
const token = { access_token: 'access', expires_in: 2592000, refresh_token: 'refresh', refresh_token_expires_in: 5184000, token_type: 'bearer', scope: 'ads:read ads:write' };
const query: NormalizedQuery = { accountIds: [ACCOUNT], level: 'campaign', dateRange: { start: '2026-08-01', end: '2026-08-07' }, metrics: ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'ctr', 'cpc', 'cpm', 'cpa', 'roas'] };
const stats = { SPEND_IN_MICRO_DOLLAR: 20_000_000, PAID_IMPRESSION: 1000, OUTBOUND_CLICK_1: 20, TOTAL_CHECKOUT: 2, TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR: 80_000_000 };
const guard = { forcePausedCreation: true };
const createOp: WriteOperation = { provider: 'pinterest', accountId: ACCOUNT, tool: 'pinterest_create_campaign', kind: 'create', payload: { name: 'New campaign', objective_type: 'AWARENESS', status: 'ACTIVE', budget_micros: 20_000_000 } };
const budgetOp: WriteOperation = { provider: 'pinterest', accountId: ACCOUNT, tool: 'pinterest_set_budget', kind: 'update', payload: { campaign_id: CAMPAIGN, budget_micros: 110_000_000 } };
type Call = { url: URL; init: RequestInit };
function fixture(handler: (call: Call) => unknown | Response, tokenReply: unknown = token) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const reply = String(url) === PINTEREST_TOKEN_URL ? tokenReply : handler(call);
    return reply instanceof Response ? reply : Response.json(reply);
  };
  const client = new PinterestAdsClient(creds, fetchImpl);
  return { client, provider: new PinterestAdsProvider(client), calls, fetchImpl };
}
const dirs: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), 'adport-pinterest-')); dirs.push(dir); return dir; }
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });

describe('Pinterest OAuth and transport', () => {
  it('requests only Ads scopes on the Pinterest OAuth endpoint with state', () => {
    const url = new URL(buildPinterestAuthUrl('client', 'http://localhost:53686/callback', 'csrf'));
    expect(url.origin + url.pathname).toBe('https://www.pinterest.com/oauth/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'client', redirect_uri: 'http://localhost:53686/callback', response_type: 'code', state: 'csrf', scope: 'ads:read,ads:write' });
  });
  it('uses Basic client credentials and form-encoded continuous-refresh code exchange', async () => {
    const { fetchImpl, calls } = fixture(() => ({}));
    expect(await exchangePinterestCode({ ...creds, code: 'code+&', redirectUri: 'http://localhost:53686/callback' }, fetchImpl)).toBe('refresh');
    expect(calls[0]!.init.headers).toEqual({ authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ grant_type: 'authorization_code', code: 'code+&', redirect_uri: 'http://localhost:53686/callback', continuous_refresh: 'true' });
    expect(calls[0]!.init.redirect).toBe('error');
  });
  it('requires a refresh token on exchange', async () => {
    const { fetchImpl } = fixture(() => ({}), { access_token: 'access', expires_in: 3600 });
    await expect(exchangePinterestCode({ ...creds, code: 'code', redirectUri: 'http://localhost:53686/callback' }, fetchImpl)).rejects.toThrow('refresh token');
  });
  it('single-flights refresh, uses form encoding and persists rotation before reads', async () => {
    const { fetchImpl, calls } = fixture(() => account, { ...token, refresh_token: 'rotated' });
    const persist = vi.fn();
    const client = new PinterestAdsClient({ ...creds, onRefreshToken: persist }, fetchImpl);
    await Promise.all([1, 2].map(() => client.get(`ad_accounts/${ACCOUNT}`, accountSchema)));
    expect(calls.filter(c => c.url.href === PINTEREST_TOKEN_URL)).toHaveLength(1);
    expect(persist).toHaveBeenCalledWith('rotated');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh' });
    expect(calls[1]!.init.headers).toEqual({ authorization: 'Bearer access' });
  });
  it('retries a GET only once on 401', async () => {
    let attempts = 0;
    const { client, calls } = fixture(() => ++attempts === 1 ? Response.json({}, { status: 401 }) : account);
    await client.get('ad_accounts', accountSchema);
    expect(attempts).toBe(2);
    expect(calls.filter(c => c.url.href === PINTEREST_TOKEN_URL)).toHaveLength(2);
  });
  it('never automatically replays mutations', async () => {
    const { client, calls } = fixture(() => Response.json({}, { status: 401 }));
    await expect(client.mutate('ad_accounts', 'POST', [], accountSchema)).rejects.toThrow('401');
    expect(calls.filter(c => c.url.href !== PINTEREST_TOKEN_URL)).toHaveLength(1);
  });
  it('explains permission failures without exposing provider bodies', async () => {
    const { client } = fixture(() => Response.json({ message: 'secret-token' }, { status: 403 }));
    await expect(client.get('ad_accounts', accountSchema)).rejects.toThrow('Trial/Standard access');
    await expect(client.get('ad_accounts', accountSchema)).rejects.not.toThrow('secret-token');
  });
  it.each(['https://evil.example/path', '//evil.example', '/ad_accounts', 'ad_accounts/../oauth', 'ad_accounts?secret=1'])('rejects unsafe path %s before sending credentials', async path => {
    const { client, calls } = fixture(() => account);
    await expect(client.get(path, accountSchema)).rejects.toThrow('invalid API resource path');
    expect(calls).toHaveLength(0);
  });
  it.each([{}, { items: null }, { items: [{ id: 123 }] }])('rejects malformed success %j instead of claiming no accounts', async body => {
    const { provider } = fixture(() => body);
    await expect(provider.listAccounts()).rejects.toThrow('malformed API response');
  });
});

describe('Pinterest discovery and normalized reporting', () => {
  it('uses bookmark pagination and does not require an invented account status', async () => {
    const { provider, calls } = fixture(({ url }) => url.searchParams.has('bookmark') ? { items: [{ id: SECOND }], bookmark: null } : { items: [account], bookmark: 'next+&' });
    expect(await provider.listAccounts()).toEqual([{ provider: 'pinterest', id: ACCOUNT, name: account.name, currency: 'EUR' }, { provider: 'pinterest', id: SECOND, name: SECOND }]);
    expect(calls[2]!.url.searchParams.get('bookmark')).toBe('next+&');
    expect(calls[2]!.url.searchParams.get('page_size')).toBe('250');
  });
  it('rejects repeated bookmarks', async () => {
    const { provider } = fixture(() => ({ items: [], bookmark: 'same' }));
    await expect(provider.listAccounts()).rejects.toThrow('pagination did not terminate');
  });
  it('rejects duplicate entities across pages', async () => {
    const { provider } = fixture(() => ({ items: [account], bookmark: 'same' }));
    await expect(provider.listAccounts()).rejects.toThrow('repeated an entity');
  });
  it('includes archived and draft campaigns using schema-defined query arrays', async () => {
    const { provider, calls } = fixture(() => ({ items: [campaign] }));
    expect(await provider.listCampaigns(ACCOUNT)).toHaveLength(1);
    expect(calls[1]!.url.searchParams.getAll('entity_statuses')).toEqual(['ACTIVE', 'PAUSED', 'ARCHIVED', 'DRAFT', 'DELETED_DRAFT']);
  });
  it('rejects cross-account entity responses', async () => {
    const { provider } = fixture(() => ({ items: [{ ...campaign, ad_account_id: SECOND }] }));
    await expect(provider.listCampaigns(ACCOUNT)).rejects.toThrow('account mismatch');
  });
  it.each([
    ['account', '', 'AD_ACCOUNT_ID', ''], ['campaign', 'campaigns', 'CAMPAIGN_ID', 'campaign_ids'],
    ['ad_group', 'ad_groups', 'AD_GROUP_ID', 'ad_group_ids'], ['ad', 'ads', 'AD_ID', 'ad_ids'],
  ] as const)('reports %s using TOTAL granularity, inclusive dates and currency micros', async (level, collection, idField, filter) => {
    const entityId = level === 'account' ? ACCOUNT : CAMPAIGN;
    const { provider, calls } = fixture(({ url }) => url.pathname.endsWith('/analytics') ? [{ [idField]: entityId, ...stats }] : level === 'account' ? account : { items: [campaign] });
    const result = await provider.report({ ...query, level });
    expect(result.rows[0]!.metrics).toEqual({ spend: 20, impressions: 1000, clicks: 20, conversions: 2, conversion_value: 80, ctr: 2, cpc: 1, cpm: 20, cpa: 10, roas: 4 });
    expect(calls[2]!.url.pathname).toBe(`/v5/ad_accounts/${ACCOUNT}/${collection ? `${collection}/` : ''}analytics`);
    const params = calls[2]!.url.searchParams;
    expect(params.get('start_date')).toBe('2026-08-01'); expect(params.get('end_date')).toBe('2026-08-07');
    expect(params.get('granularity')).toBe('TOTAL');
    expect(params.getAll('columns')).toEqual([[idField, ...Object.keys(stats)].join(',')]);
    expect(params.get('click_window_days')).toBe('30'); expect(params.get('view_window_days')).toBe('1');
    expect(params.get('conversion_report_time')).toBe('TIME_OF_AD_ACTION');
    if (filter) expect(params.getAll(filter)).toEqual([entityId]);
  });
  it('chunks entity filters at the official 250-item limit', async () => {
    const entities = Array.from({ length: 251 }, (_, i) => ({ ...campaign, id: String(1000 + i) }));
    const { provider, calls } = fixture(({ url }) => url.pathname.endsWith('/analytics') ? url.searchParams.getAll('campaign_ids').map(id => ({ CAMPAIGN_ID: id, ...stats })) : url.searchParams.has('bookmark') ? { items: entities.slice(250) } : { items: entities.slice(0, 250), bookmark: 'next' });
    expect((await provider.report(query)).rows).toHaveLength(251);
    expect(calls.filter(c => c.url.pathname.endsWith('/analytics')).map(c => c.url.searchParams.getAll('campaign_ids').length)).toEqual([250, 1]);
  });
  it('requests derived-metric dependencies only and omits missing values', async () => {
    const { provider, calls } = fixture(({ url }) => url.pathname.endsWith('/analytics') ? [{ CAMPAIGN_ID: CAMPAIGN, SPEND_IN_MICRO_DOLLAR: 10_000_000 }] : { items: [campaign] });
    expect((await provider.report({ ...query, metrics: ['cpc'] })).rows[0]!.metrics).toEqual({});
    expect(calls[2]!.url.searchParams.get('columns')).toBe('CAMPAIGN_ID,SPEND_IN_MICRO_DOLLAR,OUTBOUND_CLICK_1');
  });
  it('accepts nullable ad names without failing reporting', async () => {
    const { provider } = fixture(({ url }) => url.pathname.endsWith('/analytics') ? [{ AD_ID: CAMPAIGN, ...stats }] : { items: [{ ...campaign, name: null }] });
    expect((await provider.report({ ...query, level: 'ad' })).rows[0]!.entity.name).toBe(CAMPAIGN);
  });
  it('reports no rows when there are no campaigns, with no invalid empty filter request', async () => {
    const { provider, calls } = fixture(() => ({ items: [] }));
    expect(await provider.report(query)).toEqual({ rows: [] });
    expect(calls.filter(c => c.url.pathname.endsWith('/analytics'))).toHaveLength(0);
  });
  it('marks globally limited reports as truncated', async () => {
    const { provider } = fixture(({ url }) => url.pathname.endsWith('/analytics') ? [CAMPAIGN, SECOND].map(id => ({ CAMPAIGN_ID: id, ...stats })) : { items: [campaign, { ...campaign, id: SECOND }] });
    expect(await provider.report({ ...query, limit: 1 })).toMatchObject({ truncated: true, rows: [expect.objectContaining({ entity: expect.objectContaining({ id: CAMPAIGN }) })] });
  });
  it.each([
    { rows: [{ CAMPAIGN_ID: SECOND, ...stats }] },
    { rows: [{ CAMPAIGN_ID: CAMPAIGN, PAID_IMPRESSION: 'not-number' }] },
    { rows: [{ CAMPAIGN_ID: CAMPAIGN }, { CAMPAIGN_ID: CAMPAIGN }] },
  ])('rejects malformed or incorrectly scoped analytics %j', async ({ rows }) => {
    const { provider } = fixture(({ url }) => url.pathname.endsWith('/analytics') ? rows : { items: [campaign] });
    await expect(provider.report(query)).rejects.toThrow('pinterest:');
  });
  it.each([{ start: '2026-02-30', end: '2026-03-02' }, { start: '2026-08-02', end: '2026-08-01' }, { start: '2026-01-01', end: '2026-08-01' }])('rejects unsupported dates before authentication %j', async dateRange => {
    const { provider, calls } = fixture(() => []);
    await expect(provider.report({ ...query, dateRange })).rejects.toThrow(); expect(calls).toHaveLength(0);
  });
});

describe('Pinterest guarded campaign writes and credentials', () => {
  it('previews locally then POSTs a single-item batch with explicit paused creation and micros', async () => {
    const { provider, calls } = fixture(({ init }) => ({ items: [{ data: { ...campaign, ...JSON.parse(String(init.body))[0] } }] }));
    const preview = await provider.previewWrite(createOp, guard);
    expect(preview.serverValidated).toBe(false); expect(preview.coercions).toHaveLength(1);
    expect(preview.budgetDeltas).toEqual([{ target: 'new campaign DAILY budget', toMicros: 20_000_000 }]);
    expect(calls).toHaveLength(0);
    expect(await provider.applyWrite(createOp, guard)).toEqual({ applied: true, resourceIds: [CAMPAIGN] });
    expect(calls[1]!.url.pathname).toBe(`/v5/ad_accounts/${ACCOUNT}/campaigns`);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual([{ name: 'New campaign', objective_type: 'AWARENESS', status: 'PAUSED', daily_spend_cap: 20_000_000, is_campaign_budget_optimization: true, is_flexible_daily_budgets: false }]);
  });
  it('supports lifetime creation with an end time and rejects missing end time', async () => {
    const { provider, calls } = fixture(({ init }) => ({ items: [{ data: { ...campaign, ...JSON.parse(String(init.body))[0] } }] }));
    const op = { ...createOp, payload: { ...createOp.payload, budget_type: 'LIFETIME' } };
    await expect(provider.previewWrite(op, guard)).rejects.toThrow('end time');
    await provider.applyWrite({ ...op, payload: { ...op.payload, end_time: 1893456000 } }, guard);
    expect(JSON.parse(String(calls[1]!.init.body))[0]).toMatchObject({ lifetime_spend_cap: 20_000_000, end_time: 1893456000 });
  });
  it('preserves the existing budget type and PATCHes the collection, not an individual path', async () => {
    const { provider, calls } = fixture(({ init }) => init.method === 'GET' ? campaign : { items: [{ data: { ...campaign, daily_spend_cap: 110_000_000 } }] });
    expect((await provider.previewWrite(budgetOp, guard)).budgetDeltas).toEqual([{ target: `campaign ${CAMPAIGN} daily_spend_cap`, fromMicros: 100_000_000, toMicros: 110_000_000 }]);
    await provider.applyWrite(budgetOp, guard);
    const patch = calls.find(c => c.init.method === 'PATCH')!;
    expect(patch.url.pathname).toBe(`/v5/ad_accounts/${ACCOUNT}/campaigns`);
    expect(JSON.parse(String(patch.init.body))).toEqual([{ id: CAMPAIGN, daily_spend_cap: 110_000_000 }]);
  });
  it('patches only id and status after a scoped ownership read', async () => {
    const { provider, calls } = fixture(({ init }) => init.method === 'GET' ? campaign : { items: [{ data: { ...campaign, status: 'PAUSED' } }] });
    await provider.applyWrite({ ...budgetOp, tool: 'pinterest_set_campaign_status', payload: { campaign_id: CAMPAIGN, status: 'PAUSED' } }, guard);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual([{ id: CAMPAIGN, status: 'PAUSED' }]);
  });
  it.each([{ ...campaign, is_campaign_budget_optimization: false }, { ...campaign, is_flexible_daily_budgets: true }, { ...campaign, lifetime_spend_cap: 50_000_000 }])('rejects ambiguous/unsupported budget semantics before writes', async current => {
    const { provider, calls } = fixture(() => current);
    await expect(provider.applyWrite(budgetOp, guard)).rejects.toThrow('pinterest:');
    expect(calls.some(c => c.init.method === 'PATCH')).toBe(false);
  });
  it.each([{ items: [{ data: {}, exceptions: [{ code: 1, message: 'Rejected' }] }] }, { items: [] }, { items: [{ campaign }] }, { items: [{ data: { ...campaign, status: 'ACTIVE', daily_spend_cap: 20_000_000 } }] }])('rejects batch item failure or mismatched success %j', async reply => {
    const { provider } = fixture(() => reply);
    await expect(provider.applyWrite(createOp, guard)).rejects.toThrow('pinterest:');
  });
  it('enforces the shared preview/exact-apply policy gate', async () => {
    const dir = await temp();
    const { provider, calls } = fixture(({ init }) => ({ items: [{ data: { ...campaign, ...JSON.parse(String(init.body))[0] } }] }));
    const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit')));
    const runtime = await createContext({ engine, providerModules: [{ provider, tools: pinterestTools(provider) }] });
    const input = { account_id: ACCOUNT, ...createOp.payload };
    const preview = await runtime.registry.call(createOp.tool, input, runtime.ctx) as { pending_operation_id: string };
    expect(calls).toHaveLength(0);
    await expect(runtime.registry.call(createOp.tool, { ...input, budget_micros: 99_000_000, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await runtime.registry.call(createOp.tool, { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    expect(calls.filter(c => c.url.href !== PINTEREST_TOKEN_URL)).toHaveLength(1);
  });
  it('persists rotation without losing other stored fields and uses restrictive permissions', async () => {
    const dir = await temp(), file = path.join(dir, 'credentials.json'), store = new CredentialStore(dir);
    await store.set({ provider: 'pinterest', source: 'byo', data: { client_id: 'stored', client_secret: 'secret', refresh_token: 'old', redirect_uri: 'http://localhost:53686/callback' } });
    const resolved = await resolvePinterestCredentials(store);
    await resolved!.onRefreshToken!('rotated');
    expect((await store.get('pinterest'))!.data).toMatchObject({ refresh_token: 'rotated', redirect_uri: 'http://localhost:53686/callback' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await createPinterestModule(store))!.tools.map(t => t.name)).toContain('pinterest_create_campaign');
  });
  it('does not mix incomplete stored and environment credentials', async () => {
    const store = new CredentialStore(await temp());
    await store.set({ provider: 'pinterest', source: 'byo', data: { client_id: 'stored' } });
    vi.stubEnv('PINTEREST_CLIENT_ID', ''); vi.stubEnv('PINTEREST_CLIENT_SECRET', 'secret'); vi.stubEnv('PINTEREST_REFRESH_TOKEN', 'refresh');
    expect(await resolvePinterestCredentials(store)).toBeUndefined();
    vi.stubEnv('PINTEREST_CLIENT_ID', 'environment');
    expect(await resolvePinterestCredentials(store)).toMatchObject({ clientId: 'environment', clientSecret: 'secret', refreshToken: 'refresh' });
  });
});
