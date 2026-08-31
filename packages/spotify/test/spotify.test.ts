import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, CredentialStore, DEFAULT_POLICY, PolicyEngine, PendingStore, AuditLog, type NormalizedQuery, type WriteOperation } from '@adport/core';
import { SpotifyAdsClient, SPOTIFY_TOKEN_URL, buildSpotifyAuthUrl, exchangeSpotifyCode } from '../src/client.js';
import { SpotifyAdsProvider } from '../src/provider.js';
import { accountSchema, campaignSchema } from '../src/schemas.js';
import { spotifyTools } from '../src/tools.js';
import { createSpotifyModule, resolveSpotifyCredentials } from '../src/index.js';

// Fixtures follow Spotify's official v3 reference shapes (2026-08-31), not
// responses captured from a live account. Sources and sample quirks are tracked
// in docs/providers/spotify.md. All account data and credentials are synthetic.
const BUSINESS = 'ce4ff15e-f04d-48b9-9ddf-fb3c85fbd57a';
const ACCOUNT = '7f4c1cc9-9a1d-4b65-b05c-46e5e33b6705';
const CAMPAIGN = '9a7b6c5d-4e3f-4b21-8c99-bf1c2a3d4e5f';
const ADSET = '39ff503e-4baa-4e7a-9dd2-4b3f49653801';
const creds = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' };
const account = { id: ACCOUNT, business_id: BUSINESS, name: 'Synthetic ad account', currency_code: 'EUR', status: 'ACTIVE', test_account_type: 'NO_DELIVERY_NO_BILLING' };
const campaign = { id: CAMPAIGN, name: 'Synthetic campaign', status: 'ACTIVE', objective: 'EVEN_IMPRESSION_DELIVERY' };
const adSet = { id: ADSET, campaign_id: CAMPAIGN, name: 'Synthetic ad set', budget: { type: 'DAILY', micro_amount: 100_000_000 }, delivery: 'ON' };
const token = { access_token: 'access', expires_in: 3600, refresh_token: 'refresh', token_type: 'Bearer', scope: '' };
const guard = { forcePausedCreation: true };
const query: NormalizedQuery = { accountIds: [ACCOUNT], level: 'campaign', dateRange: { start: '2026-08-01', end: '2026-08-07' }, metrics: ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'ctr', 'cpc', 'cpm', 'cpa', 'roas'] };
const budgetOp: WriteOperation = { provider: 'spotify', accountId: ACCOUNT, tool: 'spotify_set_budget', kind: 'update', payload: { ad_set_id: ADSET, budget_micros: 120_000_000 } };
const createOp: WriteOperation = { provider: 'spotify', accountId: ACCOUNT, tool: 'spotify_create_campaign_draft', kind: 'create', payload: { name: 'New draft', delivery_goal_group: 'AWARENESS', status: 'ACTIVE' } };
const reportRow = {
  entity_type: 'CAMPAIGN', entity_id: CAMPAIGN, entity_name: 'Synthetic campaign', entity_status: 'ACTIVE',
  start_time: '2026-08-01T00:00:00Z', end_time: '2026-08-07T00:00:00Z',
  stats: [{ field_type: 'IMPRESSIONS', field_value: 1920 }, { field_type: 'CLICKS', field_value: 9 }, { field_type: 'SPEND', field_value: 17.482913 }, { field_type: 'PURCHASES', field_value: 5 }, { field_type: 'REVENUE', field_value: 100 }],
};
const report = { granularity: 'LIFETIME', continuation_token: null, rows: [reportRow] };
type Call = { url: URL; init: RequestInit };
type Handler = (call: Call) => unknown | Response;
function fixture(handler: Handler, tokenReply: unknown = token) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const call = { url: new URL(String(url)), init };
    calls.push(call);
    const reply = String(url) === SPOTIFY_TOKEN_URL ? tokenReply : handler(call);
    return reply instanceof Response ? reply : Response.json(reply);
  };
  return { client: new SpotifyAdsClient(creds, fetchImpl), calls, fetchImpl };
}
const dirs: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), 'adport-spotify-')); dirs.push(dir); return dir; }
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });

describe('Spotify OAuth and transport', () => {
  it('uses Ads OAuth without requesting music/Web API scopes, including state', () => {
    const url = new URL(buildSpotifyAuthUrl('client', 'http://127.0.0.1:53685/callback', 'anti-csrf'));
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'client', response_type: 'code', redirect_uri: 'http://127.0.0.1:53685/callback', state: 'anti-csrf' });
  });
  it('exchanges codes with Basic client authentication and form-encoded values', async () => {
    const { fetchImpl, calls } = fixture(() => ({}));
    await expect(exchangeSpotifyCode({ ...creds, code: 'code+&', redirectUri: 'http://127.0.0.1:53685/callback' }, fetchImpl)).resolves.toBe('refresh');
    expect(calls[0]!.init.headers).toEqual({ authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ grant_type: 'authorization_code', code: 'code+&', redirect_uri: 'http://127.0.0.1:53685/callback' });
    expect(calls[0]!.init.redirect).toBe('error');
  });
  it('requires a refresh token during code exchange', async () => {
    const { fetchImpl } = fixture(() => ({}), { access_token: 'access', expires_in: 3600 });
    await expect(exchangeSpotifyCode({ ...creds, code: 'code', redirectUri: 'http://127.0.0.1:53685/callback' }, fetchImpl)).rejects.toThrow('refresh token');
  });
  it('single-flights refresh and persists rotated refresh tokens before API calls', async () => {
    const { fetchImpl, calls } = fixture(() => account, { ...token, refresh_token: 'rotated' });
    const persist = vi.fn();
    const client = new SpotifyAdsClient({ ...creds, onRefreshToken: persist }, fetchImpl);
    await Promise.all([1, 2].map(() => client.get(`ad_accounts/${ACCOUNT}`, accountSchema)));
    expect(calls.filter(c => c.url.href === SPOTIFY_TOKEN_URL)).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh' });
    expect(persist).toHaveBeenCalledWith('rotated');
    expect(calls[1]!.url.origin).toBe('https://api-partner.spotify.com');
    expect(calls[1]!.url.pathname).toBe(`/ads/v3/ad_accounts/${ACCOUNT}`);
    expect(calls[1]!.init.headers).toEqual({ authorization: 'Bearer access' });
  });
  it('accepts refresh responses without rotation', async () => {
    const { client } = fixture(() => account, { access_token: 'access', expires_in: 3600 });
    expect(await client.get(`ad_accounts/${ACCOUNT}`, accountSchema)).toMatchObject(account);
  });
  it('retries a read only once after 401', async () => {
    let attempt = 0;
    const { client, calls } = fixture(() => ++attempt === 1 ? Response.json({}, { status: 401 }) : account);
    await client.get(`ad_accounts/${ACCOUNT}`, accountSchema);
    expect(attempt).toBe(2);
    expect(calls.filter(c => c.url.href === SPOTIFY_TOKEN_URL)).toHaveLength(2);
  });
  it('does not replay writes on 401', async () => {
    const { client, calls } = fixture(() => Response.json({}, { status: 401 }));
    await expect(client.mutate(`ad_accounts/${ACCOUNT}/campaigns/${CAMPAIGN}`, 'PATCH', { status: 'PAUSED' }, campaignSchema)).rejects.toThrow('401');
    expect(calls.filter(c => c.init.method === 'PATCH')).toHaveLength(1);
  });
  it('explains 403 allowlisting without claiming the grant was revoked or leaking error bodies', async () => {
    const { client } = fixture(() => Response.json({ debug: 'sensitive-token' }, { status: 403 }));
    await expect(client.get('businesses', accountSchema)).rejects.toThrow('terms/allowlisting');
    await expect(client.get('businesses', accountSchema)).rejects.not.toThrow('sensitive-token');
  });
  it.each(['https://evil.example/path', '/ad_accounts', 'ad_accounts/../businesses', 'ad_accounts?token=secret', '//evil.example'])('rejects credential-exfiltration path %s before authentication', async path => {
    const { client, calls } = fixture(() => account);
    await expect(client.get(path, accountSchema)).rejects.toThrow('invalid API resource path');
    expect(calls).toHaveLength(0);
  });
  it.each([{}, { id: ACCOUNT }, { ...account, currency_code: 123 }])('rejects malformed successful account responses %j', async reply => {
    const { client } = fixture(() => reply);
    await expect(client.get(`ad_accounts/${ACCOUNT}`, accountSchema)).rejects.toThrow('malformed API response');
  });
});

describe('Spotify accounts and reports', () => {
  it('discovers businesses then accounts with the documented unpaginated envelopes', async () => {
    const { client, calls } = fixture(({ url }) => url.pathname.endsWith('/businesses') ? { businesses: [{ id: BUSINESS, name: 'Business', type: 'ADVERTISER' }] } : { ad_accounts: [account, account] });
    expect(await new SpotifyAdsProvider(client).listAccounts()).toEqual([{ provider: 'spotify', id: ACCOUNT, name: account.name, currency: 'EUR', status: 'ACTIVE' }]);
    expect(calls[2]!.url.pathname).toBe(`/ads/v3/businesses/${BUSINESS}/ad_accounts`);
    expect(calls[2]!.url.search).toBe('');
  });
  it('pages campaigns by limit/offset rather than a made-up page token', async () => {
    const { client, calls } = fixture(({ url }) => {
      const offset = Number(url.searchParams.get('offset'));
      return { paging: { page_size: 1, total_results: 2, offset, current_page: offset + 1 }, campaigns: [{ ...campaign, id: offset === 0 ? CAMPAIGN : ADSET }] };
    });
    expect(await new SpotifyAdsProvider(client).listCampaigns(ACCOUNT)).toHaveLength(2);
    expect(Object.fromEntries(calls[2]!.url.searchParams)).toEqual({ limit: '50', offset: '1', sort_field: 'ID', sort_direction: 'ASC' });
  });
  it('rejects stalled campaign pagination', async () => {
    const { client } = fixture(() => ({ paging: { page_size: 0, total_results: 3, offset: 0, current_page: 1 }, campaigns: [] }));
    await expect(new SpotifyAdsProvider(client).listCampaigns(ACCOUNT)).rejects.toThrow('did not terminate');
  });
  it('uses repeated fields, UTC inclusive end dates, and currency-unit report spend', async () => {
    const { client, calls } = fixture(() => report);
    const result = await new SpotifyAdsProvider(client).report(query);
    expect(calls[1]!.url.pathname).toBe(`/ads/v3/ad_accounts/${ACCOUNT}/aggregate_reports`);
    expect(calls[1]!.url.searchParams.getAll('fields')).toEqual(['SPEND', 'IMPRESSIONS', 'CLICKS', 'PURCHASES', 'REVENUE']);
    expect(calls[1]!.url.searchParams.get('report_end')).toBe('2026-08-07T00:00:00Z');
    expect(calls[1]!.url.searchParams.get('granularity')).toBe('LIFETIME');
    expect(result.rows[0]!.metrics).toEqual({ spend: 17.482913, impressions: 1920, clicks: 9, conversions: 5, conversion_value: 100, ctr: 9 / 1920 * 100, cpc: 17.482913 / 9, cpm: 17.482913 / 1920 * 1000, cpa: 17.482913 / 5, roas: 100 / 17.482913 });
  });
  it('requests only dependencies for selected metrics', async () => {
    const { client, calls } = fixture(() => report);
    const result = await new SpotifyAdsProvider(client).report({ ...query, metrics: ['cpc'] });
    expect(calls[1]!.url.searchParams.getAll('fields')).toEqual(['SPEND', 'CLICKS']);
    expect(result.rows[0]!.metrics).toEqual({ cpc: 17.482913 / 9 });
  });
  it('uses only the continuation token for later pages and marks a global limit', async () => {
    const { client, calls } = fixture(({ url }) => url.searchParams.has('continuation_token') ? { ...report, rows: [{ ...reportRow, entity_id: ADSET }] } : { ...report, continuation_token: 'next+page=' });
    const result = await new SpotifyAdsProvider(client).report({ ...query, limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(Object.fromEntries(calls[2]!.url.searchParams)).toEqual({ continuation_token: 'next+page=' });
  });
  it('rejects repeated continuation tokens without returning partial success', async () => {
    const { client } = fixture(() => ({ ...report, continuation_token: 'loop', rows: [] }));
    await expect(new SpotifyAdsProvider(client).report(query)).rejects.toThrow('pagination did not terminate');
  });
  it.each([
    { start: '2026-02-30', end: '2026-03-01' }, { start: '2026-08-02', end: '2026-08-01' }, { start: '2026-01-01', end: '2026-08-01' },
  ])('rejects invalid or unsupported date range %j before fetching', async dateRange => {
    const { client, calls } = fixture(() => report);
    await expect(new SpotifyAdsProvider(client).report({ ...query, dateRange })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it.each(['account', 'ad_group', 'ad'] as const)('maps normalized level %s to its native entity type', async level => {
    const type = { account: 'AD_ACCOUNT', ad_group: 'AD_SET', ad: 'AD' }[level];
    const { client, calls } = fixture(() => ({ ...report, rows: [{ ...reportRow, entity_type: type, entity_id: level === 'account' ? ACCOUNT : ADSET }] }));
    expect((await new SpotifyAdsProvider(client).report({ ...query, level })).rows[0]!.entity.level).toBe(level);
    expect(calls[1]!.url.searchParams.get('entity_type')).toBe(type);
  });
  it('leaves suppressed purchases and their derived CPA absent instead of inventing zeros', async () => {
    const { client } = fixture(() => ({ ...report, rows: [{ ...reportRow, stats: [{ field_type: 'PURCHASES', field_value: -5 }, { field_type: 'SPEND', field_value: 10 }] }] }));
    const result = await new SpotifyAdsProvider(client).report(query);
    expect(result.rows[0]!.metrics).toEqual({ spend: 10 });
  });
  it('returns truly empty reporting for no-delivery accounts', async () => {
    const { client } = fixture(() => ({ ...report, rows: [] }));
    expect(await new SpotifyAdsProvider(client).report(query)).toEqual({ rows: [] });
  });
  it.each([
    { ...report, rows: [{ ...reportRow, entity_type: 'AD' }] },
    { ...report, granularity: 'DAY' },
    { ...report, rows: [{ ...reportRow, stats: [{ field_type: 'CLICKS', field_value: '9' }] }] },
    { ...report, rows: [reportRow, reportRow] },
  ])('rejects malformed/mis-scoped reporting %j', async reply => {
    const { client } = fixture(() => reply);
    await expect(new SpotifyAdsProvider(client).report(query)).rejects.toThrow(/spotify:/);
  });
});

describe('Spotify guarded writes and credentials', () => {
  it('previews draft creation without an API mutation, then explicitly creates a PAUSED draft', async () => {
    const { client, calls } = fixture(() => ({ ...campaign, ad_account_id: ACCOUNT, status: 'PAUSED' }));
    const provider = new SpotifyAdsProvider(client);
    const preview = await provider.previewWrite(createOp, guard);
    expect(preview.serverValidated).toBe(false);
    expect(preview.coercions).toEqual(['status coerced to PAUSED by policy (paused_creation)']);
    expect(preview.summary).toContain('not published');
    expect(calls).toHaveLength(0);
    expect(await provider.applyWrite(createOp, guard)).toMatchObject({ applied: true, resourceIds: [CAMPAIGN] });
    expect(calls[1]!.url.pathname).toBe(`/ads/v3/ad_accounts/${ACCOUNT}/drafts/campaigns`);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ name: 'New draft', delivery_goal_group: 'AWARENESS', status: 'PAUSED' });
    expect(calls[1]!.init.headers).toMatchObject({ 'content-type': 'application/json' });
  });
  it('does not pretend unsafe direct campaign creation is supported', async () => {
    const { client, calls } = fixture(() => campaign);
    await expect(new SpotifyAdsProvider(client).previewWrite({ ...createOp, tool: 'spotify_create_campaign' }, guard)).rejects.toThrow('unsupported write');
    expect(calls).toHaveLength(0);
  });
  it('PATCHes only campaign status using account-scoped reads and writes', async () => {
    const { client, calls } = fixture(({ init }) => ({ ...campaign, status: init.method === 'PATCH' ? 'PAUSED' : 'ACTIVE' }));
    const operation: WriteOperation = { ...budgetOp, tool: 'spotify_set_campaign_status', payload: { campaign_id: CAMPAIGN, status: 'PAUSED' } };
    const provider = new SpotifyAdsProvider(client);
    expect(provider.standardActions().pauseCampaign!(ACCOUNT, CAMPAIGN)).toEqual({ tool: operation.tool, input: { account_id: ACCOUNT, ...operation.payload } });
    await provider.previewWrite(operation, guard);
    expect(calls.some(c => c.init.method === 'PATCH')).toBe(false);
    await provider.applyWrite(operation, guard);
    const write = calls.find(c => c.init.method === 'PATCH')!;
    expect(write.url.pathname).toBe(`/ads/v3/ad_accounts/${ACCOUNT}/campaigns/${CAMPAIGN}`);
    expect(JSON.parse(String(write.init.body))).toEqual({ status: 'PAUSED' });
  });
  it.each(['DAILY', 'LIFETIME'])('keeps %s budget type and uses integer micros for wire and policy', async type => {
    const { client, calls } = fixture(({ init }) => ({ ...adSet, budget: { ...adSet.budget, type }, ...(init.method === 'PATCH' ? JSON.parse(String(init.body)) : {}) }));
    const provider = new SpotifyAdsProvider(client);
    expect((await provider.previewWrite(budgetOp, guard)).budgetDeltas).toEqual([{ target: `ad set ${ADSET} ${type} budget`, fromMicros: 100_000_000, toMicros: 120_000_000 }]);
    await provider.applyWrite(budgetOp, guard);
    expect(JSON.parse(String(calls.find(c => c.init.method === 'PATCH')!.init.body))).toEqual({ budget: { type, micro_amount: 120_000_000 } });
  });
  it('sends delivery as the only ad-set PATCH field', async () => {
    const { client, calls } = fixture(({ init }) => ({ ...adSet, ...(init.method === 'PATCH' ? JSON.parse(String(init.body)) : {}) }));
    await new SpotifyAdsProvider(client).applyWrite({ ...budgetOp, tool: 'spotify_set_ad_set_delivery', payload: { ad_set_id: ADSET, delivery: 'OFF' } }, guard);
    expect(JSON.parse(String(calls.find(c => c.init.method === 'PATCH')!.init.body))).toEqual({ delivery: 'OFF' });
  });
  it('rejects wrong resource IDs before writing', async () => {
    const { client, calls } = fixture(() => ({ ...adSet, id: CAMPAIGN }));
    await expect(new SpotifyAdsProvider(client).applyWrite(budgetOp, guard)).rejects.toThrow('ID mismatch');
    expect(calls.some(c => c.init.method === 'PATCH')).toBe(false);
  });
  it('enforces pending tokens, exact arguments, budget caps, protected accounts and audit logging', async () => {
    const { client, calls } = fixture(({ init }) => ({ ...adSet, ...(init.method === 'PATCH' ? JSON.parse(String(init.body)) : {}) }));
    const provider = new SpotifyAdsProvider(client);
    const dir = await temp();
    const audit = new AuditLog(path.join(dir, 'audit'));
    const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), audit);
    const runtime = await createContext({ engine, providerModules: [{ provider, tools: spotifyTools(provider) }] });
    const args = { ...budgetOp.payload, account_id: ACCOUNT };
    const pending = await runtime.registry.call(budgetOp.tool, args, runtime.ctx) as { pending_operation_id: string };
    expect(calls.some(c => c.init.method === 'PATCH')).toBe(false);
    await expect(runtime.registry.call(budgetOp.tool, { ...args, budget_micros: 121_000_000, ...pending }, runtime.ctx)).rejects.toThrow('differs');
    await runtime.registry.call(budgetOp.tool, { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx);
    expect(calls.filter(c => c.init.method === 'PATCH')).toHaveLength(1);
    await expect(runtime.registry.call(budgetOp.tool, { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('No pending');
    await expect(runtime.registry.call(budgetOp.tool, { ...args, budget_micros: 200_000_000 }, runtime.ctx)).rejects.toThrow('budget-delta cap');
    const blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [ACCOUNT] }, new PendingStore(path.join(dir, 'protected')), audit);
    await expect(blocked.validate(provider, budgetOp)).rejects.toThrow('protected');
    expect((await audit.read()).map(e => e.event)).toEqual(expect.arrayContaining(['validated', 'applied', 'rejected']));
  });
  it('loads environment credentials only when complete, without mixing sources', async () => {
    const store = new CredentialStore(await temp());
    vi.stubEnv('SPOTIFY_CLIENT_ID', 'id'); vi.stubEnv('SPOTIFY_CLIENT_SECRET', 'secret'); vi.stubEnv('SPOTIFY_REFRESH_TOKEN', '');
    expect(await createSpotifyModule(store)).toBeUndefined();
    vi.stubEnv('SPOTIFY_REFRESH_TOKEN', 'refresh');
    expect((await createSpotifyModule(store))?.provider.id).toBe('spotify');
  });
  it('prefers complete local credentials and preserves other fields during refresh rotation', async () => {
    const dir = await temp();
    const store = new CredentialStore(dir);
    await store.set({ provider: 'spotify', source: 'byo', data: { client_id: 'stored-id', client_secret: 'stored-secret', refresh_token: 'stored-refresh', redirect_uri: 'local-callback' } });
    const credentials = await resolveSpotifyCredentials(store);
    expect(credentials?.clientId).toBe('stored-id');
    await credentials!.onRefreshToken!('rotated');
    expect((await store.get('spotify'))?.data).toMatchObject({ refresh_token: 'rotated', redirect_uri: 'local-callback' });
    expect((await stat(path.join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
  });
});
