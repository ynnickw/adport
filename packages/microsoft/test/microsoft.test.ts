import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { MicrosoftAdsClient, SANDBOX_DEVELOPER_TOKEN, formatMicrosoftError } from '../src/client.js';
import { parseCsv } from '../src/csv.js';
import { MicrosoftAdsProvider, UNITS_TO_MICROS } from '../src/provider.js';

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(
  routes: Array<{ match: (url: string, body: string) => boolean; reply: unknown | (() => Response); status?: number }>,
) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    const body = String(init?.body ?? '');
    calls.push({ url: urlStr, init: init ?? {} });
    const route = routes.find((r) => r.match(urlStr, body));
    if (!route) throw new Error(`Unmatched fetch: ${urlStr}\n${body}`);
    if (typeof route.reply === 'function') return (route.reply as () => Response)();
    return new Response(JSON.stringify(route.reply), { status: route.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const CREDS = {
  developerToken: 'dev-token-prod',
  clientId: 'client-uuid',
  refreshToken: 'refresh-1',
};

const tokenRoute = {
  match: (url: string) => url.includes('login.microsoftonline.com'),
  reply: { access_token: 'ms-access', expires_in: 3600, refresh_token: 'refresh-2' },
};

// Doc-faithful shapes from learn.microsoft.com (fetched 2026-08-07).
const getUserRoute = {
  match: (url: string) => url.includes('/CustomerManagement/v13/User/Query'),
  reply: { User: { Id: 501, CustomerId: 9001, UserName: 'yan' }, CustomerRoles: [{ AccountIds: [777], CustomerId: 9001, RoleId: 16 }] },
};

const searchAccountsRoute = {
  match: (url: string) => url.includes('/CustomerManagement/v13/Accounts/Search'),
  reply: {
    Accounts: [
      { Id: 777, Name: 'Acme Microsoft', Number: 'X12345', CurrencyCode: 'EUR', AccountLifeCycleStatus: 'Active', ParentCustomerId: 9001 },
    ],
  },
};

const campaignsRoute = {
  match: (url: string, body: string) => url.includes('/Campaigns/QueryByAccountId') && body.includes('"AccountId"'),
  reply: {
    Campaigns: [
      { Id: 8881, Name: 'Search - DE', Status: 'Active', CampaignType: 'Search', DailyBudget: 25.0, BudgetType: 'DailyBudgetStandard', BudgetId: null, TimeZone: 'BerlinBernBrusselsRomeStockholmVienna' },
    ],
  },
};

describe('MicrosoftAdsClient', () => {
  it('refreshes tokens, persists rotation, and sends the four REST headers', async () => {
    const rotated: string[] = [];
    const { impl, calls } = fakeFetch([tokenRoute, getUserRoute]);
    const client = new MicrosoftAdsClient(CREDS, async (t) => void rotated.push(t), impl);
    await client.request('customer', 'POST', 'User/Query', { UserId: null }, { customerId: '9001', customerAccountId: '777' });
    expect(rotated).toEqual(['refresh-2']);
    const apiCall = calls.find((c) => c.url.includes('User/Query'))!;
    const headers = apiCall.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ms-access');
    expect(headers.DeveloperToken).toBe('dev-token-prod');
    expect(headers.CustomerId).toBe('9001');
    expect(headers.CustomerAccountId).toBe('777');
  });

  it('uses sandbox hosts and the universal sandbox developer token', async () => {
    const { impl, calls } = fakeFetch([tokenRoute, { match: (url) => url.includes('sandbox'), reply: { User: { Id: 1 } } }]);
    const client = new MicrosoftAdsClient({ ...CREDS, sandbox: true }, undefined, impl);
    await client.request('customer', 'POST', 'User/Query', { UserId: null });
    const apiCall = calls.find((c) => c.url.includes('User/Query'))!;
    expect(apiCall.url).toContain('https://clientcenter.api.sandbox.bingads.microsoft.com/CustomerManagement/v13/');
    expect((apiCall.init.headers as Record<string, string>).DeveloperToken).toBe(SANDBOX_DEVELOPER_TOKEN);
  });

  it('formats fault objects with codes, hints, and TrackingId', () => {
    const message = formatMicrosoftError(
      401,
      JSON.stringify({
        TrackingId: 'track-1',
        Type: 'ApiFaultDetail',
        OperationErrors: [{ Code: 105, ErrorCode: 'InvalidCredentials', Message: 'Authentication failed.' }],
      }),
    );
    expect(message).toContain('105 InvalidCredentials');
    expect(message).toContain('sandbox vs production');
    expect(message).toContain('[TrackingId: track-1]');
  });
});

describe('parseCsv', () => {
  it('handles quoted fields with commas and escaped quotes', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });
});

describe('MicrosoftAdsProvider', () => {
  it('maps recommendation pauses to the guarded campaign status tool', () => {
    const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS));
    expect(provider.standardActions().pauseCampaign?.('777', '8881')).toEqual({
      tool: 'microsoft_set_campaign_status',
      input: { account_id: '777', campaign_id: '8881', status: 'Paused' },
    });
  });

  it('discovers accounts via GetUser + SearchAccounts', async () => {
    const { impl, calls } = fakeFetch([tokenRoute, getUserRoute, searchAccountsRoute]);
    const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS, undefined, impl));
    const accounts = await provider.listAccounts();
    expect(accounts).toEqual([
      { provider: 'microsoft', id: '777', name: 'Acme Microsoft', currency: 'EUR', status: 'Active' },
    ]);
    const searchCall = calls.find((c) => c.url.includes('Accounts/Search'))!;
    const body = JSON.parse(String(searchCall.init.body)) as { Predicates: Array<{ Field: string; Operator: string; Value: string }> };
    expect(body.Predicates).toEqual([{ Field: 'UserId', Operator: 'Equals', Value: '501' }]);
  });

  it('runs the async report flow: Submit → Poll → download → unzip → parse', async () => {
    const csv = 'CampaignId,CampaignName,CampaignStatus,Spend,Impressions,Clicks,Conversions,Revenue\n8881,"Search - DE",Active,42.50,9000,310,12,180.00\n';
    const zip = zipSync({ 'report.csv': new TextEncoder().encode(csv) });
    let polls = 0;
    const { impl, calls } = fakeFetch([
      tokenRoute,
      getUserRoute,
      searchAccountsRoute,
      { match: (url) => url.includes('/GenerateReport/Submit'), reply: { ReportRequestId: 'RR-1' } },
      {
        match: (url) => url.includes('/GenerateReport/Poll'),
        get reply() {
          polls += 1;
          return polls === 1
            ? { ReportRequestStatus: { Status: 'Pending', ReportDownloadUrl: null } }
            : { ReportRequestStatus: { Status: 'Success', ReportDownloadUrl: 'https://download.example/report.zip' } };
        },
      },
      { match: (url) => url.includes('download.example'), reply: () => new Response(zip.buffer.slice(0) as ArrayBuffer) },
    ]);
    const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS, undefined, impl), { pollIntervalMs: 1, pollMaxAttempts: 5 });
    const report = await provider.report({
      accountIds: ['777'],
      level: 'campaign',
      metrics: ['spend', 'clicks', 'conversions', 'conversion_value', 'roas'],
      dateRange: { start: '2026-07-01', end: '2026-07-31' },
    });
    const row = report.rows[0]!;
    expect(row.entity).toEqual({ level: 'campaign', id: '8881', name: 'Search - DE', status: 'Active' });
    expect(row.metrics).toEqual({ spend: 42.5, clicks: 310, conversions: 12, conversion_value: 180, roas: 4.24 });

    const submitBody = JSON.parse(String(calls.find((c) => c.url.includes('Submit'))!.init.body)) as {
      ReportRequest: { Type: string; Time: { CustomDateRangeStart: { Day: number; Month: number; Year: number } } };
    };
    expect(submitBody.ReportRequest.Type).toBe('CampaignPerformanceReportRequest');
    expect(submitBody.ReportRequest.Time.CustomDateRangeStart).toEqual({ Day: 1, Month: 7, Year: 2026 });
  });

  it('creates campaigns via POST with Paused default and surfaces PartialErrors', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      getUserRoute,
      searchAccountsRoute,
      {
        match: (url, body) => url.endsWith('/CampaignManagement/v13/Campaigns') && body.includes('"Campaigns"'),
        reply: { CampaignIds: [9992], PartialErrors: [] },
      },
    ]);
    const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS, undefined, impl));
    const op = {
      tool: 'microsoft_create_campaign',
      provider: 'microsoft',
      accountId: '777',
      kind: 'create' as const,
      payload: { name: 'New MS Campaign', daily_budget: 15 },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.serverValidated).toBe(false);
    expect(preview.budgetDeltas[0]!.toMicros).toBe(15 * UNITS_TO_MICROS);

    const result = await provider.applyWrite(op, { forcePausedCreation: true });
    expect(result.resourceIds).toEqual(['9992']);
    const addCall = calls.find((c) => c.url.endsWith('/Campaigns') && c.init.method === 'POST')!;
    const body = JSON.parse(String(addCall.init.body)) as { Campaigns: Array<Record<string, unknown>> };
    expect(body.Campaigns[0]!.Status).toBe('Paused');
    expect(body.Campaigns[0]!.BudgetType).toBe('DailyBudgetStandard');
  });

  it('updates budgets via PUT and refuses shared budgets', async () => {
    const sharedCampaigns = {
      Campaigns: [{ Id: 8882, Name: 'Shared Budget Campaign', Status: 'Active', DailyBudget: 30, BudgetId: 4242 }],
    };
    const { impl, calls } = fakeFetch([
      tokenRoute,
      getUserRoute,
      searchAccountsRoute,
      { match: (url, body) => url.includes('QueryByAccountId') && !body.includes('never'), reply: campaignsRoute.reply },
      { match: (url) => url.endsWith('/Campaigns'), reply: { PartialErrors: [] } },
    ]);
    const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS, undefined, impl));
    const preview = await provider.previewWrite(
      {
        tool: 'microsoft_set_budget',
        provider: 'microsoft',
        accountId: '777',
        kind: 'update',
        payload: { campaign_id: '8881', daily_budget: 30 },
      },
      { forcePausedCreation: true },
    );
    expect(preview.budgetDeltas[0]).toMatchObject({ fromMicros: 25 * UNITS_TO_MICROS, toMicros: 30 * UNITS_TO_MICROS });

    await provider.applyWrite(
      {
        tool: 'microsoft_set_budget',
        provider: 'microsoft',
        accountId: '777',
        kind: 'update',
        payload: { campaign_id: '8881', daily_budget: 30 },
      },
      { forcePausedCreation: true },
    );
    const putCall = calls.find((c) => c.url.endsWith('/Campaigns') && c.init.method === 'PUT')!;
    const body = JSON.parse(String(putCall.init.body)) as { Campaigns: Array<Record<string, unknown>> };
    expect(body.Campaigns[0]).toEqual({ Id: 8881, DailyBudget: 30 });

    // Shared budget → clear refusal.
    const { impl: impl2 } = fakeFetch([tokenRoute, getUserRoute, searchAccountsRoute, { match: (url) => url.includes('QueryByAccountId'), reply: sharedCampaigns }]);
    const provider2 = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS, undefined, impl2));
    await expect(
      provider2.previewWrite(
        {
          tool: 'microsoft_set_budget',
          provider: 'microsoft',
          accountId: '777',
          kind: 'update',
          payload: { campaign_id: '8882', daily_budget: 50 },
        },
        { forcePausedCreation: true },
      ),
    ).rejects.toThrow(/SHARED budget/);
  });

  it('calls documented v13 read operations with account headers', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute, getUserRoute, searchAccountsRoute,
      { match: (url) => url.includes('/AdGroups/QueryByCampaignId'), reply: { AdGroups: [] } },
    ]);
    const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS, undefined, impl));
    await provider.apiRead({ account_id: '777', service: 'campaign', path: 'AdGroups/QueryByCampaignId', body: { CampaignId: 8881 } });
    const call = calls.find((item) => item.url.includes('/AdGroups/QueryByCampaignId'))!;
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).CustomerAccountId).toBe('777');
  });

  it('guards generic creates, forces Paused, and checks budgets', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute, getUserRoute, searchAccountsRoute,
      { match: (url) => url.endsWith('/AdGroups'), reply: { AdGroupIds: [123], PartialErrors: [] } },
    ]);
    const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS, undefined, impl));
    const op = {
      tool: 'microsoft_api_create', provider: 'microsoft', accountId: '777', kind: 'create' as const,
      payload: { resource: 'AdGroups', body: { AccountId: 777, AdGroups: [{ Name: 'Native', Status: 'Active', DailyBudget: 12 }] } },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.coercions).toHaveLength(1);
    expect(preview.budgetDeltas).toEqual([{ target: 'body.AdGroups[0].DailyBudget', toMicros: 12_000_000 }]);
    await provider.applyWrite(op, { forcePausedCreation: true });
    const call = calls.find((item) => item.url.endsWith('/AdGroups'))!;
    const body = JSON.parse(String(call.init.body));
    expect(body.AdGroups[0].Status).toBe('Paused');
  });

  it('rejects cross-account reads and generic budget updates', async () => {
    const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS));
    await expect(provider.apiRead({
      account_id: '777', service: 'campaign', path: 'Campaigns/QueryByAccountId', body: { AccountId: 999 },
    })).rejects.toThrow('does not match selected account 777');
    await expect(provider.previewWrite({
      tool: 'microsoft_api_update', provider: 'microsoft', accountId: '777', kind: 'update',
      payload: { resource: 'Campaigns', body: { AccountId: 777, Campaigns: [{ Id: 1, DailyBudget: 99 }] } },
    }, { forcePausedCreation: true })).rejects.toThrow('budget updates require microsoft_set_budget');
  });

  it('uses DELETE only during generic delete apply', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute, getUserRoute, searchAccountsRoute,
      { match: (url) => url.endsWith('/Keywords'), reply: { PartialErrors: [] } },
    ]);
    const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient(CREDS, undefined, impl));
    const op = {
      tool: 'microsoft_api_delete', provider: 'microsoft', accountId: '777', kind: 'remove' as const,
      payload: { resource: 'Keywords', body: { AccountId: 777, AdGroupId: 55, KeywordIds: [66] } },
    };
    await provider.previewWrite(op, { forcePausedCreation: true });
    expect(calls.some((item) => item.init.method === 'DELETE')).toBe(false);
    await provider.applyWrite(op, { forcePausedCreation: true });
    expect(calls.some((item) => item.init.method === 'DELETE')).toBe(true);
  });
});
