import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// Official reporting-service definitions distinguish AdGroup Status from
// AdStatus, and use BidMatchType for keyword reports. Summary needs no TimePeriod.
function setup(csv?: string) {
  const calls: Array<{ path: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'download.example') return new Response(zipSync({ 'folder/': new Uint8Array(), 'folder/report.csv': new TextEncoder().encode(csv!) }));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test-token', expires_in: 3600 });
    const path = url.pathname.replace(/^.*\/v13\//, ''), body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body, init });
    const responses: Record<string, unknown> = {
      'User/Query': { User: { Id: '1' } }, 'Accounts/Search': { Accounts: [{ Id: '777', Name: 'Account', ParentCustomerId: '9001' }] },
      'GenerateReport/Submit': { ReportRequestId: 'report-1' }, 'GenerateReport/Poll': { ReportRequestStatus: { Status: 'Success', ReportDownloadUrl: csv === undefined ? null : 'https://download.example/report.zip' } },
    };
    return Response.json(responses[path]);
  });
  return { provider: new MicrosoftAdsProvider(new MicrosoftAdsClient({ clientId: 'test-client', developerToken: 'test-dev', refreshToken: 'test-refresh' }, undefined, fetcher as typeof fetch), { pollIntervalMs: 1 }), calls };
}

describe('Microsoft detailed reporting', () => {
  it.each([
    { level: 'ad_group' as const, type: 'AdGroupPerformanceReportRequest', header: 'AdGroupId,AdGroupName,Status', status: 'Status' },
    { level: 'ad' as const, type: 'AdPerformanceReportRequest', header: 'AdId,AdTitle,AdStatus', status: 'AdStatus' },
  ])('normalizes $level report identity and requests its exact native columns', async ({ level, type, header, status }) => {
    const { provider, calls } = setup(`\uFEFF${header},Spend,Impressions,Clicks,Conversions,Revenue\n20,Actual entity,Paused,10.5,1000,20,2,40\n`);
    const result = await provider.report({ accountIds: ['777'], level, metrics: ['spend', 'clicks', 'roas'], dateRange: 'last_7_days' });
    expect(result.rows[0]).toMatchObject({ entity: { level, id: '20', name: 'Actual entity', status: 'Paused' }, metrics: { spend: 10.5, clicks: 20, roas: 3.81 } });
    const request = calls.find(call => call.path === 'GenerateReport/Submit')!.body.ReportRequest as Record<string, unknown>;
    expect(request).toMatchObject({ Type: type, Aggregation: 'Summary', Scope: { AccountIds: ['777'] } });
    expect(request.Columns).toContain(status);
    if (level === 'ad_group') expect(request.Columns).not.toContain('AdGroupStatus');
    expect(calls.find(call => call.path === 'GenerateReport/Submit')!.init.headers).toMatchObject({ CustomerAccountId: '777', CustomerId: '9001' });
  });

  it('computes an account-only ROAS request from spend/revenue totals rather than averaging ratios or losing source metrics', async () => {
    const { provider } = setup('CampaignId,CampaignName,CampaignStatus,Spend,Impressions,Clicks,Conversions,Revenue\n10,One,Paused,10,1000,20,2,100\n11,Two,Paused,90,1000,20,2,0\n');
    const result = await provider.report({ accountIds: ['777'], level: 'account', metrics: ['roas'], dateRange: 'last_7_days' });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.metrics).toEqual({ roas: 1 });
  });

  it('keeps missing/suppressed conversion values unavailable and honors the row cap', async () => {
    const { provider } = setup('AdId,AdTitle,AdStatus,Spend,Impressions,Clicks,Conversions,Revenue\n20,Ad,Paused,10,100,5,--,\n21,Other,Paused,5,50,2,0,0\n');
    const result = await provider.report({ accountIds: ['777'], level: 'ad', metrics: ['spend', 'conversions', 'conversion_value', 'roas'], dateRange: 'last_7_days', limit: 1 });
    expect(result).toMatchObject({ truncated: true });
    expect(result.rows[0]?.metrics).toEqual({ spend: 10 });
  });

  it.each(['keyword', 'search_term'] as const)('returns native $0 strings and explicit truncation', async kind => {
    const { provider, calls } = setup('KeywordId,Keyword,SearchQuery,Spend,Conversions,Revenue\n40,adport,adport ads,1.2300,--,\n41,other,other ads,0.5000,0,0\n');
    const result = await provider.nativeReport({ account_id: '777', kind, date_range: { start: '2026-10-01', end: '2026-10-31' }, limit: 1 });
    expect(result).toMatchObject({ truncated: true, rows: [{ Spend: '1.2300', Conversions: '--', Revenue: '' }] });
    const request = calls.find(call => call.path === 'GenerateReport/Submit')!.body.ReportRequest as Record<string, unknown>;
    expect(request.Type).toBe(kind === 'keyword' ? 'KeywordPerformanceReportRequest' : 'SearchQueryPerformanceReportRequest');
    expect(request.Columns).toContain(kind === 'keyword' ? 'BidMatchType' : 'SearchQuery');
    expect(microsoftTools(provider).find(tool => tool.name === `microsoft_${kind}_report`)!.output!.safeParse(result).success).toBe(true);
  });

  it('returns an empty report when the service succeeds without a download URL', async () => {
    const { provider } = setup();
    await expect(provider.nativeReport({ account_id: '777', kind: 'keyword', date_range: 'last_7_days', limit: 10 })).resolves.toMatchObject({ rows: [], truncated: false });
  });
});
