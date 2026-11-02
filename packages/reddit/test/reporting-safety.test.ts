import { describe, expect, it } from 'vitest';
import { RedditAdsClient, REDDIT_TOKEN_URL } from '../src/client.js';
import { RedditAdsProvider } from '../src/provider.js';
import { redditTools } from '../src/tools.js';

// Current Reddit-owned v3 OpenAPI fetched2026-11-03: POST-only report pages,
// micros for spend and cents for CONVERSION*TOTAL_VALUE. Synthetic responses.
const credentials = { clientId: 'client-c', clientSecret: 'secret-s', refreshToken: 'refresh-r', userAgent: 'desktop:dev.adport.test:v0.7 (by /u/adporttest)' };
type Call = { url: URL; init: RequestInit };
function fixture(handler: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new RedditAdsClient(credentials, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === REDDIT_TOKEN_URL) return Response.json({ access_token: 'access-token', expires_in: 3600 });
    const data = handler(call); return data instanceof Response ? data : Response.json(data);
  });
  return { client, provider: new RedditAdsProvider(client), calls };
}
const query = { accountIds: ['a2_test'], level: 'campaign' as const, metrics: ['spend', 'clicks', 'conversions', 'conversion_value', 'roas'] as Array<'spend' | 'clicks' | 'conversions' | 'conversion_value' | 'roas'>, dateRange: { start: '2026-11-01', end: '2026-11-02' } };
const reportRow = (id: string) => ({ campaign_id: id, spend: 100_000, clicks: 2, conversion_purchase_clicks: 1, conversion_purchase_views: 0, conversion_purchase_total_value: 100 });

describe('Reddit native report pagination and metric fidelity', () => {
  it('follows native report next_url with the exact POST body on every page', async () => {
    const next = 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_test/reports?page.token=opaque%2Btoken&page.size=2';
    const { provider, calls } = fixture(call => ({ data: { metrics: [reportRow(call.url.href === next ? 'second' : 'first')] }, pagination: call.url.href === next ? {} : { next_url: next } }));
    const result = await provider.report(query); expect(result.rows.map(row => row.entity.id)).toEqual(['first', 'second']);
    const pages = calls.filter(call => call.url.pathname.endsWith('/reports')); expect(pages.map(call => call.init.method)).toEqual(['POST', 'POST']); expect(pages[1]!.url.href).toBe(next); expect(pages[1]!.init.body).toBe(pages[0]!.init.body);
  });
  it('keeps missing/suppressed conversion data unavailable and retains micro precision', async () => {
    const { provider } = fixture(() => ({ data: { metrics: [{ campaign_id: 'one', spend: 1201, clicks: 2, conversion_purchase_clicks: 1, conversion_purchase_total_value: null }] } }));
    const result = await provider.report({ ...query, metrics: ['spend', 'clicks', 'conversions', 'conversion_value', 'roas'] }); expect(result.rows[0]!.metrics).toEqual({ spend: 0.001201, clicks: 2 });
  });
  it('enforces a global limit across accounts and marks unqueried scope truncated', async () => {
    const { provider, calls } = fixture(() => ({ data: { metrics: [reportRow('one'), reportRow('two')] } }));
    const result = await provider.report({ ...query, accountIds: ['a2_test', 'a2_second'], limit: 1 }); expect(result.rows).toHaveLength(1); expect(result.truncated).toBe(true); expect(calls.some(call => call.url.pathname.includes('a2_second'))).toBe(false);
  });
  it('reports truncation when the native response exposes another page at the limit', async () => {
    const { provider } = fixture(() => ({ data: { metrics: [reportRow('one')] }, pagination: { next_url: 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_test/reports?page.token=next' } }));
    const result = await provider.report({ ...query, limit: 1 }); expect(result.rows).toHaveLength(1); expect(result.truncated).toBe(true);
  });
  it('normalizes raw field/breakdown names to native uppercase and preserves report freshness', async () => {
    const { provider, calls } = fixture(() => ({ data: { metrics: [], metrics_updated_at: '2026-11-03T00:00:00Z' } }));
    expect(await provider.rawReport({ account_id: 'a2_test', fields: ['spend', 'conversion_purchase_total_value'], breakdowns: ['campaign_id'], starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-11-02T00:00:00Z' })).toMatchObject({ metrics: [], truncated: false, metrics_updated_at: '2026-11-03T00:00:00Z' });
    expect(JSON.parse(String(calls.at(-1)!.init.body)).data).toMatchObject({ fields: ['SPEND', 'CONVERSION_PURCHASE_TOTAL_VALUE'], breakdowns: ['CAMPAIGN_ID'] });
  });
  it.each(['https://evil.example/api/v3/ad_accounts/a2_test/reports?page.token=next', 'https://ads-api.reddit.com/api/v3/ad_accounts/foreign/reports?page.token=next'])('rejects foreign report pagination without forwarding the body: %s', async next => {
    const { provider, calls } = fixture(() => ({ data: { metrics: [reportRow('one')] }, pagination: { next_url: next } }));
    await expect(provider.report(query)).rejects.toThrow(/must stay within|changed resource scope/); expect(calls.filter(call => call.url.pathname.endsWith('/reports'))).toHaveLength(1);
  });
  it('detects report pagination cycles and rejects malformed metrics instead of fabricating an empty success', async () => {
    const cycle = fixture(() => ({ data: { metrics: [] }, pagination: { next_url: 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_test/reports?page.size=1000' } }));
    await expect(cycle.provider.report(query)).rejects.toThrow('did not terminate'); expect(cycle.calls).toHaveLength(2);
    const malformed = fixture(() => ({ data: {} })); await expect(malformed.provider.report(query)).rejects.toThrow('malformed report');
    const missingId = fixture(() => ({ data: { metrics: [{ spend: 2 }] } })); await expect(missingId.provider.report(query)).rejects.toThrow('missing its requested entity');
  });
});

describe('Reddit transport and generic-tool boundaries', () => {
  it('enforces the current objective enum and gives new campaigns the native CLICKS default', async () => {
    const { provider, calls } = fixture(() => { throw new Error('No provider call expected'); });
    const tool = redditTools(provider).find(t => t.name === 'reddit_create_campaign')!;
    expect(tool.input.parse({ account_id: 'a2_test', name: 'New', funding_instrument_id: 'funding-1' })).toMatchObject({ objective: 'CLICKS', configured_status: 'PAUSED' });
    await expect(provider.previewWrite({ tool: 'reddit_create_campaign', provider: 'reddit', accountId: 'a2_test', kind: 'create', payload: { name: 'New', funding_instrument_id: 'funding-1', objective: 'TRAFFIC' } }, { forcePausedCreation: true })).rejects.toThrow(); expect(calls).toEqual([]);
  });
  it.each(['ACTIVE', 'FOREIGN', 'BUDGET'])('rejects a misleading campaign create receipt and retains the exact new ID: %s', async mismatch => {
    const { provider } = fixture(() => ({ data: { id: 'new-campaign', name: 'New', objective: 'CLICKS', funding_instrument_id: 'funding-1', configured_status: mismatch === 'ACTIVE' ? 'ACTIVE' : 'PAUSED', ad_account_id: mismatch === 'FOREIGN' ? 'other' : 'a2_test', goal_type: 'DAILY_SPEND', goal_value: mismatch === 'BUDGET' ? 999_000_000 : 100_000_000, is_campaign_budget_optimization: true } }));
    await expect(provider.applyWrite({ tool: 'reddit_create_campaign', provider: 'reddit', accountId: 'a2_test', kind: 'create', payload: { name: 'New', funding_instrument_id: 'funding-1', budget_micros: 100_000_000, conversion_pixel_id: 'pixel-1' } }, { forcePausedCreation: true })).rejects.toMatchObject({ details: { resource_ids: ['new-campaign'] } });
  });
  it('preserves the immutable campaign budget type and requires the current monetary value', async () => {
    const { provider, calls } = fixture(() => ({ data: { id: 'campaign', ad_account_id: 'a2_test', name: 'Campaign', is_campaign_budget_optimization: true, goal_type: 'DAILY_SPEND', goal_value: 100_000_000 } }));
    await expect(provider.previewWrite({ tool: 'reddit_set_budget', provider: 'reddit', accountId: 'a2_test', kind: 'update', payload: { campaign_id: 'campaign', budget_micros: 110_000_000, budget_type: 'LIFETIME_SPEND' } }, { forcePausedCreation: true })).rejects.toThrow('immutable'); expect(calls.every(call => call.init.method !== 'PATCH')).toBe(true);
    const missing = fixture(() => ({ data: { id: 'campaign', ad_account_id: 'a2_test', name: 'Campaign', is_campaign_budget_optimization: true, goal_type: 'DAILY_SPEND' } }));
    await expect(missing.provider.previewWrite({ tool: 'reddit_set_budget', provider: 'reddit', accountId: 'a2_test', kind: 'update', payload: { campaign_id: 'campaign', budget_micros: 110_000_000 } }, { forcePausedCreation: true })).rejects.toThrow('unavailable');
  });
  it('single-flights OAuth and rejects redirects for both credentials and API data', async () => {
    const { client, calls } = fixture(() => ({ data: [] })); await Promise.all([client.get('me/businesses'), client.get('me/businesses')]);
    expect(calls.filter(call => call.url.href === REDDIT_TOKEN_URL)).toHaveLength(1); expect(calls.every(call => call.init.redirect === 'error' && call.init.signal)).toBe(true);
  });
  it('rejects non-list payloads, pagination cycles and resource scope changes', async () => {
    const notList = fixture(() => ({ data: {} })); await expect(notList.client.getPaged('me/businesses')).rejects.toThrow('native list');
    const loop = fixture(() => ({ data: [], pagination: { next_url: 'https://ads-api.reddit.com/api/v3/me/businesses' } })); await expect(loop.client.getPaged('me/businesses')).rejects.toThrow('did not terminate');
    const foreign = fixture(() => ({ data: [], pagination: { next_url: 'https://ads-api.reddit.com/api/v3/businesses/foreign/ad_accounts' } })); await expect(foreign.client.getPaged('me/businesses')).rejects.toThrow('changed resource scope'); expect(foreign.calls).toHaveLength(2);
  });
  it('redacts credentials and identifier hashes from bounded native errors', async () => {
    const hash = 'a'.repeat(64), { client } = fixture(() => Response.json({ message: `secret-s refresh-r access-token ${hash}`, sensitive_debug: 'private body must not be returned' }, { status: 400 }));
    try { await client.get('me/businesses'); throw new Error('Expected failure'); } catch (error) { const serialized = JSON.stringify(error); expect(serialized).not.toContain('secret-s'); expect(serialized).not.toContain('private body'); expect(serialized).not.toContain(hash); expect((error as Error).message).toContain('[redacted hash]'); }
  });
  it('does not expose malformed response bytes or retry a mutation', async () => {
    const { client, calls } = fixture(() => new Response('private response body', { status: 200 })); await expect(client.post('ad_accounts/a2_test/campaigns', { data: {} })).rejects.toThrow('malformed API response'); expect(calls).toHaveLength(2);
  });
  it('rejects a global resource read that is not owned by the selected account', async () => {
    const { provider } = fixture(() => ({ data: { id: 'campaign', ad_account_id: 'foreign' } })); await expect(provider.apiRead({ account_id: 'a2_test', path: 'campaigns/campaign' })).rejects.toThrow('does not prove ownership');
  });
  it.each(['1000000000', Number.MAX_SAFE_INTEGER + 1, -1])('rejects malformed native money in generic create instead of omitting it from policy caps: %s', async amount => {
    const { provider, calls } = fixture(() => { throw new Error('No provider request expected'); });
    await expect(provider.previewWrite({ tool: 'reddit_api_create', provider: 'reddit', accountId: 'a2_test', kind: 'create', payload: { path: 'ad_accounts/a2_test/campaigns', body: { data: { name: 'New', goal_value: amount } } } }, { forcePausedCreation: true })).rejects.toThrow('safe integer micros'); expect(calls).toEqual([]);
  });
  it('verifies a generic ad-group parent and rejects unsupported write collections before a mutation', async () => {
    const { provider, calls } = fixture(() => ({ data: { id: 'campaign', ad_account_id: 'foreign' } })); await expect(provider.previewWrite({ tool: 'reddit_api_create', provider: 'reddit', accountId: 'a2_test', kind: 'create', payload: { path: 'ad_accounts/a2_test/ad_groups', body: { data: { campaign_id: 'campaign' } } } }, { forcePausedCreation: true })).rejects.toThrow('does not belong'); expect(calls.every(call => call.init.method !== 'POST' || call.url.href === REDDIT_TOKEN_URL)).toBe(true);
    await expect(provider.previewWrite({ tool: 'reddit_api_create', provider: 'reddit', accountId: 'a2_test', kind: 'create', payload: { path: 'ad_accounts/a2_test/reports', body: { data: {} } } }, { forcePausedCreation: true })).rejects.toThrow('create path');
  });
});
