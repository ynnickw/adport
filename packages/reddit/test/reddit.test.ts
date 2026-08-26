import { describe, expect, it, vi } from 'vitest';
import { RedditAdsClient } from '../src/client.js';
import { REDDIT_MICROS, RedditAdsProvider } from '../src/provider.js';

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(routes: Array<{ match: (url: string, body: string, method: string) => boolean; reply: unknown; status?: number }>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const body = String(init?.body ?? '');
    const method = String(init?.method ?? 'GET');
    const route = routes.find((candidate) => candidate.match(call.url, body, method));
    if (!route) throw new Error(`Unmatched fetch: ${method} ${call.url}\n${body}`);
    return new Response(JSON.stringify(route.reply), { status: route.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const TOKEN_ROUTE = {
  match: (url: string) => url === 'https://www.reddit.com/api/v1/access_token',
  reply: { access_token: 'reddit-at', token_type: 'bearer', expires_in: 3600, scope: 'adsread adsedit' },
};
const CREDS = {
  clientId: 'reddit-client', clientSecret: 'reddit-secret', refreshToken: 'reddit-refresh',
  userAgent: 'desktop:dev.adport.local:v0.3.0 (by /u/adporttest)',
};

// Shapes mirror Reddit's official verified Ads API v3 Postman collection and
// ads-api.reddit.com v3 reference, fetched 2026-08-13.
const CAMPAIGN = {
  ad_account_id: 'a2_acme',
  configured_status: 'ACTIVE',
  effective_status: 'ACTIVE',
  funding_instrument_id: 'fi_1',
  goal_type: 'DAILY_SPEND',
  goal_value: 100_000_000,
  id: '579922433862993631',
  name: 'Prospecting',
  objective: 'TRAFFIC',
  is_campaign_budget_optimization: true,
  conversion_pixel_id: 't2_pixel',
};

describe('RedditAdsClient', () => {
  it('refreshes with Basic auth and sends an honest User-Agent and bearer token', async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_ROUTE,
      { match: (url) => url.endsWith('/api/v3/me/businesses'), reply: { data: [], pagination: {} } },
    ]);
    const client = new RedditAdsClient(CREDS, impl);
    await client.get('me/businesses');
    const token = calls[0]!;
    expect(token.init.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('reddit-client:reddit-secret').toString('base64')}`,
      'user-agent': CREDS.userAgent,
    });
    expect(String(token.init.body)).toContain('grant_type=refresh_token');
    const api = calls[1]!;
    expect(api.init.headers).toMatchObject({ authorization: 'Bearer reddit-at', 'user-agent': CREDS.userAgent });
  });

  it('follows official pagination next_url verbatim', async () => {
    const next = 'https://ads-api.reddit.com/api/v3/me/businesses?page.token=nextToken';
    const { impl, calls } = fakeFetch([
      TOKEN_ROUTE,
      { match: (url) => url.endsWith('/me/businesses'), reply: { data: [{ id: 'b1' }], pagination: { next_url: next } } },
      { match: (url) => url === next, reply: { data: [{ id: 'b2' }], pagination: {} } },
    ]);
    const rows = await new RedditAdsClient(CREDS, impl).getPaged<{ id: string }>('me/businesses');
    expect(rows.map((row) => row.id)).toEqual(['b1', 'b2']);
    expect(calls[2]!.url).toBe(next);
  });
});

describe('RedditAdsProvider reads', () => {
  it('discovers businesses, then returns their accessible ad accounts', async () => {
    const { impl } = fakeFetch([
      TOKEN_ROUTE,
      { match: (url) => url.includes('/me/businesses'), reply: { data: [{ id: 'business-1', name: 'Acme' }], pagination: {} } },
      {
        match: (url) => url.includes('/businesses/business-1/ad_accounts'),
        reply: { data: [{ id: 'a2_acme', type: 'MANAGED', currency: 'EUR', name: 'Acme Reddit', admin_approval: 'ADMIN' }], pagination: {} },
      },
    ]);
    const accounts = await new RedditAdsProvider(new RedditAdsClient(CREDS, impl)).listAccounts();
    expect(accounts).toEqual([{ provider: 'reddit', id: 'a2_acme', name: 'Acme Reddit', currency: 'EUR', status: 'ADMIN' }]);
  });

  it('normalizes report micros, purchase value cents, and campaign breakdowns', async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_ROUTE,
      {
        match: (url, _body, method) => url.includes('/ad_accounts/a2_acme/reports') && method === 'POST',
        reply: {
          data: { metrics: [{ campaign_id: 'campaign-1', impressions: 50_000, clicks: 100, spend: 12_500_000, conversion_purchase_clicks: 3, conversion_purchase_views: 1, conversion_purchase_total_value: 2500 }], metrics_updated_at: '2026-08-13T10:00:00Z' },
          pagination: {},
        },
      },
    ]);
    const provider = new RedditAdsProvider(new RedditAdsClient(CREDS, impl));
    const report = await provider.report({
      accountIds: ['a2_acme'], level: 'campaign',
      metrics: ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'roas'],
      dateRange: { start: '2026-08-01', end: '2026-08-07' },
    });
    expect(report.rows[0]).toMatchObject({
      entity: { level: 'campaign', id: 'campaign-1', name: 'campaign-1' },
      metrics: { spend: 12.5, impressions: 50_000, clicks: 100, conversions: 4, conversion_value: 25, roas: 2 },
    });
    const apiCall = calls.find((call) => call.url.includes('/reports'))!;
    const body = JSON.parse(String(apiCall.init.body));
    expect(body.data).toMatchObject({
      breakdowns: ['CAMPAIGN_ID'], starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-08-08T00:00:00Z', time_zone_id: 'UTC',
    });
    expect(body.data.fields).toContain('SPEND');
  });
});

describe('RedditAdsProvider guarded writes', () => {
  it('forces campaign creation to PAUSED and keeps API-native budgets in micros', async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_ROUTE,
      {
        match: (url, body, method) => url.includes('/ad_accounts/a2_acme/campaigns') && method === 'POST' && body.includes('PAUSED'),
        reply: { data: { ...CAMPAIGN, configured_status: 'PAUSED', id: 'new-campaign' } }, status: 201,
      },
    ]);
    const provider = new RedditAdsProvider(new RedditAdsClient(CREDS, impl));
    const op = {
      tool: 'reddit_create_campaign', provider: 'reddit', accountId: 'a2_acme', kind: 'create' as const,
      payload: { name: 'New campaign', objective: 'TRAFFIC', funding_instrument_id: 'fi_1', configured_status: 'ACTIVE', budget_micros: 50_000_000, conversion_pixel_id: 't2_pixel' },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.serverValidated).toBe(false);
    expect(preview.coercions).toEqual(['configured_status coerced to PAUSED by policy (paused_creation)']);
    expect(preview.budgetDeltas).toEqual([{ target: 'new campaign "New campaign" budget', toMicros: 50_000_000 }]);
    expect(calls).toHaveLength(0);

    const result = await provider.applyWrite(op, { forcePausedCreation: true });
    expect(result.resourceIds).toEqual(['new-campaign']);
    const body = JSON.parse(String(calls.find((call) => call.url.includes('/campaigns'))!.init.body));
    expect(body.data).toMatchObject({ configured_status: 'PAUSED', goal_value: 50_000_000, goal_type: 'DAILY_SPEND', is_campaign_budget_optimization: true });
  });

  it('looks up ownership and previews a CBO budget delta without unit conversion', async () => {
    const { impl } = fakeFetch([
      TOKEN_ROUTE,
      { match: (url, _body, method) => url.endsWith(`/campaigns/${CAMPAIGN.id}`) && method === 'GET', reply: { data: CAMPAIGN } },
    ]);
    const provider = new RedditAdsProvider(new RedditAdsClient(CREDS, impl));
    const preview = await provider.previewWrite({
      tool: 'reddit_set_budget', provider: 'reddit', accountId: 'a2_acme', kind: 'update',
      payload: { campaign_id: CAMPAIGN.id, budget_micros: 120_000_000 },
    }, { forcePausedCreation: true });
    expect(preview.budgetDeltas[0]).toEqual({
      target: 'campaign "Prospecting" budget', fromMicros: 100 * REDDIT_MICROS, toMicros: 120 * REDDIT_MICROS,
    });
  });

  it('maps audit pause actions and rejects untyped budget updates', async () => {
    const { impl } = fakeFetch([
      TOKEN_ROUTE,
      { match: (url, _body, method) => url.endsWith(`/campaigns/${CAMPAIGN.id}`) && method === 'GET', reply: { data: CAMPAIGN } },
    ]);
    const provider = new RedditAdsProvider(new RedditAdsClient(CREDS, impl));
    expect(provider.standardActions().pauseCampaign!('a2_acme', CAMPAIGN.id)).toEqual({
      tool: 'reddit_set_campaign_status',
      input: { account_id: 'a2_acme', campaign_id: CAMPAIGN.id, configured_status: 'PAUSED' },
    });
    await expect(provider.previewWrite({
      tool: 'reddit_api_update', provider: 'reddit', accountId: 'a2_acme', kind: 'update',
      payload: { path: `campaigns/${CAMPAIGN.id}`, body: { data: { goal_value: 999 } } },
    }, { forcePausedCreation: true })).rejects.toThrow('typed budget tool');
  });

  it('cannot smuggle a mutating POST through the read-only native tool', async () => {
    const provider = new RedditAdsProvider(new RedditAdsClient(CREDS, vi.fn() as unknown as typeof fetch));
    await expect(provider.apiRead({
      account_id: 'a2_acme', path: 'ad_accounts/a2_acme/campaigns', method: 'POST', body: { data: { name: 'unsafe' } },
    })).rejects.toThrow('read-only POST is limited');
  });
});
