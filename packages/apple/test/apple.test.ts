import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      { match: (url) => url.includes('/v1/acls'), reply: { result: { acls: [] }, error: null } },
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

  it('sends X-AP-Context adAccountId on account-scoped calls but not on /acls', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      { match: (url) => url.includes('/v1/'), reply: { result: [], pagination: null, error: null } },
    ]);
    const client = new AppleAdsClient(CREDS, impl);
    await client.request('GET', 'acls');
    await client.request('POST', 'campaigns/query', { adAccountId: '40669820', body: {} });
    const aclHeaders = calls[1]!.init.headers as Record<string, string>;
    const campaignHeaders = calls[2]!.init.headers as Record<string, string>;
    expect(aclHeaders['X-AP-Context']).toBeUndefined();
    expect(campaignHeaders['X-AP-Context']).toBe('adAccountId=40669820');
  });

  it('formats v1 errors with top-level and detailed codes', () => {
    const message = formatAppleError(
      400,
      JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Invalid request', details: [{ code: 'INVALID_BID', message: 'bidStrategy.bidAmount is invalid' }] } }),
    );
    expect(message).toContain('INVALID_REQUEST: Invalid request');
    expect(message).toContain('INVALID_BID: bidStrategy.bidAmount is invalid');
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

  it('lists ad accounts from the v1 ACL response', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.includes('/acls'),
        reply: {
          result: { acls: [{ adAccount: { id: 40669820, name: 'Trip Trek', orgId: 27154130 }, roles: ['ADMIN'] }] },
          error: null,
        },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const accounts = await provider.listAccounts();
    expect(accounts).toEqual([{ provider: 'apple', id: '40669820', name: 'Trip Trek', status: 'ADMIN' }]);
  });

  it('maps campaign reports: taps→clicks, totalInstalls→conversions, localSpend string→spend', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.includes('/reports/apps/campaigns/query'),
        reply: {
          result: {
            rows: [
                {
                  totalMetrics: {
                    impressions: 4510,
                    taps: 132,
                    ttr: 0.0293,
                    totalInstalls: 41,
                    localSpend: { amount: '95.50', currency: 'USD' },
                    tapInstallCPI: { amount: '2.33', currency: 'USD' },
                    tapInstallRate: 0.31,
                  },
                  metadata: { id: 542370642, name: 'TripTrek example campaign', status: 'ENABLED' },
                },
              ],
          },
          pagination: { offset: 0, pageSize: 200, totalCount: 1 },
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

    const body = JSON.parse(String(calls.find((c) => c.url.includes('/reports/apps/campaigns/query'))!.init.body)) as Record<string, unknown>;
    expect(body.timeRange).toEqual({ start: '2026-07-01', end: '2026-07-31', timeZone: 'UTC' });
    expect(body.pagination).toEqual({ offset: 0, pageSize: 200 });
    expect(body.options).toEqual({ includeRows: ['GRAND_TOTAL'] });
  });

  it('lists campaigns through POST /campaigns/query with v1 pagination', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/v1/campaigns/query'),
        reply: { result: [{ id: 42, name: 'Maps launch', status: 'PAUSED' }], pagination: { offset: 0, pageSize: 250, totalCount: 1 } },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    await expect(provider.listCampaigns('40669820', 250)).resolves.toEqual([
      { id: 42, name: 'Maps launch', status: 'PAUSED' },
    ]);
    const call = calls.find((item) => item.url.endsWith('/campaigns/query'))!;
    expect(call.init.method).toBe('POST');
    expect(JSON.parse(String(call.init.body))).toEqual({
      pagination: { offset: 0, pageSize: 250, fetchTotalCount: false },
    });
  });

  it('creates v1 campaigns with nested dailyBudget and targeting plus pause coercion', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/v1/campaigns'),
        reply: { result: { id: 886873328, name: 'Example', status: 'PAUSED' }, error: null },
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
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/v1/campaigns'))!.init.body)) as Record<string, unknown>;
    expect(body.dailyBudget).toEqual({ value: { amount: '250', currency: 'USD' } });
    expect(body.status).toBe('PAUSED');
    expect(body.promotedObjectType).toBe('APPSTORE_APP');
    expect(body.promotedObjectId).toBe('535500008');
    expect(body.targeting).toEqual({
      countryOrRegion: { include: ['US', 'CA'] },
      supplySource: { include: ['APPSTORE_SEARCH_RESULTS'] },
    });
  });

  it('updates budgets via a partial v1 PUT and reports the delta', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/campaigns/542370642'),
        reply: {
          result: { id: 542370642, name: 'TripTrek example campaign', status: 'ENABLED', dailyBudget: { value: { amount: '500', currency: 'USD' } } },
          error: null,
        },
      },
      {
        match: (url) => url.endsWith('/campaigns/542370642'),
        reply: { result: { id: 542370642 }, error: null },
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
      dailyBudget: { value: { amount: '600', currency: 'USD' } },
    });
  });

  it('allows documented v1 query reads but rejects mutating POST paths', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      {
        match: (url, body) => url.includes('/campaigns/query') && body.includes('pagination'),
        reply: { result: [], pagination: null, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    await expect(
      provider.apiRead({ account_id: '40669820', method: 'POST', path: 'campaigns/query', body: { pagination: {} } }),
    ).resolves.toMatchObject({ result: [] });
    await expect(
      provider.apiRead({ account_id: '40669820', method: 'POST', path: 'campaigns', body: {} }),
    ).rejects.toThrow('unsupported read path');
  });

  it('guards generic creates, coerces nested statuses, and reports Money budgets', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/v1/adgroups'),
        reply: { result: { id: 1234 }, pagination: null, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const op = {
      tool: 'apple_api_create',
      provider: 'apple',
      accountId: '40669820',
      kind: 'create' as const,
      payload: {
        path: 'adgroups',
        body: { campaignId: 542370642, name: 'Exact', status: 'ENABLED', defaultBidAmount: { amount: '2.5', currency: 'USD' } },
      },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.coercions).toHaveLength(1);
    expect(preview.budgetDeltas).toEqual([{ target: 'body.defaultBidAmount', toMicros: 2_500_000 }]);
    await provider.applyWrite(op, { forcePausedCreation: true });
    const body = JSON.parse(String(calls.find((call) => call.url.endsWith('/adgroups'))!.init.body));
    expect(body.status).toBe('PAUSED');
  });

  it('rejects monetary generic updates and permits guarded deletes', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/v1/negative-keywords/99'),
        reply: { result: null, pagination: null, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    await expect(
      provider.previewWrite(
        {
          tool: 'apple_api_update', provider: 'apple', accountId: '40669820', kind: 'update',
          payload: { path: 'campaigns/542370642', body: { dailyBudget: { value: { amount: '999', currency: 'USD' } } } },
        },
        { forcePausedCreation: true },
      ),
    ).rejects.toThrow('monetary updates require a typed budget or bid tool');

    const remove = {
      tool: 'apple_api_delete', provider: 'apple', accountId: '40669820', kind: 'remove' as const,
      payload: { path: 'negative-keywords/99' },
    };
    const preview = await provider.previewWrite(remove, { forcePausedCreation: true });
    expect(preview.changes).toEqual(['- DELETE /negative-keywords/99']);
    await provider.applyWrite(remove, { forcePausedCreation: true });
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(true);
  });

  it('uses POST for guarded v1 bulk updates without bypassing monetary checks', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/v1/keywords/bulk-update'),
        reply: { result: { items: [{ result: { id: 77 } }] }, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const op = {
      tool: 'apple_api_update', provider: 'apple', accountId: '40669820', kind: 'update' as const,
      payload: { path: 'keywords/bulk-update', body: { items: [{ correlationId: 'a', data: { id: 77, status: 'PAUSED' } }] } },
    };
    await provider.applyWrite(op, { forcePausedCreation: true });
    expect(calls.find((call) => call.url.endsWith('/keywords/bulk-update'))!.init.method).toBe('POST');
  });

  it('re-queries and policy-reports recommendation Money before applying it', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/recommendations/daily-budgets/query'),
        reply: {
          result: [{
            id: 'rec-1', campaignId: 42, campaignName: 'Example',
            dailyBudget: { amount: '50', currency: 'USD' },
            suggestedDailyBudgetAmount: { amount: '75', currency: 'USD' },
          }],
          error: null,
        },
      },
      {
        match: (url) => url.endsWith('/recommendations/daily-budgets/apply'),
        reply: { result: [{ id: 'rec-1' }], error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const op = {
      tool: 'apple_apply_recommendations', provider: 'apple', accountId: '40669820', kind: 'update' as const,
      payload: {
        category: 'daily_budget', promoted_object_id: '535500008', promoted_object_type: 'APPSTORE_APP',
        recommendations: [{ id: 'rec-1' }],
      },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.budgetDeltas).toEqual([{
      target: 'daily_budget recommendation rec-1 (Example)',
      fromMicros: 50_000_000,
      toMicros: 75_000_000,
    }]);
    await provider.applyWrite(op, { forcePausedCreation: true });
    const apply = calls.find((call) => call.url.endsWith('/recommendations/daily-budgets/apply'))!;
    expect(JSON.parse(String(apply.init.body))).toEqual([{
      id: 'rec-1', promotedObjectId: '535500008', promotedObjectType: 'APPSTORE_APP',
      appliedDailyBudget: { amount: '75', currency: 'USD' },
    }]);
  });

  it('binds asset uploads to a SHA-256 and sends documented multipart fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adport-apple-v1-'));
    const filePath = join(directory, 'creative.png');
    const bytes = Buffer.from('fake-png-for-wire-test');
    await writeFile(filePath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      const { impl, calls } = fakeFetch([
        tokenRoute,
        { match: (url) => url.endsWith('/v1/assets/upload'), reply: { result: { id: 'asset-1' }, error: null } },
      ]);
      const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
      const op = {
        tool: 'apple_upload_asset', provider: 'apple', accountId: '40669820', kind: 'create' as const,
        payload: {
          file_path: filePath, expected_sha256: sha256,
          promoted_object_id: 'brand-1', promoted_object_type: 'BUSINESS_BRAND',
        },
      };
      await expect(provider.previewWrite(op, { forcePausedCreation: true })).resolves.toMatchObject({
        changes: [`+ asset sha256=${sha256} promotedObject=brand-1`],
      });
      await provider.applyWrite(op, { forcePausedCreation: true });
      const upload = calls.find((call) => call.url.endsWith('/assets/upload'))!;
      const form = upload.init.body as FormData;
      expect(form.get('promotedObjectId')).toBe('brand-1');
      expect(form.get('promotedObjectType')).toBe('BUSINESS_BRAND');
      expect((form.get('file') as File).name).toBe('creative.png');
      expect((upload.init.headers as Record<string, string>)['content-type']).toBeUndefined();

      await expect(provider.previewWrite({
        ...op,
        payload: { ...op.payload, expected_sha256: '0'.repeat(64) },
      }, { forcePausedCreation: true })).rejects.toThrow('SHA-256 mismatch');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('policy-checks typed keyword bids and shared-budget values', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      {
        match: (url) => url.endsWith('/keywords/77'),
        reply: { result: { id: 77, bid: { amount: '1.25', currency: 'EUR' } }, error: null },
      },
      {
        match: (url) => url.endsWith('/shared-budgets/88'),
        reply: { result: { id: 88, name: 'Maps', value: { amount: '500', currency: 'EUR' } }, error: null },
      },
    ]);
    const provider = new AppleAdsProvider(new AppleAdsClient(CREDS, impl));
    const bid = {
      tool: 'apple_set_bid', provider: 'apple', accountId: '40669820', kind: 'update' as const,
      payload: { resource_type: 'keyword', resource_id: '77', amount: 2 },
    };
    expect((await provider.previewWrite(bid, { forcePausedCreation: true })).budgetDeltas).toEqual([{
      target: 'keyword 77 bid', fromMicros: 1_250_000, toMicros: 2_000_000,
    }]);
    await provider.applyWrite(bid, { forcePausedCreation: true });
    const bidPut = calls.find((call) => call.url.endsWith('/keywords/77') && call.init.method === 'PUT')!;
    expect(JSON.parse(String(bidPut.init.body))).toEqual({ bid: { amount: '2', currency: 'EUR' } });

    const shared = {
      tool: 'apple_set_shared_budget', provider: 'apple', accountId: '40669820', kind: 'update' as const,
      payload: { shared_budget_id: '88', amount: 650 },
    };
    expect((await provider.previewWrite(shared, { forcePausedCreation: true })).budgetDeltas).toEqual([{
      target: 'shared budget 88', fromMicros: 500_000_000, toMicros: 650_000_000,
    }]);
    await provider.applyWrite(shared, { forcePausedCreation: true });
    const budgetPut = calls.find((call) => call.url.endsWith('/shared-budgets/88') && call.init.method === 'PUT')!;
    expect(JSON.parse(String(budgetPut.init.body))).toEqual({ value: { amount: '650', currency: 'EUR' } });

    await expect(provider.previewWrite({
      tool: 'apple_api_update', provider: 'apple', accountId: '40669820', kind: 'update',
      payload: { path: 'shared-budgets/88', body: { value: { amount: '999', currency: 'EUR' } } },
    }, { forcePausedCreation: true })).rejects.toThrow('monetary updates require a typed budget or bid tool');
  });
});
