import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, ga4ReportSchema, ga4RealtimeSchema, gscReportSchema, gscTools, nextPageArguments } from '@adport/core';
import { AnalyticsClient, Ga4Provider, SearchConsoleProvider } from '../src/index.js';

// Wire shapes checked against official GA Data/Admin v1beta and Search Console v3 docs, 2026-11-06.
// developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
// developers.google.com/webmaster-tools/v1/searchanalytics/query
const credentials = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' };
function setup(...results: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'access', expires_in: 3600 }));
  for (const result of results) fetchMock.mockResolvedValueOnce(result instanceof Response ? result : Response.json(result));
  return { fetchMock, client: new AnalyticsClient(credentials, fetchMock as typeof fetch) };
}
afterEach(() => vi.restoreAllMocks());
describe('read-only analytics providers', () => {
  it('discovers GA4 properties, follows account pages and caches the OAuth token', async () => {
    const { client, fetchMock } = setup({ accountSummaries: [{ displayName: 'Company', propertySummaries: [{ property: 'properties/123', displayName: 'Website' }] }], nextPageToken: 'next' }, { accountSummaries: [] });
    expect(await new Ga4Provider(client).listAccounts()).toEqual([{ provider: 'ga4', id: '123', name: 'Website — Company' }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token'); expect(init.redirect).toBe('error');
    expect(new URLSearchParams(init.body as URLSearchParams).get('refresh_token')).toBe('refresh');
    expect(fetchMock.mock.calls[1]![0]).toBe('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200');
    expect(fetchMock.mock.calls[2]![0]).toContain('pageToken=next');
    expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({ authorization: 'Bearer access' });
  });
  it('rejects repeated GA4 account pagination tokens', async () => {
    const { client } = setup({ nextPageToken: 'same' }, { nextPageToken: 'same' });
    await expect(new Ga4Provider(client).listAccounts()).rejects.toThrow(/repeated/);
  });
  it('sends the GA4 report body with native filter groups, dates and string pagination', async () => {
    const { client, fetchMock } = setup({ dimensionHeaders: [{ name: 'sessionSourceMedium' }], metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }, { name: 'totalRevenue', type: 'TYPE_CURRENCY' }],
      rows: [{ dimensionValues: [{ value: 'google / cpc' }], metricValues: [{ value: '9007199254740993' }, { value: '12.345' }] }], rowCount: 10,
      metadata: { currencyCode: 'EUR', timeZone: 'Europe/Berlin', subjectToThresholding: true } });
    const input = ga4ReportSchema.parse({ account_id: '123', start_date: '2026-11-01', end_date: '2026-11-05', dimensions: ['sessionSourceMedium'], metrics: ['sessions', 'totalRevenue'], offset: 2, limit: 1,
      filter_mode: 'or', dimension_filters: [{ field: 'country', value: 'Germany' }, { field: 'country', value: 'France' }] });
    const result = await new Ga4Provider(client).analyticsReport(input);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123:runReport');
    const body = JSON.parse(String(fetchMock.mock.calls[1]![1].body));
    expect(body).toMatchObject({ dateRanges: [{ startDate: '2026-11-01', endDate: '2026-11-05' }], dimensions: [{ name: 'sessionSourceMedium' }], metrics: [{ name: 'sessions' }, { name: 'totalRevenue' }], offset: '2', limit: '1',
      dimensionFilter: { orGroup: { expressions: [{ filter: { fieldName: 'country', stringFilter: { matchType: 'EXACT', value: 'Germany', caseSensitive: false } } }, { filter: { fieldName: 'country' } }] } } });
    expect(result.rows[0]!.metrics).toEqual({ sessions: '9007199254740993', totalRevenue: '12.345' });
    expect(result.next_offset).toBe(3); expect(result.notes.join(' ')).toContain('Privacy thresholds');
  });
  it('keeps realtime bodies free of unsupported historical dates and offsets', async () => {
    const { client, fetchMock } = setup({ rows: [], rowCount: 0 });
    await new Ga4Provider(client).analyticsReport(ga4RealtimeSchema.parse({ account_id: '123', metrics: ['activeUsers'] }), true);
    expect(fetchMock.mock.calls[1]![0]).toMatch(/:runRealtimeReport$/);
    const body = JSON.parse(String(fetchMock.mock.calls[1]![1].body));
    expect(body).not.toHaveProperty('dateRanges'); expect(body).not.toHaveProperty('offset');
    expect(ga4RealtimeSchema.safeParse({ account_id: '123', metrics: ['activeUsers'], offset: 1 }).success).toBe(false);
  });
  it('discovers verified Search Console domain and URL-prefix properties only', async () => {
    const { client } = setup({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://example.com/blog/', permissionLevel: 'siteRestrictedUser' }, { siteUrl: 'https://unverified.test/', permissionLevel: 'siteUnverifiedUser' }] });
    expect((await new SearchConsoleProvider(client).listAccounts()).map(a => a.id)).toEqual(['sc-domain:example.com', 'https://example.com/blog/']);
  });
  it('encodes the selected site as one path segment and preserves CTR/position units', async () => {
    const { client, fetchMock } = setup({ rows: [{ keys: ['example query'], clicks: 2, impressions: 10, ctr: 0.2, position: 3.5 }], responseAggregationType: 'byProperty' });
    const input = gscReportSchema.parse({ account_id: 'https://example.com/blog/', start_date: '2026-11-01', end_date: '2026-11-05', dimensions: ['query'], filters: [{ dimension: 'country', expression: 'DEU' }], limit: 1 });
    const result = await new SearchConsoleProvider(client).searchAnalytics(input);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2Fblog%2F/searchAnalytics/query');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ startDate: '2026-11-01', endDate: '2026-11-05', dimensions: ['query'], type: 'web', dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'country', operator: 'equals', expression: 'DEU' }] }], aggregationType: 'auto', rowLimit: 1, startRow: 0 });
    expect(result.rows[0]).toEqual({ dimensions: { query: 'example query' }, metrics: { clicks: 2, impressions: 10, ctr: 0.2, position: 3.5 } });
    expect(result.date_range.timezone).toBe('America/Los_Angeles'); expect(result.next_start_row).toBe(1);
    const tool = gscTools(new SearchConsoleProvider(client)).find(t => t.name === 'gsc_search_analytics')!;
    expect(nextPageArguments(tool, input, result)).toMatchObject({ account_id: input.account_id, start_row: 1, dimensions: ['query'] });
  });
  it('sends inspection to Google and rejects URLs outside the selected property before any request', async () => {
    const { client, fetchMock } = setup({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
    const provider = new SearchConsoleProvider(client), runtime = await createContext({ providerModules: [{ provider, tools: gscTools(provider) }] });
    await expect(runtime.registry.call('gsc_inspect_url', { account_id: 'sc-domain:example.com', inspection_url: 'https://example.com.attacker.test/' }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
    await runtime.registry.call('gsc_inspect_url', { account_id: 'sc-domain:example.com', inspection_url: 'https://blog.example.com/article' }, runtime.ctx);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ siteUrl: 'sc-domain:example.com', inspectionUrl: 'https://blog.example.com/article', languageCode: 'en-US' });
    expect(runtime.registry.list().filter(t => t.namespace === 'gsc').every(t => t.annotations.readOnly)).toBe(true);
  });
  it.each([401, 403, 429])('preserves upstream recovery status without leaking response data or retrying (%s)', async status => {
    const { client, fetchMock } = setup(Response.json({ error: { message: 'private property and user@example.com' } }, { status }));
    try { await new Ga4Provider(client).metadata('123'); throw Error('Expected rejection'); }
    catch (error) { expect(String(error)).not.toContain('user@example.com'); expect((error as { code: string }).code).toBe(status === 401 ? 'NOT_CONNECTED' : 'PROVIDER_ERROR'); }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('rejects undocumented endpoints and every mutation through the provider interface', async () => {
    const { client, fetchMock } = setup();
    await expect(client.request('admin', 'properties/123', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.request('search', 'sites/https%3A%2F%2Fevil.test/sitemaps', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.request('data', '../properties/123:runReport', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const op = { provider: 'ga4', accountId: '123', tool: 'made_up_write', kind: 'update' as const, payload: {} };
    for (const provider of [new Ga4Provider(client), new SearchConsoleProvider(client)]) {
      await expect(provider.previewWrite(op)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
      await expect(provider.applyWrite(op)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
