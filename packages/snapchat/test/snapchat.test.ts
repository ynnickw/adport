import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, CredentialStore, DEFAULT_POLICY, PolicyEngine, PendingStore, AuditLog } from '@adport/core';
import { SnapchatAdsClient, SNAPCHAT_TOKEN_URL, buildSnapchatAuthUrl, exchangeSnapchatCode } from '../src/client.js';
import { SnapchatAdsProvider, accountMidnight } from '../src/provider.js';
import { accountSchema, campaignSchema } from '../src/schemas.js';
import { snapchatTools } from '../src/tools.js';
import { createSnapchatModule, resolveSnapchatCredentials } from '../src/index.js';

// Official examples reviewed 2026-08-31; fixtures preserve their envelopes,
// field types and nesting, with synthetic IDs/data. See docs/providers/snapchat.md.
const creds = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' };
const account = { id: 'account-1', name: 'Test account', currency: 'EUR', timezone: 'Europe/Berlin', status: 'ACTIVE' };
const campaign = { id: 'campaign-1', name: 'Test campaign', ad_account_id: account.id, status: 'ACTIVE', daily_budget_micro: 100_000_000 };
function envelope(plural: string, singular: string, rows: unknown[], next?: string) {
  return { request_status: 'SUCCESS', request_id: 'request-1', [plural]: rows.map(row => ({ sub_request_status: 'SUCCESS', [singular]: row })), paging: next ? { next_link: next } : {} };
}
type Route = { path: string; method?: string; reply: unknown; status?: number };
function fixture(routes: Route[], tokenReply: unknown = { access_token: 'access', expires_in: 3600, refresh_token: 'refresh' }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === SNAPCHAT_TOKEN_URL) return Response.json(tokenReply);
    const parsed = new URL(String(url));
    const route = routes.find(r => parsed.pathname === `/v1/${r.path}` && (r.method ?? 'GET') === init.method);
    if (!route) throw new Error(`Unexpected fixture request: ${init.method} ${parsed.pathname}`);
    return Response.json(route.reply, { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { client: new SnapchatAdsClient(creds, fetchImpl), calls, fetchImpl };
}
const guard = { forcePausedCreation: true };
const op = { provider: 'snapchat', accountId: account.id, tool: 'snapchat_set_budget', kind: 'update' as const, payload: { campaign_id: campaign.id, budget_micros: 120_000_000 } };
const createOp = { provider: 'snapchat', accountId: account.id, tool: 'snapchat_create_campaign', kind: 'create' as const, payload: { name: 'New campaign', start_time: '2026-09-01T00:00:00Z', status: 'ACTIVE', daily_budget_micro: 50_000_000 } };
const campaignRoute = { path: `campaigns/${campaign.id}`, reply: envelope('campaigns', 'campaign', [campaign]) };
const testDirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of testDirs.splice(0)) await rm(dir, { recursive: true }); });

describe('Snapchat OAuth and transport', () => {
  it('requests the Ads scope and state with an exact redirect URI', () => {
    const url = new URL(buildSnapchatAuthUrl('id', 'http://127.0.0.1:53684/callback', 'anti-csrf'));
    expect(url.origin + url.pathname).toBe('https://accounts.snapchat.com/login/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'id', redirect_uri: 'http://127.0.0.1:53684/callback', response_type: 'code', scope: 'snapchat-marketing-api', state: 'anti-csrf' });
  });
  it('exchanges codes using form credentials and the registered redirect', async () => {
    const { fetchImpl, calls } = fixture([]);
    await expect(exchangeSnapchatCode({ ...creds, code: 'code', redirectUri: 'http://127.0.0.1:53684/callback' }, fetchImpl)).resolves.toBe('refresh');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ grant_type: 'authorization_code', client_id: 'client', client_secret: 'secret', code: 'code', redirect_uri: 'http://127.0.0.1:53684/callback' });
  });
  it('single-flights refresh, persists rotation, and sends bearer auth', async () => {
    const { fetchImpl, calls } = fixture([{ path: 'adaccounts/account-1', reply: envelope('adaccounts', 'adaccount', [account]) }], { access_token: 'access', expires_in: 3600, refresh_token: 'rotated' });
    const persist = vi.fn();
    const client = new SnapchatAdsClient({ ...creds, onRefreshToken: persist }, fetchImpl);
    await Promise.all([1, 2].map(() => client.collection('adaccounts/account-1', 'adaccounts', 'adaccount', accountSchema)));
    expect(calls.filter(c => c.url === SNAPCHAT_TOKEN_URL)).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ grant_type: 'refresh_token', client_id: 'client', client_secret: 'secret', refresh_token: 'refresh' });
    expect(persist).toHaveBeenCalledWith('rotated');
    expect(calls[1]!.init.headers).toMatchObject({ authorization: 'Bearer access' });
    expect(calls[1]!.init.redirect).toBe('error');
  });
  it('rejects a malformed token without leaking secrets', async () => {
    const { client } = fixture([], { access_token: 'sensitive-token' });
    await expect(client.collection('adaccounts/account-1', 'adaccounts', 'adaccount', accountSchema)).rejects.toThrow('malformed OAuth response');
  });
  it.each([
    { request_status: 'ERROR', debug: 'sensitive-provider-value' },
    { request_status: 'SUCCESS', adaccounts: [{ sub_request_status: 'ERROR', debug: 'sensitive-provider-value' }] },
    { request_status: 'SUCCESS', adaccounts: [{ sub_request_status: 'SUCCESS', adaccount: { id: 'account-1' } }] },
    { request_status: 'SUCCESS' },
  ])('rejects error and malformed envelopes rather than returning empty success: %j', async reply => {
    const { client } = fixture([{ path: 'adaccounts/account-1', reply }]);
    await expect(client.collection('adaccounts/account-1', 'adaccounts', 'adaccount', accountSchema)).rejects.toThrow(/snapchat:/);
  });
  it('accepts lowercase success from official legacy examples', async () => {
    const reply = { request_status: 'success', adaccounts: [{ sub_request_status: 'success', adaccount: account }] };
    const { client } = fixture([{ path: 'adaccounts/account-1', reply }]);
    expect(await client.collection('adaccounts/account-1', 'adaccounts', 'adaccount', accountSchema)).toHaveLength(1);
  });
  it('does not mislabel HTTP 403 as a revoked grant or retry it', async () => {
    const { client, calls } = fixture([{ path: 'adaccounts/account-1', status: 403, reply: {} }]);
    await expect(client.collection('adaccounts/account-1', 'adaccounts', 'adaccount', accountSchema)).rejects.toThrow('app approval');
    expect(calls).toHaveLength(2);
  });
  it('never replays a mutation automatically', async () => {
    const { client, calls } = fixture([{ path: 'adaccounts/account-1/campaigns', method: 'POST', reply: {}, status: 401 }]);
    await expect(client.mutate('adaccounts/account-1/campaigns', 'POST', {}, 'campaigns', 'campaign', campaignSchema)).rejects.toThrow('401');
    expect(calls.filter(c => c.init.method === 'POST' && c.url !== SNAPCHAT_TOKEN_URL)).toHaveLength(1);
  });
  it.each(['https://evil.example/v1/accounts', 'https://adsapi.snapchat.com/v1/adaccounts/other/campaigns', 'https://adsapi.snapchat.com/not-v1'])('rejects unsafe pagination %s', async next => {
    const { client, calls } = fixture([{ path: 'adaccounts/account-1/campaigns', reply: envelope('campaigns', 'campaign', [campaign], next) }]);
    await expect(client.collection('adaccounts/account-1/campaigns', 'campaigns', 'campaign', campaignSchema)).rejects.toThrow(/pagination changed|invalid API URL/);
    expect(calls).toHaveLength(2);
  });
  it('detects pagination cycles', async () => {
    const { client } = fixture([{ path: 'adaccounts/account-1/campaigns', reply: envelope('campaigns', 'campaign', [campaign], 'https://adsapi.snapchat.com/v1/adaccounts/account-1/campaigns') }]);
    await expect(client.collection('adaccounts/account-1/campaigns', 'campaigns', 'campaign', campaignSchema)).rejects.toThrow('did not terminate');
  });
  it('follows the documented next_link exactly', async () => {
    const next = 'https://adsapi.snapchat.com/v1/adaccounts/account-1/campaigns?cursor=page-2&limit=100';
    const { fetchImpl, calls } = fixture([]);
    const wrapped: typeof fetch = async (url, init) => {
      if (String(url) === SNAPCHAT_TOKEN_URL) return fetchImpl(url, init);
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json(envelope('campaigns', 'campaign', [{ ...campaign, id: String(url) === next ? 'campaign-2' : 'campaign-1' }], String(url) === next ? undefined : next));
    };
    const rows = await new SnapchatAdsClient(creds, wrapped).collection('adaccounts/account-1/campaigns', 'campaigns', 'campaign', campaignSchema);
    expect(rows.map(r => r.id)).toEqual(['campaign-1', 'campaign-2']);
    expect(calls[2]!.url).toBe(next);
  });
});

describe('Snapchat account discovery and normalized reports', () => {
  it('discovers organization-scoped accounts and deduplicates them', async () => {
    const { client } = fixture([
      { path: 'me/organizations', reply: envelope('organizations', 'organization', [{ id: 'org-1', name: 'Agency' }, { id: 'org-2', name: 'Advertiser' }]) },
      ...['org-1', 'org-2'].map(id => ({ path: `organizations/${id}/adaccounts`, reply: envelope('adaccounts', 'adaccount', [account]) })),
    ]);
    expect(await new SnapchatAdsProvider(client).listAccounts()).toEqual([{ provider: 'snapchat', id: account.id, name: account.name, currency: 'EUR', status: 'ACTIVE' }]);
  });
  it.each([
    ['2026-08-01', 'Europe/Berlin', '2026-07-31T22:00:00.000Z'],
    ['2026-03-29', 'Europe/Berlin', '2026-03-28T23:00:00.000Z'],
    ['2026-03-30', 'Europe/Berlin', '2026-03-29T22:00:00.000Z'],
    ['2026-10-26', 'Europe/Berlin', '2026-10-25T23:00:00.000Z'],
    ['2026-08-01', 'Asia/Kolkata', '2026-07-31T18:30:00.000Z'],
    ['2026-08-01', 'America/Los_Angeles', '2026-08-01T07:00:00.000Z'],
  ])('uses account midnight for %s in %s', (date, timezone, expected) => {
    expect(accountMidnight(date, timezone)).toBe(expected);
  });
  it('rejects impossible report dates', () => {
    expect(() => accountMidnight('2026-02-31', 'UTC')).toThrow('invalid report date');
  });
  it.each([['campaign', 'campaign'], ['ad_group', 'adsquad'], ['ad', 'ad']] as const)('normalizes %s breakdown, micros and attribution', async (level, breakdown) => {
    const { client, calls } = fixture([
      { path: 'adaccounts/account-1', reply: envelope('adaccounts', 'adaccount', [account]) },
      { path: 'adaccounts/account-1/stats', reply: envelope('total_stats', 'total_stat', [{ id: account.id, breakdown_stats: { [breakdown]: [{ id: 'entity-1', stats: { spend: 12_500_000, impressions: 1000, swipes: 25, conversion_purchases: 2, conversion_purchases_value: 50_000_000 } }] } }]) },
    ]);
    const report = await new SnapchatAdsProvider(client).report({ accountIds: [account.id], level, metrics: ['spend', 'clicks', 'conversions', 'conversion_value', 'roas', 'ctr'], dateRange: { start: '2026-08-01', end: '2026-08-07' } });
    expect(report.rows[0]).toMatchObject({ entity: { id: 'entity-1', level }, metrics: { spend: 12.5, clicks: 25, conversions: 2, conversion_value: 50, roas: 4, ctr: 2.5 } });
    const url = new URL(calls.find(c => c.url.includes('/stats'))!.url);
    expect(url.searchParams.get('granularity')).toBe('TOTAL');
    expect(url.searchParams.get('breakdown')).toBe(breakdown);
    expect(url.searchParams.get('start_time')).toBe('2026-07-31T22:00:00.000Z');
    expect(url.searchParams.get('end_time')).toBe('2026-08-07T22:00:00.000Z');
    expect(url.searchParams.get('swipe_up_attribution_window')).toBe('28_DAY');
    expect(url.searchParams.get('view_attribution_window')).toBe('1_DAY');
  });
  it('aggregates base metrics before calculating account ratios and preserves missing metrics', async () => {
    const { client } = fixture([
      { path: 'adaccounts/account-1', reply: envelope('adaccounts', 'adaccount', [account]) },
      { path: 'adaccounts/account-1/stats', reply: envelope('total_stats', 'total_stat', [{ id: account.id, breakdown_stats: { campaign: [
        { id: 'c1', stats: { spend: 10_000_000, swipes: 10, impressions: 100 } },
        { id: 'c2', stats: { spend: 90_000_000, swipes: 30, impressions: 900 } },
      ] } }]) },
    ]);
    const report = await new SnapchatAdsProvider(client).report({ accountIds: [account.id], level: 'account', metrics: ['spend', 'cpc', 'ctr', 'conversions', 'roas'], dateRange: 'last_7_days' });
    expect(report.rows[0]!.metrics).toEqual({ spend: 100, cpc: 2.5, ctr: 4 });
  });
  it('rejects missing breakdowns rather than showing a healthy empty account', async () => {
    const { client } = fixture([
      { path: 'adaccounts/account-1', reply: envelope('adaccounts', 'adaccount', [account]) },
      { path: 'adaccounts/account-1/stats', reply: envelope('total_stats', 'total_stat', [{ id: account.id, stats: { spend: 12 } }]) },
    ]);
    await expect(new SnapchatAdsProvider(client).report({ accountIds: [account.id], level: 'campaign', metrics: ['spend'], dateRange: 'last_7_days' })).rejects.toThrow('report breakdown');
  });
  it('reports global truncation honestly', async () => {
    const { client } = fixture([
      { path: 'adaccounts/account-1', reply: envelope('adaccounts', 'adaccount', [account]) },
      { path: 'adaccounts/account-1/stats', reply: envelope('total_stats', 'total_stat', [{ id: account.id, breakdown_stats: { campaign: [{ id: 'c1', stats: { spend: 10 } }, { id: 'c2', stats: { spend: 20 } }] } }]) },
    ]);
    const result = await new SnapchatAdsProvider(client).report({ accountIds: [account.id], level: 'campaign', metrics: ['spend'], dateRange: 'last_7_days', limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

describe('Snapchat guarded writes and module assembly', () => {
  it('previews locally and only sends a paused create after apply', async () => {
    const { client, calls } = fixture([{ path: 'adaccounts/account-1/campaigns', method: 'POST', reply: envelope('campaigns', 'campaign', [{ ...campaign, status: 'PAUSED' }]) }]);
    const provider = new SnapchatAdsProvider(client);
    const preview = await provider.previewWrite(createOp, guard);
    expect(preview).toMatchObject({ serverValidated: false, coercions: ['status coerced to PAUSED by policy (paused_creation)'], budgetDeltas: [{ toMicros: 50_000_000 }] });
    expect(calls).toHaveLength(0);
    await provider.applyWrite(createOp, guard);
    const body = JSON.parse(String(calls[1]!.init.body));
    expect(body).toMatchObject({ campaigns: [{ status: 'PAUSED', ad_account_id: account.id, daily_budget_micro: 50_000_000, buy_model: 'AUCTION' }] });
  });
  it('reports daily and lifetime cap deltas on creation', async () => {
    const { client } = fixture([]);
    const preview = await new SnapchatAdsProvider(client).previewWrite({ ...createOp, payload: { ...createOp.payload, lifetime_spend_cap_micro: 100_000_000 } }, guard);
    expect(preview.budgetDeltas.map(d => d.toMicros)).toEqual([50_000_000, 100_000_000]);
  });
  it('patches only the budget field without resetting other campaign settings', async () => {
    const { client, calls } = fixture([campaignRoute, { path: `adaccounts/${account.id}/campaigns/${campaign.id}`, method: 'PATCH', reply: envelope('campaigns', 'campaign', [{ ...campaign, daily_budget_micro: 120_000_000 }]) }]);
    const provider = new SnapchatAdsProvider(client);
    expect((await provider.previewWrite(op, guard)).budgetDeltas).toEqual([{ target: 'campaign campaign-1 daily_budget_micro', fromMicros: 100_000_000, toMicros: 120_000_000 }]);
    await provider.applyWrite(op, guard);
    const patch = calls.find(c => c.init.method === 'PATCH')!;
    expect(patch.init.headers).toMatchObject({ 'content-type': 'application/json-patch+json' });
    expect(JSON.parse(String(patch.init.body))).toEqual([{ op: 'replace', path: '/daily_budget_micro', value: 120_000_000 }]);
  });
  it('rejects campaign ownership mismatch before writing', async () => {
    const { client, calls } = fixture([{ ...campaignRoute, reply: envelope('campaigns', 'campaign', [{ ...campaign, ad_account_id: 'other' }]) }]);
    await expect(new SnapchatAdsProvider(client).previewWrite(op, guard)).rejects.toThrow('does not belong');
    expect(calls.filter(c => c.init.method === 'PATCH')).toHaveLength(0);
  });
  it('rejects unsafe integers and path injection before network access', async () => {
    const { client, calls } = fixture([]);
    const provider = new SnapchatAdsProvider(client);
    await expect(provider.previewWrite({ ...op, payload: { ...op.payload, budget_micros: Number.MAX_SAFE_INTEGER + 1 } }, guard)).rejects.toThrow();
    await expect(provider.previewWrite({ ...op, accountId: '../other' }, guard)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('uses the shared exact-argument two-step gate, budget caps, protected accounts and audit log', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-snapchat-test-')); testDirs.push(dir);
    const { client, calls } = fixture([campaignRoute, { path: `adaccounts/${account.id}/campaigns/${campaign.id}`, method: 'PATCH', reply: envelope('campaigns', 'campaign', [campaign]) }]);
    const provider = new SnapchatAdsProvider(client);
    const audit = new AuditLog(path.join(dir, 'audit'));
    const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), audit);
    const rt = await createContext({ engine, providerModules: [{ provider, tools: snapchatTools(provider) }] });
    const args = { ...op.payload, account_id: account.id };
    const pending = await rt.registry.call(op.tool, args, rt.ctx) as { pending_operation_id: string };
    expect(calls.some(c => c.init.method === 'PATCH')).toBe(false);
    await expect(rt.registry.call(op.tool, { ...args, budget_micros: 121_000_000, pending_operation_id: pending.pending_operation_id }, rt.ctx)).rejects.toThrow('differs');
    await rt.registry.call(op.tool, { ...args, pending_operation_id: pending.pending_operation_id }, rt.ctx);
    expect(calls.filter(c => c.init.method === 'PATCH')).toHaveLength(1);
    await expect(rt.registry.call(op.tool, { ...args, pending_operation_id: pending.pending_operation_id }, rt.ctx)).rejects.toThrow('No pending');
    await expect(rt.registry.call(op.tool, { ...args, budget_micros: 200_000_000 }, rt.ctx)).rejects.toThrow('budget-delta cap');
    const blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [account.id] }, new PendingStore(path.join(dir, 'blocked')), audit);
    await expect(blocked.validate(provider, op)).rejects.toThrow('protected');
    expect((await audit.read()).map(e => e.event)).toEqual(expect.arrayContaining(['validated', 'applied', 'rejected']));
  });
  it('loads store-backed credentials and persists rotated refresh tokens', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-snapchat-store-')); testDirs.push(dir);
    const store = new CredentialStore(dir);
    expect(await createSnapchatModule(store)).toBeUndefined();
    await store.set({ provider: 'snapchat', source: 'byo', data: { client_id: 'id', client_secret: 'secret', refresh_token: 'refresh' } });
    const module = await createSnapchatModule(store);
    expect(module?.provider.id).toBe('snapchat');
    expect(module?.tools.map(t => t.name)).toContain('snapchat_set_budget');
    const credentials = await resolveSnapchatCredentials(store);
    await credentials!.onRefreshToken!('rotated-refresh');
    expect((await store.get('snapchat'))?.data.refresh_token).toBe('rotated-refresh');
  });
});
