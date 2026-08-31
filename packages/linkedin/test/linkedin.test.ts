import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, CredentialStore, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type NormalizedQuery, type WriteOperation } from '@adport/core';
import { LinkedInAdsClient, LINKEDIN_API_VERSION, LINKEDIN_TOKEN_URL, buildLinkedInAuthUrl, exchangeLinkedInCode, restli } from '../src/client.js';
import { LinkedInAdsProvider, decimalToMicros, microsToDecimal } from '../src/provider.js';
import { accountSchema, NON_DISCRIMINATION_NOTICE, NON_POLITICAL_CONSENT } from '../src/schemas.js';
import { linkedinTools } from '../src/tools.js';
import { createLinkedInModule, resolveLinkedInCredentials } from '../src/index.js';

// Synthetic fixtures grounded in the official LinkedIn Marketing 202608 docs:
// create-and-manage-accounts, create-and-manage-campaigns, ads-reporting-schema,
// protocol-version and programmatic-refresh-tokens. See docs/providers/linkedin.md.
const ACCOUNT = '518121035', CAMPAIGN = '145282384', GROUP = '635137195';
const account = { id: Number(ACCOUNT), name: 'Synthetic EUR account', currency: 'EUR', status: 'ACTIVE', test: true, type: 'BUSINESS' };
const campaign = { id: Number(CAMPAIGN), account: `urn:li:sponsoredAccount:${ACCOUNT}`, campaignGroup: `urn:li:sponsoredCampaignGroup:${GROUP}`, name: 'Campaign', status: 'ACTIVE', dailyBudget: { amount: '100.000001', currencyCode: 'EUR' } };
const group = { id: Number(GROUP), account: campaign.account, name: 'Group', status: 'ACTIVE' };
const dateRange = { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 7 } };
const row = { pivotValues: [`urn:li:sponsoredCampaign:${CAMPAIGN}`], dateRange, costInLocalCurrency: '20.5', impressions: 1000, clicks: 20, externalWebsiteConversions: 2, conversionValueInLocalCurrency: '82.0' };
const query: NormalizedQuery = { accountIds: [ACCOUNT], level: 'campaign', dateRange: { start: '2026-08-01', end: '2026-08-07' }, metrics: ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'ctr', 'cpc', 'cpm', 'cpa', 'roas'] };
const guard = { forcePausedCreation: true };
const createOp: WriteOperation = { provider: 'linkedin', accountId: ACCOUNT, tool: 'linkedin_create_campaign', kind: 'create', payload: {
  name: 'New campaign', campaign_group_id: GROUP, type: 'TEXT_AD', objective_type: 'WEBSITE_VISITS', cost_type: 'CPC', unit_cost_micros: 1_000_001,
  daily_budget_micros: 20_000_001, locale: { country: 'DE', language: 'de' },
  targeting_criteria: { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:101282230'] } }] } }, status: 'ACTIVE', non_political_consent: true,
} };
const budgetOp: WriteOperation = { provider: 'linkedin', accountId: ACCOUNT, tool: 'linkedin_set_budget', kind: 'update', payload: { campaign_id: CAMPAIGN, budget_type: 'DAILY', budget_micros: 110_000_001 } };
type Call = { url: URL; init: RequestInit };
function fixture(handler: (call: Call) => unknown | Response, credentials = { accessToken: 'access' }) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const reply = handler(call); return reply instanceof Response ? reply : Response.json(reply);
  };
  const client = new LinkedInAdsClient(credentials, fetchImpl);
  return { client, provider: new LinkedInAdsProvider(client), calls, fetchImpl };
}
const dirs: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), 'adport-linkedin-')); dirs.push(dir); return dir; }
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });

describe('LinkedIn OAuth and Rest.li wire contracts', () => {
  it('uses the Ads-only scopes, state and a user-owned HTTPS callback', () => {
    const url = new URL(buildLinkedInAuthUrl('client', 'https://example.test/linkedin', 'csrf'));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', client_id: 'client', redirect_uri: 'https://example.test/linkedin', state: 'csrf', scope: 'rw_ads r_ads_reporting' });
    expect(() => buildLinkedInAuthUrl('client', 'http://localhost:53687/callback', 'csrf')).toThrow('HTTPS');
  });
  it('exchanges a code using form body credentials and accepts a non-refreshable access token', async () => {
    const { fetchImpl, calls } = fixture(() => ({ access_token: 'fresh', expires_in: 3600 }));
    const tokens = await exchangeLinkedInCode({ clientId: 'client', clientSecret: 'secret', code: 'code+&', redirectUri: 'https://example.test/linkedin' }, fetchImpl);
    expect(tokens.accessToken).toBe('fresh'); expect(tokens.refreshToken).toBeUndefined();
    expect(calls[0]!.url.href).toBe(LINKEDIN_TOKEN_URL);
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ grant_type: 'authorization_code', client_id: 'client', client_secret: 'secret', code: 'code+&', redirect_uri: 'https://example.test/linkedin' });
  });
  it('encodes URN leaves but not Rest.li structure', () => {
    expect(restli(['urn:li:sponsoredAccount:123'])).toBe('List(urn%3Ali%3AsponsoredAccount%3A123)');
    expect(restli({ status: { values: ['ACTIVE', 'PAUSED'] } })).toBe('(status:(values:List(ACTIVE,PAUSED)))');
    expect(restli('x)&evil=true')).toBe('x%29%26evil%3Dtrue');
  });
  it('pins the reviewed marketing version and Rest.li 2.0 headers', async () => {
    const { client, calls } = fixture(() => account);
    await client.get(`adAccounts/${ACCOUNT}`, accountSchema);
    expect(calls[0]!.url.href).toBe(`https://api.linkedin.com/rest/adAccounts/${ACCOUNT}`);
    expect(calls[0]!.init.headers).toEqual({ authorization: 'Bearer access', 'Linkedin-Version': LINKEDIN_API_VERSION, 'X-Restli-Protocol-Version': '2.0.0' });
    expect(calls[0]!.init.redirect).toBe('error');
  });
  it('single-flights refresh and never extends the fixed refresh-token lifetime', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-31T00:00:00Z'));
    const { fetchImpl, calls } = fixture(({ url }) => url.href === LINKEDIN_TOKEN_URL ? { access_token: 'new-access', expires_in: 3600, refresh_token: 'rotated', refresh_token_expires_in: 9999999 } : account);
    const persist = vi.fn();
    const expiry = Date.now() + 500_000;
    const client = new LinkedInAdsClient({ accessToken: 'old', expiresAt: 0, clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', refreshExpiresAt: expiry, onTokens: persist }, fetchImpl);
    await Promise.all([1, 2].map(() => client.get('adAccounts', accountSchema)));
    expect(calls.filter(c => c.url.href === LINKEDIN_TOKEN_URL)).toHaveLength(1);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'new-access', refreshToken: 'rotated', refreshExpiresAt: expiry }));
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh', client_id: 'client', client_secret: 'secret' });
  });
  it('does not refresh an expired partner grant or silently reuse an expired token', async () => {
    const { fetchImpl, calls } = fixture(() => account);
    const client = new LinkedInAdsClient({ accessToken: 'old', expiresAt: 0, clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', refreshExpiresAt: 0 }, fetchImpl);
    await expect(client.get('adAccounts', accountSchema)).rejects.toThrow('fresh authorized token'); expect(calls).toHaveLength(0);
  });
  it('refreshes a 401 read only once when a partner refresh grant exists', async () => {
    let attempts = 0;
    const { fetchImpl, calls } = fixture(({ url }) => url.href === LINKEDIN_TOKEN_URL ? { access_token: 'fresh', expires_in: 3600 } : ++attempts === 1 ? Response.json({}, { status: 401 }) : account);
    const client = new LinkedInAdsClient({ accessToken: 'old', clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, fetchImpl);
    await client.get('adAccounts', accountSchema);
    expect(attempts).toBe(2); expect(calls.filter(c => c.url.href === LINKEDIN_TOKEN_URL)).toHaveLength(1);
  });
  it('does not replay a failed write or expose error response bodies', async () => {
    const { client, calls } = fixture(() => Response.json({ message: 'private-secret' }, { status: 403 }));
    await expect(client.update(`adAccounts/${ACCOUNT}/adCampaigns/${CAMPAIGN}`, { status: 'PAUSED' })).rejects.toThrow('Advertising API approval');
    expect(calls).toHaveLength(1);
    await expect(client.get('adAccounts', accountSchema)).rejects.not.toThrow('private-secret');
  });
  it.each(['https://evil.example', '//evil.example', '/adAccounts', 'adAccounts/../oauth', 'adAccounts?token=1'])('rejects unsafe resource path %s before sending credentials', async path => {
    const { client, calls } = fixture(() => account);
    await expect(client.get(path, accountSchema)).rejects.toThrow('invalid API resource path'); expect(calls).toHaveLength(0);
  });
  it('requires 201 and x-restli-id on create, and 204 on partial update', async () => {
    const created = fixture(() => new Response(null, { status: 201, headers: { 'x-restli-id': CAMPAIGN } }));
    expect(await created.client.create('adAccounts', {})).toBe(CAMPAIGN);
    const invalid = fixture(() => Response.json({ id: CAMPAIGN }));
    await expect(invalid.client.create('adAccounts', {})).rejects.toThrow('x-restli-id');
    await expect(invalid.client.update('adAccounts', {})).rejects.toThrow('204');
  });
});

describe('LinkedIn discovery and reporting', () => {
  it('discovers accounts using numeric IDs and metadata.nextPageToken', async () => {
    const { provider, calls } = fixture(({ url }) => url.searchParams.has('pageToken') ? { elements: [{ ...account, id: 123 }], metadata: {} } : { elements: [account], metadata: { nextPageToken: 'next)+&' } });
    expect(await provider.listAccounts()).toEqual([{ provider: 'linkedin', id: ACCOUNT, name: account.name, currency: 'EUR', status: 'ACTIVE' }, { provider: 'linkedin', id: '123', name: account.name, currency: 'EUR', status: 'ACTIVE' }]);
    expect(calls[0]!.url.searchParams.get('q')).toBe('search'); expect(calls[0]!.url.searchParams.get('pageSize')).toBe('100');
    expect(calls[1]!.url.searchParams.get('pageToken')).toBe('next)+&'); expect(calls[1]!.url.searchParams.has('start')).toBe(false);
  });
  it('keeps mandatory campaign search and inactive statuses across cursor pages', async () => {
    const { provider, calls } = fixture(() => ({ elements: [campaign] }));
    expect(await provider.listCampaigns(ACCOUNT)).toHaveLength(1);
    expect(calls[0]!.url.href).toContain('search=(status:(values:List(ACTIVE,PAUSED,ARCHIVED,COMPLETED,CANCELED,DRAFT,PENDING_DELETION,REMOVED)))');
  });
  it('lists actual campaign groups without rebranding them as ad groups', async () => {
    const { provider, calls } = fixture(() => ({ elements: [group] }));
    expect(await provider.listCampaignGroups(ACCOUNT)).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe(`/rest/adAccounts/${ACCOUNT}/adCampaignGroups`);
    await expect(provider.report({ ...query, level: 'ad_group' })).rejects.toThrow('no native ad-group');
  });
  it.each([{ elements: [], metadata: { nextPageToken: 'loop' } }, { elements: [campaign], metadata: { nextPageToken: 'loop' } }])('rejects repeated cursor/entities', async response => {
    const { provider } = fixture(() => response);
    await expect(provider.listCampaigns(ACCOUNT)).rejects.toThrow(/pagination|repeated/);
  });
  it.each([{ elements: [{ ...campaign, account: 'urn:li:sponsoredAccount:123' }] }, { elements: [{ ...campaign, id: CAMPAIGN }] }, {}])('rejects malformed or cross-account campaign records', async response => {
    const { provider } = fixture(() => response);
    await expect(provider.listCampaigns(ACCOUNT)).rejects.toThrow('linkedin:');
  });
  it('uses the documented analytics fields, Rest.li query and local-currency decimal strings', async () => {
    const { provider, calls } = fixture(({ url }) => url.pathname.endsWith('/adAnalytics') ? { elements: [row], paging: { count: 10, start: 0, links: [] } } : url.pathname.endsWith('/adCampaigns') ? { elements: [campaign] } : account);
    const result = await provider.report(query);
    expect(result.rows[0]!.metrics).toEqual({ spend: 20.5, impressions: 1000, clicks: 20, conversions: 2, conversion_value: 82, ctr: 2, cpc: 1.025, cpm: 20.5, cpa: 10.25, roas: 4 });
    const request = calls.at(-1)!.url;
    expect(request.href).toContain(`accounts=List(urn%3Ali%3AsponsoredAccount%3A${ACCOUNT})`);
    expect(request.href).toContain('dateRange=(start:(year:2026,month:8,day:1),end:(year:2026,month:8,day:7))');
    expect(request.searchParams.get('fields')).toBe('pivotValues,dateRange,costInLocalCurrency,impressions,clicks,externalWebsiteConversions,conversionValueInLocalCurrency');
    expect(request.searchParams.get('timeGranularity')).toBe('ALL'); expect(request.searchParams.has('count')).toBe(false);
  });
  it.each(['account', 'ad'] as const)('maps normalized %s to the native pivot', async level => {
    const { provider, calls } = fixture(({ url }) => url.pathname.endsWith('/adAnalytics') ? { elements: [{ ...row, pivotValues: [level === 'account' ? campaign.account : 'urn:li:sponsoredCreative:123'] }] } : account);
    expect((await provider.report({ ...query, level })).rows[0]!.entity.id).toBe(level === 'account' ? ACCOUNT : '123');
    expect(calls.at(-1)!.url.searchParams.get('pivot')).toBe(level === 'account' ? 'ACCOUNT' : 'CREATIVE');
  });
  it('omits unavailable conversions instead of inventing zeros', async () => {
    const { provider } = fixture(({ url }) => url.pathname.endsWith('/adAnalytics') ? { elements: [{ pivotValues: [campaign.account], dateRange, costInLocalCurrency: '2.0' }] } : account);
    expect((await provider.report({ ...query, level: 'account' })).rows[0]!.metrics).toEqual({ spend: 2 });
  });
  it('accepts empty analytics without claiming it proves reporting permission', async () => {
    const { provider } = fixture(({ url }) => url.pathname.endsWith('/adAnalytics') ? { elements: [] } : account);
    expect(await provider.report({ ...query, level: 'account' })).toEqual({ rows: [] });
  });
  it.each([
    { elements: [{ ...row, pivotValues: ['urn:li:sponsoredAccount:123'] }] },
    { elements: [{ ...row, dateRange: { ...dateRange, start: { year: 2026, month: 7, day: 1 } } }] },
    { elements: [{ ...row, costInLocalCurrency: 20.5 }] },
    { elements: [row, row] },
    { elements: [row], paging: { links: [{ rel: 'next' }] } },
  ])('rejects wrong pivots, widened dates, malformed decimals and unsupported pagination', async response => {
    const { provider } = fixture(({ url }) => url.pathname.endsWith('/adAnalytics') ? response : url.pathname.endsWith('/adCampaigns') ? { elements: [campaign] } : account);
    await expect(provider.report(query)).rejects.toThrow('linkedin:');
  });
  it('marks the documented 15000-element ceiling as potentially truncated', async () => {
    const rows = Array.from({ length: 15000 }, (_, i) => ({ ...row, pivotValues: [`urn:li:sponsoredCreative:${i + 1}`] }));
    const { provider } = fixture(({ url }) => url.pathname.endsWith('/adAnalytics') ? { elements: rows } : account);
    const report = await provider.report({ ...query, level: 'ad', limit: 20000 });
    expect(report.rows).toHaveLength(15000); expect(report.truncated).toBe(true);
  });
});

describe('LinkedIn safety, money and credentials', () => {
  it('converts decimal budgets exactly without floating-point rounding', () => {
    expect(decimalToMicros('100.000001')).toBe(100_000_001); expect(microsToDecimal(100_000_001)).toBe('100.000001');
    expect(decimalToMicros('1.0000000')).toBe(1_000_000);
    expect(() => decimalToMicros('1.0000001')).toThrow('precision');
    expect(() => decimalToMicros('999999999999')).toThrow('safe integer');
  });
  it('previews creation with ownership reads, policy notices and coercion, then creates via x-restli-id', async () => {
    const { provider, calls } = fixture(({ url, init }) => init.method === 'POST' ? new Response(null, { status: 201, headers: { 'x-restli-id': CAMPAIGN } }) : url.pathname.includes('/adCampaignGroups/') ? group : account);
    const preview = await provider.previewWrite(createOp, guard);
    expect(preview.serverValidated).toBe(false); expect(preview.changes).toContain(NON_DISCRIMINATION_NOTICE); expect(preview.changes).toContain(`Advertiser confirmation: ${NON_POLITICAL_CONSENT}`); expect(preview.coercions).toHaveLength(1);
    expect(calls.every(c => c.init.method === 'GET')).toBe(true);
    expect(preview.budgetDeltas).toEqual([{ target: 'new campaign daily budget', toMicros: 20_000_001 }]);
    expect(await provider.applyWrite(createOp, guard)).toEqual({ applied: true, resourceIds: [CAMPAIGN] });
    const post = calls.at(-1)!;
    expect(post.url.pathname).toBe(`/rest/adAccounts/${ACCOUNT}/adCampaigns`);
    expect(JSON.parse(String(post.init.body))).toMatchObject({ account: campaign.account, campaignGroup: campaign.campaignGroup, dailyBudget: { amount: '20.000001', currencyCode: 'EUR' }, unitCost: { amount: '1.000001', currencyCode: 'EUR' }, status: 'PAUSED', politicalIntent: 'NOT_POLITICAL', offsiteDeliveryEnabled: false });
    expect(JSON.parse(String(post.init.body))).not.toHaveProperty('non_political_consent');
  });
  it('does not fabricate advertiser consent', async () => {
    const { provider, calls } = fixture(() => ({}));
    await expect(provider.previewWrite({ ...createOp, payload: { ...createOp.payload, non_political_consent: undefined } }, guard)).rejects.toThrow();
    await expect(provider.previewWrite({ ...budgetOp, tool: 'linkedin_set_campaign_status', payload: { campaign_id: CAMPAIGN, status: 'ACTIVE' } }, guard)).rejects.toThrow('explicit advertiser consent');
    expect(calls).toHaveLength(0);
  });
  it('POSTs Rest.li partial updates, preserving currency and unrelated budgets', async () => {
    const { provider, calls } = fixture(({ init }) => init.method === 'POST' ? new Response(null, { status: 204 }) : campaign);
    expect((await provider.previewWrite(budgetOp, guard)).budgetDeltas).toEqual([{ target: `campaign ${CAMPAIGN} dailyBudget`, fromMicros: 100_000_001, toMicros: 110_000_001 }]);
    await provider.applyWrite(budgetOp, guard);
    const post = calls.at(-1)!;
    expect(post.init.method).toBe('POST');
    expect(new Headers(post.init.headers).get('X-RestLi-Method')).toBe('PARTIAL_UPDATE');
    expect(JSON.parse(String(post.init.body))).toEqual({ patch: { $set: { dailyBudget: { amount: '110.000001', currencyCode: 'EUR' } } } });
  });
  it('pauses without changing political declaration or budgets', async () => {
    const { provider, calls } = fixture(({ init }) => init.method === 'POST' ? new Response(null, { status: 204 }) : campaign);
    await provider.applyWrite({ ...budgetOp, tool: 'linkedin_set_campaign_status', payload: { campaign_id: CAMPAIGN, status: 'PAUSED' } }, guard);
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ patch: { $set: { status: 'PAUSED' } } });
  });
  it('activates only with the declared non-political consent in the preview and wire payload', async () => {
    const { provider, calls } = fixture(({ init }) => init.method === 'POST' ? new Response(null, { status: 204 }) : campaign);
    const op = { ...budgetOp, tool: 'linkedin_set_campaign_status', payload: { campaign_id: CAMPAIGN, status: 'ACTIVE', non_political_consent: true } };
    expect((await provider.previewWrite(op, guard)).changes).toContain(`Advertiser confirmation: ${NON_POLITICAL_CONSENT}`);
    await provider.applyWrite(op, guard);
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ patch: { $set: { status: 'ACTIVE', politicalIntent: 'NOT_POLITICAL' } } });
  });
  it('changes an existing total budget without resetting a daily cap', async () => {
    const { provider, calls } = fixture(({ init }) => init.method === 'POST' ? new Response(null, { status: 204 }) : { ...campaign, totalBudget: { amount: '200.0', currencyCode: 'EUR' } });
    await provider.applyWrite({ ...budgetOp, payload: { ...budgetOp.payload, budget_type: 'TOTAL', budget_micros: 220_000_000 } }, guard);
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ patch: { $set: { totalBudget: { amount: '220.000000', currencyCode: 'EUR' } } } });
  });
  it('creates lifetime-paced campaigns with an explicit schedule and total budget', async () => {
    const { provider, calls } = fixture(({ url, init }) => init.method === 'POST' ? new Response(null, { status: 201, headers: { 'x-restli-id': CAMPAIGN } }) : url.pathname.includes('/adCampaignGroups/') ? group : account);
    await provider.applyWrite({ ...createOp, payload: { ...createOp.payload, daily_budget_micros: undefined, total_budget_micros: 200_000_000, start_time: 1893456000000, end_time: 1894060800000 } }, guard);
    const body = JSON.parse(String(calls.at(-1)!.init.body));
    expect(body).toMatchObject({ totalBudget: { amount: '200.000000', currencyCode: 'EUR' }, pacingStrategy: 'LIFETIME', runSchedule: { start: 1893456000000, end: 1894060800000 } });
    expect(body.dailyBudget).toBeUndefined();
  });
  it('rejects legacy geography identifiers before a provider call', async () => {
    const { provider, calls } = fixture(() => account);
    await expect(provider.previewWrite({ ...createOp, payload: { ...createOp.payload, targeting_criteria: { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:country:de'] } }] } } } }, guard)).rejects.toThrow('legacy geo');
    expect(calls).toHaveLength(0);
  });
  it('rejects the wrong parent account and unsupported group-shared budgets', async () => {
    for (const invalidGroup of [{ ...group, account: 'urn:li:sponsoredAccount:123' }, { ...group, budgetOptimization: { budgetOptimizationStrategy: 'DYNAMIC' } }]) {
      const { provider, calls } = fixture(({ url }) => url.pathname.includes('/adCampaignGroups/') ? invalidGroup : account);
      await expect(provider.applyWrite(createOp, guard)).rejects.toThrow('linkedin:'); expect(calls.every(c => c.init.method === 'GET')).toBe(true);
    }
  });
  it('uses the shared exact-approval gate and rejects budget caps and protected accounts', async () => {
    const dir = await temp(), audit = new AuditLog(path.join(dir, 'audit'));
    const { provider, calls } = fixture(({ init }) => init.method === 'POST' ? new Response(null, { status: 204 }) : campaign);
    const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), audit);
    const runtime = await createContext({ engine, providerModules: [{ provider, tools: linkedinTools(provider) }] });
    const input = { account_id: ACCOUNT, ...budgetOp.payload };
    const pending = await runtime.registry.call(budgetOp.tool, input, runtime.ctx) as { pending_operation_id: string };
    expect(calls.some(c => c.init.method === 'POST')).toBe(false);
    await expect(runtime.registry.call(budgetOp.tool, { ...input, ...pending, budget_micros: 111_000_000 }, runtime.ctx)).rejects.toThrow('differs');
    await runtime.registry.call(budgetOp.tool, { ...input, ...pending }, runtime.ctx);
    expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(1);
    await expect(runtime.registry.call(budgetOp.tool, { ...input, budget_micros: 500_000_000 }, runtime.ctx)).rejects.toThrow('budget-delta cap');
    const blocked = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [ACCOUNT] }, new PendingStore(path.join(dir, 'blocked')), audit);
    await expect(blocked.validate(provider, budgetOp)).rejects.toThrow('protected');
  });
  it('loads access-only credentials and persists refreshed access/refresh expirations', async () => {
    const dir = await temp(), store = new CredentialStore(dir);
    await store.set({ provider: 'linkedin', source: 'byo', data: { access_token: 'stored', expires_at: '123', custom: 'keep' } });
    const credentials = await resolveLinkedInCredentials(store);
    expect(credentials?.accessToken).toBe('stored'); expect((await createLinkedInModule(store))?.provider.id).toBe('linkedin');
    await credentials!.onTokens!({ accessToken: 'new', expiresAt: 456, refreshToken: 'refresh', refreshExpiresAt: 789 });
    expect((await store.get('linkedin'))!.data).toEqual({ access_token: 'new', expires_at: '456', refresh_token: 'refresh', refresh_expires_at: '789', custom: 'keep' });
    expect((await stat(path.join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
  });
  it('never mixes stored partial refresh credentials with environment secrets', async () => {
    const store = new CredentialStore(await temp());
    await store.set({ provider: 'linkedin', source: 'byo', data: { client_id: 'stored' } });
    vi.stubEnv('LINKEDIN_ACCESS_TOKEN', ''); vi.stubEnv('LINKEDIN_CLIENT_ID', ''); vi.stubEnv('LINKEDIN_CLIENT_SECRET', 'secret'); vi.stubEnv('LINKEDIN_REFRESH_TOKEN', 'refresh');
    expect(await resolveLinkedInCredentials(store)).toBeUndefined();
    vi.stubEnv('LINKEDIN_ACCESS_TOKEN', 'environment');
    expect(await resolveLinkedInCredentials(store)).toMatchObject({ accessToken: 'environment' });
  });
});
