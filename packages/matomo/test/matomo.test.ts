import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, CredentialStore } from '@adport/core';
import { MatomoClient, MatomoProvider, normalizeMatomoUrl, matomoCredentialsFromData, createMatomoModule, resolveMatomoCredentials } from '../src/index.js';

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
    const runtime = await createContext({ providerModules: [module!] });
    expect(runtime.registry.list().filter(t => t.namespace === 'analytics').map(t => t.name).sort()).toEqual(['analytics_acquisition_report', 'analytics_goals']);
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
    for (const method of ['UsersManager.getUsers', 'Live.getLastVisitsDetails', 'SitesManager.addSite', 'API.getBulkRequest', 'Goals.addGoal', 'Live.getCounters', 'API.getProcessedReport', 'SegmentEditor.getAll']) {
      await expect(client.call(method)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(client.call('Goals.getGoals', { token_auth: 'other' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.call('Goals.getGoals', { method: 'UsersManager.deleteUser' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["You can't access this resource as it requires 'view' access for the website id = 1.", 'PROVIDER_ERROR', 'access_denied'],
    ['Unable to authenticate with the provided token. It is either invalid, expired or provided as a GET parameter.', 'NOT_CONNECTED', 'auth'],
    ['token_auth is not valid for user@example.com', 'NOT_CONNECTED', 'auth'],
    ['The segment condition foo==test-token is not valid.', 'PROVIDER_ERROR', 'segment'],
    ['API returned an error: You do not have enough permission to access the segment userId at Segment.php:250', 'PROVIDER_ERROR', 'segment'],
    ['Requested report Login.getTrend for Website id=1 not found in the list of available reports.', 'PROVIDER_ERROR', 'provider'],
    ['You do not have enough permission to access the segment Login sessions.', 'PROVIDER_ERROR', 'segment'],
    ['Requested report Foo.bar for Website id=1 not found in the list of available reports.', 'PROVIDER_ERROR', 'provider'],
  ])('maps Matomo error envelopes without leaking the message or token (%s)', async (message, code, reason) => {
    const { client } = setup({ result: 'error', message });
    try { await client.call('MarketingCampaignsReporting.getName', { idSite: '1' }); throw Error('Expected rejection'); }
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
    const error = await client.call('Goals.getGoals').then(() => undefined, (e: unknown) => e as Error);
    expect(error).toMatchObject({ code }); expect(String(error?.message)).not.toMatch(/test-token|Sign in|gateway/);
  });

  it('wraps network failures and rejects every mutation', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed: https://example.matomo.cloud/index.php'));
    const provider = new MatomoProvider(new MatomoClient({ url: base, tokenAuth: 'test-token' }, fetchMock as typeof fetch));
    await expect(provider.listAccounts()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const op = { provider: 'matomo', accountId: '1', tool: 'made_up_write', kind: 'update' as const, payload: {} };
    await expect(provider.previewWrite(op)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(provider.applyWrite(op)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(provider.report({} as never)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('analytics_acquisition_report') });
    expect(() => new MatomoClient({ url: base, tokenAuth: ' ' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

});
