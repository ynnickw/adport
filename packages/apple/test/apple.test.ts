import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AppleAdsClient, formatAppleError } from '../src/client.js';
import { createClientSecret } from '../src/jwt.js';
import { AppleAdsProvider, UNITS_TO_MICROS } from '../src/provider.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const CREDS = {
  clientId: 'SEARCHADS.11111111-2222-3333-4444-555555555555',
  teamId: 'SEARCHADS.11111111-2222-3333-4444-555555555555',
  keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  privateKeyPem: PEM,
};

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(
  routes: Array<{ match: (url: string, body: string) => boolean; reply: unknown; status?: number }>,
) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    const body = String(init?.body ?? '');
    calls.push({ url: urlStr, init: init ?? {} });
    const route = routes.find((r) => r.match(urlStr, body));
    if (!route) throw new Error(`Unmatched fetch: ${urlStr}\n${body}`);
    return new Response(JSON.stringify(route.reply), { status: route.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

// Doc-faithful token response (implementing-oauth doc, verified 2026-08-07).
const tokenRoute = {
  match: (url: string) => url.includes('appleid.apple.com/auth/oauth2/token'),
  reply: { access_token: 'eyJhbGci-test', token_type: 'Bearer', expires_in: 3600, scope: 'searchadsorg' },
};

describe('createClientSecret (ES256 JWT)', () => {
  it('produces a JWT with the documented header and claims', () => {
    const secret = createClientSecret(CREDS, new Date('2026-08-07T00:00:00Z'));
    const [headerB64, payloadB64, signature] = secret.split('.');
    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString()) as Record<string, string>;
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString()) as Record<string, unknown>;
    expect(header).toEqual({ alg: 'ES256', kid: CREDS.keyId });
    expect(payload.iss).toBe(CREDS.teamId);
    expect(payload.sub).toBe(CREDS.clientId);
    expect(payload.aud).toBe('https://appleid.apple.com');
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
    // ES256 raw r||s signature is 64 bytes.
    expect(Buffer.from(signature!, 'base64url')).toHaveLength(64);
  });
});

describe('AppleAdsClient', () => {
  it('requests tokens with client_credentials + searchadsorg and caches them', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      { match: (url) => url.includes('/api/v5/acls'), reply: { data: [], pagination: null, error: null } },
    ]);
    const client = new AppleAdsClient(CREDS, impl);
    await client.request('GET', 'acls');
    await client.request('GET', 'acls');
    const tokenCalls = calls.filter((c) => c.url.includes('appleid.apple.com'));
    expect(tokenCalls).toHaveLength(1);
    const body = new URLSearchParams(String(tokenCalls[0]!.init.body));
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toBe('searchadsorg');
    expect(body.get('client_secret')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('sends X-AP-Context orgId on org-scoped calls but not on /acls', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      { match: (url) => url.includes('/api/v5/'), reply: { data: [], pagination: null, error: null } },
    ]);
    const client = new AppleAdsClient(CREDS, impl);
    await client.request('GET', 'acls');
    await client.request('GET', 'campaigns?limit=100&offset=0', { orgId: '40669820' });
    const aclHeaders = calls[1]!.init.headers as Record<string, string>;
    const campaignHeaders = calls[2]!.init.headers as Record<string, string>;
    expect(aclHeaders['X-AP-Context']).toBeUndefined();
    expect(campaignHeaders['X-AP-Context']).toBe('orgId=40669820');
  });

  it('formats v5 errors with messageCode and field', () => {
    const message = formatAppleError(
      400,
      JSON.stringify({ error: { errors: [{ messageCode: 'INVALID_REQUEST', message: 'Invalid request', field: 'bidAmount' }] } }),
    );
    expect(message).toContain('INVALID_REQUEST: Invalid request (field: bidAmount)');
  });
});

describe('AppleAdsProvider', () => {
  it('maps the recommendation pause action to the guarded status tool', () => {
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, vi.fn() as unknown as typeof fetch));
    expect(provider.standardActions().pauseCampaign?.('40669820', '542370642')).toEqual({
      tool: 'apple_set_campaign_status',
      input: { account_id: '40669820', campaign_id: '542370642', status: 'PAUSED' },
    });
  });

  it('lists orgs from /acls as accounts', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.includes('/acls'),
        reply: {
          data: [
            { orgName: 'Trip Trek', orgId: 40669820, currency: 'USD', timeZone: 'America/Los_Angeles', paymentModel: 'PAYG', roleNames: ['Admin'], parentOrgId: 27154130 },
          ],
          pagination: null,
          error: null,
        },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const accounts = await provider.listAccounts();
    expect(accounts).toEqual([{ provider: 'apple', id: '40669820', name: 'Trip Trek', currency: 'USD', status: 'Admin' }]);
  });

  it('maps campaign reports: taps→clicks, totalInstalls→conversions, localSpend string→spend', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.includes('/reports/campaigns'),
        reply: {
          data: {
            reportingDataResponse: {
              row: [
                {
                  other: false,
                  total: {
                    impressions: 4510,
                    taps: 132,
                    ttr: 0.0293,
                    totalInstalls: 41,
                    localSpend: { amount: '95.50', currency: 'USD' },
                    tapInstallCPI: { amount: '2.33', currency: 'USD' },
                    tapInstallRate: 0.31,
                  },
                  metadata: { campaignId: 542370642, campaignName: 'TripTrek example campaign', campaignStatus: 'ENABLED' },
                },
              ],
            },
          },
          pagination: { totalResults: 1, startIndex: 1, itemsPerPage: 10 },
          error: null,
        },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const report = await provider.report({
      accountIds: ['40669820'],
      level: 'campaign',
      metrics: ['spend', 'clicks', 'conversions', 'cpa', 'ctr'],
      dateRange: { start: '2026-07-01', end: '2026-07-31' },
    });
    const row = report.rows[0]!;
    expect(row.entity).toEqual({ level: 'campaign', id: '542370642', name: 'TripTrek example campaign', status: 'ENABLED' });
    expect(row.metrics).toEqual({ spend: 95.5, clicks: 132, conversions: 41, cpa: 2.33, ctr: 2.93 });

    const body = JSON.parse(String(calls.find((c) => c.url.includes('/reports/campaigns'))!.init.body)) as Record<string, unknown>;
    expect(body.startTime).toBe('2026-07-01');
    expect(body.returnRowTotals).toBe(true);
    expect(body.selector).toEqual({
      orderBy: [{ field: 'campaignId', sortOrder: 'ASCENDING' }],
      pagination: { offset: 0, limit: 200 },
    });
  });

  it('creates campaigns with dailyBudgetAmount Money strings and pause coercion (no budgetAmount — removed in 5.6)', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/api/v5/campaigns'),
        reply: { data: { id: 886873328, name: 'Example', status: 'PAUSED' }, pagination: null, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const op = {
      tool: 'apple_create_campaign',
      provider: 'apple',
      accountId: '40669820',
      kind: 'create' as const,
      payload: { name: 'Example', adam_id: 535500008, countries_or_regions: ['US', 'CA'], daily_budget: 250, currency: 'USD', status: 'ENABLED' },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.serverValidated).toBe(false);
    expect(preview.coercions).toHaveLength(1);
    expect(preview.budgetDeltas[0]!.toMicros).toBe(250 * UNITS_TO_MICROS);

    const result = await provider.applyWrite(op, { forcePausedCreation: true });
    expect(result.resourceIds).toEqual(['886873328']);
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/api/v5/campaigns'))!.init.body)) as Record<string, unknown>;
    expect(body.dailyBudgetAmount).toEqual({ amount: '250', currency: 'USD' });
    expect(body.status).toBe('PAUSED');
    expect(body.supplySources).toEqual(['APPSTORE_SEARCH_RESULTS']);
    expect(body).not.toHaveProperty('budgetAmount');
  });

  it('updates budgets via PUT with the {campaign: {...}} wrapper and reports the delta', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url, body) => url.includes('/campaigns/find') && body.includes('EQUALS'),
        reply: {
          data: [{ id: 542370642, name: 'TripTrek example campaign', status: 'ENABLED', dailyBudgetAmount: { amount: '500', currency: 'USD' } }],
          pagination: { totalResults: 1, startIndex: 1, itemsPerPage: 1 },
          error: null,
        },
      },
      {
        match: (url) => url.includes('/campaigns/542370642'),
        reply: { data: { id: 542370642 }, pagination: null, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const op = {
      tool: 'apple_set_budget',
      provider: 'apple',
      accountId: '40669820',
      kind: 'update' as const,
      payload: { campaign_id: '542370642', daily_budget: 600 },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.budgetDeltas[0]).toMatchObject({ fromMicros: 500 * UNITS_TO_MICROS, toMicros: 600 * UNITS_TO_MICROS });

    await provider.applyWrite(op, { forcePausedCreation: true });
    const putCall = calls.find((c) => c.url.includes('/campaigns/542370642') && c.init.method === 'PUT')!;
    expect(JSON.parse(String(putCall.init.body))).toEqual({
      campaign: { dailyBudgetAmount: { amount: '600', currency: 'USD' } },
    });
  });

  it('allows documented selector reads but rejects mutating POST paths', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      {
        match: (url, body) => url.includes('/campaigns/find') && body.includes('selector'),
        reply: { data: [], pagination: null, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    await expect(
      provider.apiRead({ account_id: '40669820', method: 'POST', path: 'campaigns/find', body: { selector: {} } }),
    ).resolves.toMatchObject({ data: [] });
    await expect(
      provider.apiRead({ account_id: '40669820', method: 'POST', path: 'campaigns', body: {} }),
    ).rejects.toThrow('POST is read-only here only');
  });

  it('guards generic creates, coerces nested statuses, and reports Money budgets', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/api/v5/campaigns/542370642/adgroups'),
        reply: { data: { id: 1234 }, pagination: null, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const op = {
      tool: 'apple_api_create',
      provider: 'apple',
      accountId: '40669820',
      kind: 'create' as const,
      payload: {
        path: 'campaigns/542370642/adgroups',
        body: { adGroup: { name: 'Exact', status: 'ENABLED', defaultBidAmount: { amount: '2.5', currency: 'USD' } } },
      },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.coercions).toHaveLength(1);
    expect(preview.budgetDeltas).toEqual([{ target: 'body.adGroup.defaultBidAmount', toMicros: 2_500_000 }]);
    await provider.applyWrite(op, { forcePausedCreation: true });
    const body = JSON.parse(String(calls.find((call) => call.url.endsWith('/adgroups'))!.init.body));
    expect(body.adGroup.status).toBe('PAUSED');
  });

  it('rejects monetary generic updates and permits guarded deletes', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/api/v5/campaigns/542370642/negativekeywords/99'),
        reply: { data: null, pagination: null, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    await expect(
      provider.previewWrite(
        {
          tool: 'apple_api_update', provider: 'apple', accountId: '40669820', kind: 'update',
          payload: { path: 'campaigns/542370642', body: { dailyBudgetAmount: { amount: '999', currency: 'USD' } } },
        },
        { forcePausedCreation: true },
      ),
    ).rejects.toThrow('monetary updates require a typed budget or bid tool');

    const remove = {
      tool: 'apple_api_delete', provider: 'apple', accountId: '40669820', kind: 'remove' as const,
      payload: { path: 'campaigns/542370642/negativekeywords/99' },
    };
    const preview = await provider.previewWrite(remove, { forcePausedCreation: true });
    expect(preview.changes).toEqual(['- DELETE /campaigns/542370642/negativekeywords/99']);
    await provider.applyWrite(remove, { forcePausedCreation: true });
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(true);
  });
});
