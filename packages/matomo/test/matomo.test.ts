import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, matomoReportSchema, nextPageArguments, CredentialStore } from '@adport/core';
import { MatomoClient, MatomoProvider, matomoTools, normalizeMatomoUrl, matomoCredentialsFromData, createMatomoModule, resolveMatomoCredentials, matomoPeriodStarts } from '../src/index.js';

// Wire shapes checked against the Matomo Reporting API docs, 2026-11-27:
// developer.matomo.org/api-reference/reporting-api (POST token_auth, format=JSON, filter_limit/filter_offset, flat)
// developer.matomo.org/api-reference/reporting-api-metadata (API.getReportMetadata, API.getProcessedReport, metricTypes)
// developer.matomo.org/api-reference/reporting-api-segmentation (segment syntax)
// Shapes (localized period keys, format_metrics=0 values, error envelopes) checked against a public demo instance on 2026-11-27;
// all values below are synthetic.
const base = 'https://example.matomo.cloud';
function setup(...results: unknown[]) {
  const fetchMock = vi.fn();
  for (const result of results) fetchMock.mockResolvedValueOnce(result instanceof Response ? result : Response.json(result));
  const client = new MatomoClient({ url: base, tokenAuth: 'test-token' }, fetchMock as typeof fetch);
  return { fetchMock, client, provider: new MatomoProvider(client) };
}
const form = (fetchMock: ReturnType<typeof vi.fn>, index: number) => new URLSearchParams(String(fetchMock.mock.calls[index]![1].body));
const site = { idsite: '1', name: 'Example', main_url: 'https://www.example.com', timezone: 'Europe/Paris', currency: 'EUR', ecommerce: '1', sitesearch: '0', type: 'website', ts_created: '2024-01-01 00:00:00', creator_login: 'admin' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Matomo provider', () => {
  it('posts every call to <base>/index.php with the token in the form body only', async () => {
    const { fetchMock, provider } = setup([site, { ...site, idsite: 7, name: 'Shop', currency: 'USD', timezone: 'UTC' }]);
    expect(await provider.listAccounts()).toEqual([
      { provider: 'matomo', id: '1', name: 'Example', currency: 'EUR', timezone: 'Europe/Paris' },
      { provider: 'matomo', id: '7', name: 'Shop', currency: 'USD', timezone: 'UTC' },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.matomo.cloud/index.php'); expect(url).not.toContain('test-token');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(form(fetchMock, 0))).toEqual({ module: 'API', method: 'SitesManager.getSitesWithAtLeastViewAccess', format: 'JSON', token_auth: 'test-token' });
  });

  it('rejects invalid site IDs returned by Matomo', async () => {
    const { provider } = setup([{ ...site, idsite: 'abc' }]);
    await expect(provider.listAccounts()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it.each([
    ['https://example.matomo.cloud', 'https://example.matomo.cloud'],
    ['https://example.matomo.cloud/', 'https://example.matomo.cloud'],
    ['https://analytics.example.com/matomo/', 'https://analytics.example.com/matomo'],
    ['https://analytics.example.com/matomo/index.php', 'https://analytics.example.com/matomo'],
    ['  https://analytics.example.com:8443/matomo//  ', 'https://analytics.example.com:8443/matomo'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeMatomoUrl(input)).toBe(expected);
    expect(new MatomoClient({ url: input, tokenAuth: 'test-token' }).baseUrl).toBe(expected);
  });
  it.each(['http://analytics.example.com', 'https://user:pass@analytics.example.com', 'https://analytics.example.com/?module=API',
    'https://analytics.example.com/matomo#x', 'https://analytics.example.com/?', 'ftp://analytics.example.com', 'analytics.example.com', ''])('rejects %j', input => {
    expect(() => normalizeMatomoUrl(input)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('loads stored credentials before the environment pair', async () => {
    vi.stubEnv('MATOMO_URL', 'https://analytics.example.com/matomo'); vi.stubEnv('MATOMO_TOKEN_AUTH', 'test-token');
    expect(matomoCredentialsFromData({ url: 'https://example.matomo.cloud/index.php', token_auth: 'stored' })).toEqual({ url: base, tokenAuth: 'stored' });
    expect(matomoCredentialsFromData({ url: base })).toBeUndefined();
    const empty = { get: vi.fn().mockResolvedValue(undefined) } as unknown as CredentialStore;
    expect(await resolveMatomoCredentials(empty)).toEqual({ url: 'https://analytics.example.com/matomo', tokenAuth: 'test-token' });
    const stored = { get: vi.fn().mockResolvedValue({ provider: 'matomo', source: 'byo', data: { url: 'https://example.matomo.cloud/', token_auth: 'stored-token' } }) } as unknown as CredentialStore;
    expect(await resolveMatomoCredentials(stored)).toEqual({ url: base, tokenAuth: 'stored-token' });
    const module = await createMatomoModule(empty);
    expect(module?.provider.id).toBe('matomo');
    expect(module?.tools.map(t => t.name)).toEqual(['matomo_site', 'matomo_report_metadata', 'matomo_report', 'matomo_goals', 'matomo_segments']);
    vi.stubEnv('MATOMO_TOKEN_AUTH', '');
    expect(await createMatomoModule(empty)).toBeUndefined();
  });

  it('treats unusable stored or environment credentials as not connected instead of throwing', async () => {
    const empty = { get: vi.fn().mockResolvedValue(undefined) } as unknown as CredentialStore;
    vi.stubEnv('MATOMO_TOKEN_AUTH', 'test-token');
    for (const url of ['http://matomo.internal', 'matomo.internal', 'https://user:pass@analytics.example.com']) {
      vi.stubEnv('MATOMO_URL', url);
      await expect(createMatomoModule(empty)).resolves.toBeUndefined();
    }
    const badStore = { get: vi.fn().mockResolvedValue({ provider: 'matomo', source: 'byo', data: { url: 'http://matomo.internal', token_auth: 'stored-token' } }) } as unknown as CredentialStore;
    await expect(createMatomoModule(badStore)).resolves.toBeUndefined();
    vi.stubEnv('MATOMO_URL', 'https://analytics.example.com');
    expect(await resolveMatomoCredentials(badStore)).toEqual({ url: 'https://analytics.example.com', tokenAuth: 'test-token' });
  });

  it('refuses methods outside the read allowlist and reserved parameters before any request', async () => {
    const { client, fetchMock } = setup();
    for (const method of ['UsersManager.getUsers', 'Live.getLastVisitsDetails', 'SitesManager.addSite', 'API.getBulkRequest', 'Goals.addGoal']) {
      await expect(client.call(method)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(client.call('API.getMatomoVersion', { token_auth: 'other' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.call('API.getMatomoVersion', { method: 'UsersManager.deleteUser' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses visitor-level modules and malformed report identifiers before any request', async () => {
    const { provider, fetchMock } = setup();
    const runtime = await createContext({ providerModules: [{ provider, tools: matomoTools(provider) }] });
    const range = { account_id: '1', start_date: '2026-11-01', end_date: '2026-11-07' };
    for (const args of [{ module: 'Live', action: 'getLastVisitsDetails' }, { module: 'UserId', action: 'getUsers' }, { module: 'Referrers', action: 'get&method=x' },
      { module: 'referrers', action: 'get' }, { module: 'API', action: 'Get' }, { module: 'LIVE', action: 'getLastVisitsDetails' }, { module: 'USERID', action: 'getUsers' },
      { module: 'MultiSites', action: 'getAll' }, { module: 'MULTISITES', action: 'getAll' }]) {
      await expect(runtime.registry.call('matomo_report', { ...range, ...args }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(runtime.registry.call('matomo_report', { ...range, account_id: '0', module: 'VisitsSummary', action: 'get' }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(runtime.registry.call('matomo_site', { account_id: '1;2' }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(matomoReportSchema.safeParse({ ...range, module: 'VisitsSummary', action: 'get', period: 'day', start_date: '2026-01-01', end_date: '2026-06-01' }).success).toBe(false);
    for (const segment of ['userId==person', 'deviceType==smartphone;visitorId==0123456789abcdef', 'countryCode==fr,visitIp==192.0.2.1', 'USERID==x', ' fingerprint==abc',
      'visitId==5', 'userId%3D%3Dperson', '%75serId==person', '%2575serId%253D%253Dx', 'deviceType==tablet;%76isitorId==abc%ZZ']) {
      await expect(runtime.registry.call('matomo_report', { ...range, module: 'VisitsSummary', action: 'get', segment }, runtime.ctx), segment).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(matomoReportSchema.safeParse({ ...range, module: 'VisitsSummary', action: 'get', segment: 'pageUrl=@userId;visitCount>=2' }).success).toBe(true);
    expect(matomoReportSchema.safeParse({ ...range, module: 'Actions', action: 'getPageUrls', id_goal: 2 }).success).toBe(false);
    expect(matomoReportSchema.safeParse({ ...range, module: 'Referrers', action: 'getReferrerType', id_goal: 'ecommerceOrder' }).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.registry.list().filter(t => t.namespace === 'matomo').every(t => t.annotations.readOnly)).toBe(true);
  });

  it('sends a range report with segment, flat and pagination and normalizes rows', async () => {
    const report = {
      website: 'Example', prettyDate: 'Nov 1 – Nov 7, 2026',
      metadata: { name: 'Page URLs', module: 'Actions', action: 'getPageUrls', dimension: 'Page URL', metricTypes: { nb_hits: 'number', revenue: 'money', bounce_rate: 'percent' } },
      columns: { label: 'Page URL', nb_hits: 'Pageviews', bounce_rate: 'Bounce rate' },
      reportData: [{ label: '/pricing', nb_hits: 12, bounce_rate: 0.45, idsubdatatable: 3, url: 'https://www.example.com/pricing', goals: { 'idgoal=1': {} } }, { label: '/blog', nb_hits: 3, bounce_rate: 0.1 }, { label: '/more', nb_hits: 1 }],
      reportMetadata: [{}, {}], reportTotal: { nb_hits: 15 },
    };
    const { provider, fetchMock } = setup(report, site);
    const input = matomoReportSchema.parse({ account_id: '1', module: 'Actions', action: 'getPageUrls', start_date: '2026-11-01', end_date: '2026-11-07',
      segment: 'deviceType==smartphone;countryCode==fr', limit: 2, offset: 4, filter_sort_column: 'nb_hits', filter_sort_order: 'desc' });
    const result = await provider.processedReport(input);
    expect(Object.fromEntries(form(fetchMock, 0))).toEqual({ module: 'API', method: 'API.getProcessedReport', format: 'JSON', token_auth: 'test-token',
      idSite: '1', apiModule: 'Actions', apiAction: 'getPageUrls', period: 'range', date: '2026-11-01,2026-11-07', filter_limit: '3', filter_offset: '4',
      hideMetricsDoc: '1', showTimer: '0', format_metrics: '0', segment: 'deviceType==smartphone;countryCode==fr', flat: '1', filter_sort_column: 'nb_hits', filter_sort_order: 'desc' });
    expect(Object.fromEntries(form(fetchMock, 1))).toMatchObject({ method: 'SitesManager.getSiteFromId', idSite: '1' });
    expect(result.rows).toEqual([
      { dimensions: { label: '/pricing' }, metrics: { nb_hits: 12, bounce_rate: 0.45 } },
      { dimensions: { label: '/blog' }, metrics: { nb_hits: 3, bounce_rate: 0.1 } },
    ]);
    expect(result).toMatchObject({ provider: 'matomo', account_id: '1', report: { module: 'Actions', action: 'getPageUrls', name: 'Page URLs', dimension: 'Page URL' },
      totals: { nb_hits: 15 }, metric_labels: { nb_hits: 'Pageviews', bounce_rate: 'Bounce rate' }, metric_types: { revenue: 'money' },
      row_count: 2, offset: 4, limit: 2, next_offset: 6, truncated: true, date_range: { start: '2026-11-01', end: '2026-11-07', timezone: 'Europe/Paris' }, currency: 'EUR' });
    expect(result.notes.join(' ')).toMatch(/time zone.*currency.*fractions.*seconds/);
    const tool = matomoTools(provider).find(t => t.name === 'matomo_report')!;
    expect(nextPageArguments(tool, input, result)).toMatchObject({ account_id: '1', module: 'Actions', offset: 6, segment: input.segment });
  });

  it('uses period=day for one date, omits flat outside Actions and reads a single-row report without a next page', async () => {
    const { provider, fetchMock } = setup({ metadata: { name: 'Visits Summary' }, columns: { nb_visits: 'Visits' }, reportData: { nb_visits: 40, bounce_rate: 0.5, avg_time_on_site: 95 }, reportTotal: [] }, site);
    const result = await provider.processedReport(matomoReportSchema.parse({ account_id: '1', module: 'VisitsSummary', action: 'get', start_date: '2026-11-05', end_date: '2026-11-05', limit: 1 }));
    const body = form(fetchMock, 0);
    expect(body.get('period')).toBe('day'); expect(body.get('date')).toBe('2026-11-05'); expect(body.has('flat')).toBe(false); expect(body.has('segment')).toBe(false);
    expect(result.rows).toEqual([{ dimensions: {}, metrics: { nb_visits: 40, bounce_rate: 0.5, avg_time_on_site: 95 } }]);
    expect(result).not.toHaveProperty('next_offset'); expect(result).not.toHaveProperty('truncated');
  });

  it('rejects settings for the wrong site and retries the read', async () => {
    const { provider } = setup({ ...site, idsite: '2' }, site);
    await expect(provider.site('1')).rejects.toThrow(/different site/);
    await expect(provider.site('1')).resolves.toMatchObject({ id: '1' });
  });

  it('sends id_goal only with Goals reports', async () => {
    const { provider, fetchMock } = setup({ metadata: { name: 'Goal Signup' }, reportData: { nb_conversions: 7, revenue: 70.5, conversion_rate: 0.0125 } }, site);
    const result = await provider.processedReport(matomoReportSchema.parse({ account_id: '1', module: 'Goals', action: 'get', start_date: '2026-11-01', end_date: '2026-11-07', id_goal: 2 }));
    expect(form(fetchMock, 0).get('idGoal')).toBe('2'); expect(form(fetchMock, 0).get('apiModule')).toBe('Goals');
    expect(result.rows).toEqual([{ dimensions: {}, metrics: { nb_conversions: 7, revenue: 70.5, conversion_rate: 0.0125 } }]);
  });

  it('derives ISO period start dates for localized per-period keys and caches site settings', async () => {
    // Matomo keys multi-period data by localized labels (thin spaces around the dash in week labels).
    const week1 = 'week October 26\u2009–\u2009November 1, 2026', week2 = 'week November 2\u2009–\u20098, 2026';
    const { provider, fetchMock } = setup(
      { metadata: { name: 'Channel Type' }, columns: { label: 'Channel Type', nb_visits: 'Visits' }, reportData: { [week1]: [{ label: 'Search Engines', nb_visits: 5 }, { label: 'Websites', nb_visits: 1 }], [week2]: [] } },
      site,
      { metadata: { name: 'Channel Type' }, reportData: { [week1]: [{ label: 'Websites', nb_visits: 1 }], [week2]: [] } },
    );
    const input = matomoReportSchema.parse({ account_id: '1', module: 'Referrers', action: 'getReferrerType', start_date: '2026-10-29', end_date: '2026-11-03', period: 'week', limit: 1 });
    const result = await provider.processedReport(input);
    expect(form(fetchMock, 0).get('period')).toBe('week'); expect(form(fetchMock, 0).get('date')).toBe('2026-10-29,2026-11-03');
    expect(result.rows).toEqual([{ dimensions: { date: '2026-10-26', period_label: week1, label: 'Search Engines' }, metrics: { nb_visits: 5 } }]);
    expect(result.next_offset).toBe(1); expect(result.notes.join(' ')).toContain('per week');
    const last = await provider.processedReport({ ...input, offset: 1 });
    expect(last.rows).toHaveLength(1);
    expect(last.next_offset).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps single-row per-period reports unpaged and falls back to period_label on a period count mismatch', async () => {
    const { provider } = setup(
      { reportData: { 'Sunday, November 1, 2026': { nb_visits: 4 }, 'Monday, November 2, 2026': { nb_visits: 6 } } }, site,
      { reportData: { 'November 2026': { nb_visits: 9 } } },
    );
    const days = await provider.processedReport(matomoReportSchema.parse({ account_id: '1', module: 'VisitsSummary', action: 'get', start_date: '2026-11-01', end_date: '2026-11-02', period: 'day', limit: 1 }));
    expect(days.rows).toEqual([
      { dimensions: { date: '2026-11-01', period_label: 'Sunday, November 1, 2026' }, metrics: { nb_visits: 4 } },
      { dimensions: { date: '2026-11-02', period_label: 'Monday, November 2, 2026' }, metrics: { nb_visits: 6 } },
    ]);
    expect(days).not.toHaveProperty('next_offset');
    const months = await provider.processedReport(matomoReportSchema.parse({ account_id: '1', module: 'VisitsSummary', action: 'get', start_date: '2026-10-15', end_date: '2026-11-02', period: 'month' }));
    expect(months.rows).toEqual([{ dimensions: { period_label: 'November 2026' }, metrics: { nb_visits: 9 } }]);
    expect(months.notes.join(' ')).toContain('period_label only');
  });

  it.each([
    ['day', '2026-12-30', '2027-01-02', ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']],
    ['week', '2026-11-01', '2026-11-10', ['2026-10-26', '2026-11-02', '2026-11-09']],
    ['week', '2026-11-02', '2026-11-02', ['2026-11-02']],
    ['month', '2026-01-31', '2026-03-01', ['2026-01-01', '2026-02-01', '2026-03-01']],
    ['year', '2025-06-15', '2026-02-01', ['2025-01-01', '2026-01-01']],
  ] as const)('computes %s period starts for %s..%s', (period, start, end, expected) => {
    expect(matomoPeriodStarts(period, start, end)).toEqual(expected);
  });

  it('trims report metadata, hides visitor-level reports and filters by module', async () => {
    const { provider, fetchMock } = setup([
      { category: 'Referrers', subcategory: 'Campaigns', name: 'Campaigns', module: 'Referrers', action: 'getCampaigns', dimension: 'Campaign', metrics: { nb_visits: 'Visits' }, processedMetrics: { bounce_rate: 'Bounce rate' }, metricsGoal: { nb_conversions: 'Conversions' }, metricsDocumentation: { nb_visits: 'long text' }, imageGraphUrl: 'index.php?x' },
      { category: 'Visitors', name: 'Visits Log', module: 'Live', action: 'getLastVisitsDetails', metrics: {} },
      { category: 'Referrers', name: 'All Websites', module: 'MultiSites', action: 'getAll', metrics: {} },
      { category: 'Referrers', name: 'Odd case', module: 'LIVE', action: 'getLastVisitsDetails', metrics: {} },
      { category: 'Goals', name: 'Goal A', module: 'Goals', action: 'get', metrics: {}, parameters: { idGoal: '1' } },
    ]);
    const result = await provider.reportMetadata({ account_id: '1', module: 'Referrers' });
    expect(Object.fromEntries(form(fetchMock, 0))).toMatchObject({ method: 'API.getReportMetadata', idSites: '1', hideMetricsDoc: '1' });
    expect(result.reports).toEqual([{ module: 'Referrers', action: 'getCampaigns', name: 'Campaigns', category: 'Referrers', subcategory: 'Campaigns', dimension: 'Campaign',
      metrics: { nb_visits: 'Visits' }, processed_metrics: { bounce_rate: 'Bounce rate' }, has_goal_metrics: true }]);
  });

  it('reads site settings, goals and segments without creator logins', async () => {
    const { provider, fetchMock } = setup(site,
      { 1: { idsite: '1', idgoal: '1', name: 'Signup', description: '', match_attribute: 'url', pattern: '/thanks', pattern_type: 'contains', revenue: '10', allow_multiple: '0', case_sensitive: '0' } },
      [{ idsegment: '4', name: 'Mobile', definition: 'deviceType==smartphone', login: 'person@example.com', enable_only_idsite: '0', auto_archive: '1' },
       { idsegment: '5', name: 'Private visitor', definition: 'visitorId==fixture' }]);
    expect(await provider.site('1')).toEqual({ id: '1', name: 'Example', main_url: 'https://www.example.com', timezone: 'Europe/Paris', currency: 'EUR', ecommerce: true, site_search: false, type: 'website', created: '2024-01-01 00:00:00' });
    expect((await provider.goals('1')).goals).toEqual([{ id: '1', name: 'Signup', description: undefined, match_attribute: 'url', pattern: '/thanks', pattern_type: 'contains', revenue: '10', allow_multiple: false, case_sensitive: false }]);
    const segments = await provider.segments('1');
    expect(segments.segments).toEqual([{ id: '4', name: 'Mobile', definition: 'deviceType==smartphone', all_sites: true, auto_archive: true }]);
    expect(JSON.stringify(segments)).not.toContain('person@example.com');
    expect(form(fetchMock, 2).get('method')).toBe('SegmentEditor.getAll');
  });

  it.each([
    ["You can't access this resource as it requires 'view' access for the website id = 1.", 'PROVIDER_ERROR', 'access_denied'],
    ['Unable to authenticate with the provided token. It is either invalid, expired or provided as a GET parameter.', 'NOT_CONNECTED', 'auth'],
    ['token_auth is not valid for user@example.com', 'NOT_CONNECTED', 'auth'],
    ['The segment condition foo==test-token is not valid.', 'PROVIDER_ERROR', 'segment'],
    ['API returned an error: You do not have enough permission to access the segment userId at Segment.php:250', 'PROVIDER_ERROR', 'segment'],
    ['Requested report Login.getTrend for Website id=1 not found in the list of available reports.', 'PROVIDER_ERROR', 'report_not_found'],
    ['You do not have enough permission to access the segment Login sessions.', 'PROVIDER_ERROR', 'segment'],
    ['Requested report Foo.bar for Website id=1 not found in the list of available reports.', 'PROVIDER_ERROR', 'report_not_found'],
  ])('maps Matomo error envelopes without leaking the message or token (%s)', async (message, code, reason) => {
    const { client } = setup({ result: 'error', message });
    try { await client.call('API.getProcessedReport', { idSite: '1' }); throw Error('Expected rejection'); }
    catch (error) {
      const serialized = JSON.stringify(error) + String(error);
      expect(serialized).not.toContain('user@example.com'); expect(serialized).not.toContain('test-token'); expect(serialized).not.toContain('Foo.bar');
      expect(error).toMatchObject({ code, details: { reason } });
    }
  });

  it.each([
    [new Response('<html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'PROVIDER_ERROR'],
    [new Response('test-token denied', { status: 401 }), 'NOT_CONNECTED'],
    [new Response('<html>Forbidden test-token</html>', { status: 403 }), 'PROVIDER_ERROR'],
    [new Response('bad gateway', { status: 502 }), 'PROVIDER_ERROR'],
  ])('maps non-JSON and HTTP failures without echoing the body (%#)', async (response, code) => {
    const { client } = setup(response);
    const error = await client.call('API.getMatomoVersion').then(() => undefined, (e: unknown) => e as Error);
    expect(error).toMatchObject({ code }); expect(String(error?.message)).not.toMatch(/test-token|Sign in|gateway/);
  });

  it('wraps network failures and rejects every mutation', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed: https://example.matomo.cloud/index.php'));
    const provider = new MatomoProvider(new MatomoClient({ url: base, tokenAuth: 'test-token' }, fetchMock as typeof fetch));
    await expect(provider.listAccounts()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const op = { provider: 'matomo', accountId: '1', tool: 'made_up_write', kind: 'update' as const, payload: {} };
    await expect(provider.previewWrite(op)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(provider.applyWrite(op)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(provider.report({} as never)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('matomo_report') });
    expect(() => new MatomoClient({ url: base, tokenAuth: ' ' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
