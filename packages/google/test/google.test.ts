import { describe, expect, it, vi } from 'vitest';
import { GoogleAdsRestClient, formatGoogleAdsError, normalizeCustomerId } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(routes: Array<{ match: (url: string, body: string) => boolean; reply: unknown; status?: number }>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    calls.push({ url: urlStr, init: init ?? {} });
    const route = routes.find((r) => r.match(urlStr, body));
    if (!route) throw new Error(`Unmatched fetch: ${urlStr}\n${body}`);
    return new Response(JSON.stringify(route.reply), { status: route.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const CREDS = {
  developerToken: 'dev-token',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token',
};

const tokenRoute = {
  match: (url: string) => url.includes('oauth2.googleapis.com/token'),
  reply: { access_token: 'access-token', expires_in: 3600 },
};

describe('normalizeCustomerId', () => {
  it('strips dashes and prefixes', () => {
    expect(normalizeCustomerId('123-456-7890')).toBe('1234567890');
    expect(normalizeCustomerId('customers/1234567890')).toBe('1234567890');
  });
  it('rejects garbage', () => {
    expect(() => normalizeCustomerId('abc')).toThrow(/not a valid/);
  });
});

describe('GoogleAdsRestClient', () => {
  it('refreshes the token once and sends required headers', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.includes(':listAccessibleCustomers'),
        reply: { resourceNames: ['customers/1234567890', 'customers/9876543210'] },
      },
    ]);
    const client = new GoogleAdsRestClient({ ...CREDS, loginCustomerId: '111-222-3333' }, 'v24', impl);
    expect(await client.listAccessibleCustomers()).toEqual(['1234567890', '9876543210']);
    await client.listAccessibleCustomers();

    const tokenCalls = calls.filter((c) => c.url.includes('oauth2'));
    expect(tokenCalls).toHaveLength(1); // cached
    const apiCall = calls.find((c) => c.url.includes(':listAccessibleCustomers'));
    const headers = apiCall?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer access-token');
    expect(headers['developer-token']).toBe('dev-token');
    expect(headers['login-customer-id']).toBe('1112223333');
  });

  it('paginates search until maxRows', async () => {
    let page = 0;
    const { impl } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.includes('googleAds:search'),
        get reply() {
          page += 1;
          return page === 1
            ? { results: [{ campaign: { id: '1' } }], nextPageToken: 'next' }
            : { results: [{ campaign: { id: '2' } }] };
        },
      },
    ]);
    const client = new GoogleAdsRestClient(CREDS, 'v24', impl);
    const rows = await client.search('1234567890', 'SELECT campaign.id FROM campaign');
    expect(rows).toHaveLength(2);
  });

  it('formats API errors with field paths and request id', () => {
    const message = formatGoogleAdsError(
      400,
      JSON.stringify({
        error: {
          message: 'Request contains an invalid argument.',
          details: [
            {
              requestId: 'req-123',
              errors: [
                {
                  message: 'Too short.',
                  location: { fieldPathElements: [{ fieldName: 'operations', index: 0 }, { fieldName: 'create' }] },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(message).toContain('at operations[0].create: Too short.');
    expect(message).toContain('req-123');
  });
});

describe('GoogleAdsProvider writes', () => {
  const campaignLookupRoute = {
    match: (url: string, body: string) => url.includes('googleAds:search') && body.includes('FROM campaign WHERE campaign.id'),
    reply: {
      results: [
        {
          campaign: { name: 'Brand', status: 'ENABLED' },
          campaignBudget: {
            resourceName: 'customers/1234567890/campaignBudgets/42',
            amountMicros: '10000000',
            explicitlyShared: false,
          },
        },
      ],
    },
  };

  it('previews a budget change with a server-side dry run and real deltas', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      campaignLookupRoute,
      { match: (url) => url.includes('campaignBudgets:mutate'), reply: { results: [] } },
    ]);
    const provider = new GoogleAdsProvider(new GoogleAdsRestClient(CREDS, 'v24', impl));
    const preview = await provider.previewWrite(
      {
        tool: 'google_set_budget',
        provider: 'google',
        accountId: '123-456-7890',
        kind: 'update',
        payload: { campaign_id: '77', daily_budget_micros: 12_000_000 },
      },
      { forcePausedCreation: true },
    );
    expect(preview.serverValidated).toBe(true);
    expect(preview.budgetDeltas[0]).toMatchObject({ fromMicros: 10_000_000, toMicros: 12_000_000 });

    const mutateCall = calls.find((c) => c.url.includes('campaignBudgets:mutate'));
    const body = JSON.parse(String(mutateCall?.init.body)) as {
      validateOnly: boolean;
      operations: Array<{ update: { amountMicros: string }; updateMask: string }>;
    };
    expect(body.validateOnly).toBe(true);
    expect(body.operations[0]?.updateMask).toBe('amount_micros');
    expect(body.operations[0]?.update.amountMicros).toBe('12000000');
  });

  it('applies with validateOnly=false', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      campaignLookupRoute,
      {
        match: (url) => url.includes('campaignBudgets:mutate'),
        reply: { results: [{ resourceName: 'customers/1234567890/campaignBudgets/42' }] },
      },
    ]);
    const provider = new GoogleAdsProvider(new GoogleAdsRestClient(CREDS, 'v24', impl));
    const result = await provider.applyWrite(
      {
        tool: 'google_set_budget',
        provider: 'google',
        accountId: '1234567890',
        kind: 'update',
        payload: { campaign_id: '77', daily_budget_micros: 12_000_000 },
      },
      { forcePausedCreation: true },
    );
    expect(result.resourceIds).toEqual(['customers/1234567890/campaignBudgets/42']);
    const body = JSON.parse(String(calls.find((c) => c.url.includes(':mutate'))?.init.body)) as { validateOnly: boolean };
    expect(body.validateOnly).toBe(false);
  });

  it('coerces created campaigns to PAUSED under the guard, atomically with the budget', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.includes('googleAds:mutate'),
        reply: { mutateOperationResponses: [] },
      },
    ]);
    const provider = new GoogleAdsProvider(new GoogleAdsRestClient(CREDS, 'v24', impl));
    const preview = await provider.previewWrite(
      {
        tool: 'google_create_campaign',
        provider: 'google',
        accountId: '1234567890',
        kind: 'create',
        payload: { name: 'New Campaign', daily_budget_micros: 5_000_000, status: 'ENABLED' },
      },
      { forcePausedCreation: true },
    );
    expect(preview.coercions).toHaveLength(1);
    const body = JSON.parse(String(calls.find((c) => c.url.includes('googleAds:mutate'))?.init.body)) as {
      mutateOperations: Array<Record<string, { create: Record<string, unknown> }>>;
    };
    expect(body.mutateOperations[0]?.campaignBudgetOperation?.create.explicitlyShared).toBe(false);
    expect(body.mutateOperations[1]?.campaignOperation?.create.status).toBe('PAUSED');
  });

  it('rejects an invalid RSA client-side before any API call', async () => {
    const { impl, calls } = fakeFetch([tokenRoute]);
    const provider = new GoogleAdsProvider(new GoogleAdsRestClient(CREDS, 'v24', impl));
    await expect(
      provider.previewWrite(
        {
          tool: 'google_create_responsive_search_ad',
          provider: 'google',
          accountId: '1234567890',
          kind: 'create',
          payload: {
            ad_group_id: '9',
            headlines: ['one', 'two'],
            descriptions: ['a'],
            final_urls: [],
          },
        },
        { forcePausedCreation: true },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls.filter((c) => c.url.includes(':mutate'))).toHaveLength(0);
  });
});

describe('GoogleAdsProvider report', () => {
  it('builds GAQL with date range and maps camelCase metrics', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url, body) => url.includes('googleAds:search') && body.includes('FROM campaign'),
        reply: {
          results: [
            {
              campaign: { id: '77', name: 'Brand', status: 'ENABLED' },
              metrics: { costMicros: '5000000', clicks: '100', impressions: '2000' },
            },
          ],
        },
      },
    ]);
    const provider = new GoogleAdsProvider(new GoogleAdsRestClient(CREDS, 'v24', impl));
    const report = await provider.report({
      accountIds: ['1234567890'],
      level: 'campaign',
      metrics: ['spend', 'clicks', 'ctr'],
      dateRange: { start: '2026-07-01', end: '2026-07-31' },
    });
    expect(report.rows[0]?.metrics).toEqual({ spend: 5, clicks: 100, ctr: 5 });
    const body = String(calls.find((c) => c.url.includes('googleAds:search'))?.init.body);
    expect(body).toContain("BETWEEN '2026-07-01' AND '2026-07-31'");
    expect(body).toContain('campaign.name');
  });
});
