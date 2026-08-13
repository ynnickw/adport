import { describe, expect, it, vi } from 'vitest';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider, UNITS_TO_MICROS } from '../src/provider.js';

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

const CREDS = { accessToken: 'tt-access-token', appId: 'app-1', secret: 'secret-1' };
const APP = { appId: 'app-1', secret: 'secret-1' };

// Envelope + payload shapes below mirror the official Business API v1.3 docs
// (business-api.tiktok.com portal, fetched 2026-08-07), including string metric
// values and errors as HTTP 200 with non-zero code.

const advertiserGetReply = {
  message: 'OK',
  code: 0,
  data: { list: [{ advertiser_id: '7000000001', advertiser_name: 'Acme TikTok' }] },
  request_id: '202003100820230101890492231E063EE3',
};

const advertiserInfoReply = {
  code: 0,
  message: 'OK',
  request_id: 'req-1',
  data: {
    list: [
      {
        advertiser_id: '7000000001',
        name: 'Acme TikTok',
        currency: 'EUR',
        status: 'STATUS_ENABLE',
        timezone: 'Etc/GMT+8',
      },
    ],
  },
};

const campaignGetReply = {
  code: 0,
  message: 'OK',
  request_id: 'req-2',
  data: {
    list: [
      {
        campaign_id: '1700000000000001',
        campaign_name: 'Prospecting DE',
        operation_status: 'ENABLE',
        secondary_status: 'CAMPAIGN_STATUS_ENABLE',
        budget: 100.0,
        budget_mode: 'BUDGET_MODE_DAY',
        objective_type: 'TRAFFIC',
        campaign_type: 'REGULAR_CAMPAIGN',
      },
    ],
    page_info: { page: 1, page_size: 10, total_page: 1, total_number: 1 },
  },
};

describe('TikTokClient', () => {
  it('sends the Access-Token header, keeps the trailing slash, and JSON-encodes array params', async () => {
    const { impl, calls } = fakeFetch([{ match: (url) => url.includes('/advertiser/info/'), reply: advertiserInfoReply }]);
    const client = new TikTokClient(CREDS, impl);
    await client.get('advertiser/info', { advertiser_ids: ['7000000001'], fields: ['name', 'currency'] });
    const call = calls[0]!;
    expect(call.url).toContain('https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?');
    expect(decodeURIComponent(call.url)).toContain('advertiser_ids=["7000000001"]');
    expect((call.init.headers as Record<string, string>)['Access-Token']).toBe('tt-access-token');
  });

  it('uses the sandbox base URL when sandbox is set', async () => {
    const { impl, calls } = fakeFetch([{ match: () => true, reply: { code: 0, message: 'OK', data: {} } }]);
    const client = new TikTokClient({ ...CREDS, sandbox: true }, impl);
    await client.get('campaign/get', { advertiser_id: '1' });
    expect(calls[0]!.url).toContain('https://sandbox-ads.tiktok.com/open_api/v1.3/campaign/get/');
  });

  it('treats HTTP 200 with non-zero code as an error, with hints for 40105', async () => {
    const { impl } = fakeFetch([
      {
        match: () => true,
        reply: { code: 40105, message: 'Access token is incorrect or has been revoked.', request_id: 'rq', data: {} },
      },
    ]);
    const client = new TikTokClient(CREDS, impl);
    await expect(client.get('campaign/get', {})).rejects.toThrow(/40105.*adport connect tiktok/s);
  });
});

describe('TikTokAdsProvider reads', () => {
  it('lists accounts by combining oauth2/advertiser/get with advertiser/info', async () => {
    const { impl } = fakeFetch([
      { match: (url) => url.includes('/oauth2/advertiser/get/'), reply: advertiserGetReply },
      { match: (url) => url.includes('/advertiser/info/'), reply: advertiserInfoReply },
    ]);
    const provider = new TikTokAdsProvider(new TikTokClient(CREDS, impl), APP);
    const accounts = await provider.listAccounts();
    expect(accounts).toEqual([
      { provider: 'tiktok', id: '7000000001', name: 'Acme TikTok', currency: 'EUR', status: 'ENABLE' },
    ]);
  });

  it('normalizes string metrics from report/integrated including purchase-value mapping', async () => {
    const { impl, calls } = fakeFetch([
      {
        match: (url) => url.includes('/report/integrated/get/'),
        reply: {
          code: 0,
          message: 'OK',
          request_id: 'req-3',
          data: {
            page_info: { page: 1, page_size: 200, total_page: 1, total_number: 1 },
            list: [
              {
                dimensions: { campaign_id: '1700000000000001' },
                metrics: {
                  campaign_name: 'Prospecting DE',
                  spend: '14.68',
                  impressions: '1079',
                  clicks: '52',
                  conversion: '4',
                  complete_payment_roas: '2.1',
                  total_complete_payment_rate: '30.83',
                },
              },
            ],
          },
        },
      },
    ]);
    const provider = new TikTokAdsProvider(new TikTokClient(CREDS, impl), APP);
    const report = await provider.report({
      accountIds: ['7000000001'],
      level: 'campaign',
      metrics: ['spend', 'clicks', 'conversions', 'conversion_value', 'roas'],
      dateRange: { start: '2026-07-29', end: '2026-08-04' },
    });
    const row = report.rows[0]!;
    expect(row.entity).toEqual({ level: 'campaign', id: '1700000000000001', name: 'Prospecting DE' });
    expect(row.metrics).toEqual({ spend: 14.68, clicks: 52, conversions: 4, conversion_value: 30.83, roas: 2.1 });
    const url = decodeURIComponent(calls[0]!.url);
    expect(url).toContain('data_level=AUCTION_CAMPAIGN');
    expect(url).toContain('start_date=2026-07-29');
    expect(url).toContain('"campaign_name"');
  });

  it('calls arbitrary v1.3 GET endpoints with forced advertiser scope', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/adgroup/get/'), reply: { code: 0, message: 'OK', data: { list: [] } } },
    ]);
    const provider = new TikTokAdsProvider(new TikTokClient(CREDS, impl), APP);
    await provider.apiRead({ account_id: '7000000001', path: 'adgroup/get', params: { page_size: 10 } });
    expect(decodeURIComponent(calls[0]!.url)).toContain('advertiser_id=7000000001');
  });
});

describe('TikTokAdsProvider writes', () => {
  it('coerces created campaigns to DISABLE under the pause guard (client-side preview)', async () => {
    const { impl, calls } = fakeFetch([
      {
        match: (url, body) => url.includes('/campaign/create/') && body.includes('DISABLE'),
        reply: { code: 0, message: 'OK', request_id: 'r', data: { campaign_id: '1700000000000009', operation_status: 'DISABLE' } },
      },
    ]);
    const provider = new TikTokAdsProvider(new TikTokClient(CREDS, impl), APP);
    const op = {
      tool: 'tiktok_create_campaign',
      provider: 'tiktok',
      accountId: '7000000001',
      kind: 'create' as const,
      payload: { campaign_name: 'New', objective_type: 'TRAFFIC', budget_mode: 'BUDGET_MODE_DAY', budget: 50 },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.serverValidated).toBe(false); // no dry run in the Marketing API
    expect(preview.coercions).toHaveLength(1);
    expect(calls).toHaveLength(0); // preview made no API call for create

    const result = await provider.applyWrite(op, { forcePausedCreation: true });
    expect(result.resourceIds).toEqual(['1700000000000009']);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.operation_status).toBe('DISABLE');
    expect(body.budget).toBe(50);
  });

  it('previews budget changes with a live lookup and converts units to micros', async () => {
    const { impl } = fakeFetch([
      { match: (url) => url.includes('/campaign/get/'), reply: campaignGetReply },
      { match: (url) => url.includes('/campaign/update/'), reply: { code: 0, message: 'OK', data: {} } },
    ]);
    const provider = new TikTokAdsProvider(new TikTokClient(CREDS, impl), APP);
    const preview = await provider.previewWrite(
      {
        tool: 'tiktok_set_budget',
        provider: 'tiktok',
        accountId: '7000000001',
        kind: 'update',
        payload: { campaign_id: '1700000000000001', budget: 120 },
      },
      { forcePausedCreation: true },
    );
    expect(preview.budgetDeltas[0]).toEqual({
      target: 'campaign "Prospecting DE" daily budget',
      fromMicros: 100 * UNITS_TO_MICROS,
      toMicros: 120 * UNITS_TO_MICROS,
    });
  });

  it('updates status via campaign/status/update with string campaign_ids', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/campaign/get/'), reply: campaignGetReply },
      {
        match: (url) => url.includes('/campaign/status/update/'),
        reply: { code: 0, message: 'OK', request_id: 'r', data: { status: 'DISABLE', campaign_ids: ['1700000000000001'] } },
      },
    ]);
    const provider = new TikTokAdsProvider(new TikTokClient(CREDS, impl), APP);
    const result = await provider.applyWrite(
      {
        tool: 'tiktok_set_campaign_status',
        provider: 'tiktok',
        accountId: '7000000001',
        kind: 'update',
        payload: { campaign_ids: ['1700000000000001'], operation_status: 'DISABLE' },
      },
      { forcePausedCreation: true },
    );
    expect(result.resourceIds).toEqual(['1700000000000001']);
    const statusCall = calls.find((c) => c.url.includes('/campaign/status/update/'))!;
    const body = JSON.parse(String(statusCall.init.body)) as Record<string, unknown>;
    expect(body.operation_status).toBe('DISABLE');
    expect(body.campaign_ids).toEqual(['1700000000000001']);
  });

  it('exposes pauseCampaign as a standard action for the audit harness', () => {
    const provider = new TikTokAdsProvider(new TikTokClient(CREDS), APP);
    const action = provider.standardActions().pauseCampaign!('7000000001', '17');
    expect(action.tool).toBe('tiktok_set_campaign_status');
    expect(action.input).toEqual({ account_id: '7000000001', campaign_ids: ['17'], operation_status: 'DISABLE' });
  });

  it('guards generic creates, forces advertiser/status, and checks budgets', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/campaign/create/'), reply: { code: 0, message: 'OK', data: { campaign_id: '9' } } },
    ]);
    const provider = new TikTokAdsProvider(new TikTokClient(CREDS, impl), APP);
    const op = {
      tool: 'tiktok_api_create', provider: 'tiktok', accountId: '7000000001', kind: 'create' as const,
      payload: { path: 'campaign/create', body: { campaign_name: 'Native', operation_status: 'ENABLE', budget: 75 } },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.coercions).toHaveLength(1);
    expect(preview.budgetDeltas).toEqual([{ target: 'body.budget', toMicros: 75_000_000 }]);
    expect(calls).toHaveLength(0);
    await provider.applyWrite(op, { forcePausedCreation: true });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ advertiser_id: '7000000001', operation_status: 'DISABLE' });
  });

  it('rejects mismatched generic mutation kinds and budget updates', async () => {
    const provider = new TikTokAdsProvider(new TikTokClient(CREDS, vi.fn() as unknown as typeof fetch), APP);
    await expect(provider.previewWrite({
      tool: 'tiktok_api_update', provider: 'tiktok', accountId: '7000000001', kind: 'update',
      payload: { path: 'campaign/create', body: { name: 'wrong endpoint' } },
    }, { forcePausedCreation: true })).rejects.toThrow('requires an endpoint ending in /update');
    await expect(provider.previewWrite({
      tool: 'tiktok_api_update', provider: 'tiktok', accountId: '7000000001', kind: 'update',
      payload: { path: 'adgroup/update', body: { budget: 999 } },
    }, { forcePausedCreation: true })).rejects.toThrow('budget updates require a typed budget tool');
  });
});
