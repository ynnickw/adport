import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GA4_SCOPES, GSC_SCOPES } from '@adport/core';
import { oauthAdapter, oauthAvailability } from '@/lib/cloud/provider-oauth';
import { resetEnvForTests } from '@/lib/env';
import { providerAccountsPath, usesAdAccountSlot } from '@/lib/cloud/providers';

beforeEach(() => {
  vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'ads-client.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'ads-secret');
  vi.stubEnv('GOOGLE_ANALYTICS_CLIENT_ID', 'analytics-client.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_ANALYTICS_CLIENT_SECRET', 'analytics-secret');
  vi.stubEnv('GA4_OAUTH_ENABLED', 'false'); vi.stubEnv('GSC_OAUTH_ENABLED', 'false');
  vi.stubEnv('ANALYTICS_TEST_ORGANIZATION_IDS', ''); resetEnvForTests();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvForTests(); });

describe.each([['ga4', GA4_SCOPES], ['gsc', GSC_SCOPES]] as const)('%s cloud OAuth', (provider, scopes) => {
  it('requires approved public rollout or the exact internal project', () => {
    expect(oauthAvailability()[provider]).toBe(false);
    expect(() => oauthAdapter(provider).authorizationUrl({ state: 'state', challenge: 'challenge' })).toThrow(/not enabled/);
    vi.stubEnv('ANALYTICS_TEST_ORGANIZATION_IDS', 'internal'); resetEnvForTests();
    expect(oauthAvailability('internal')[provider]).toBe(true);
    expect(oauthAvailability('customer')[provider]).toBe(false);
    expect(oauthAvailability()[provider]).toBe(false);
    expect(usesAdAccountSlot(provider)).toBe(false);
    expect(providerAccountsPath(provider)).toBe(`/dashboard/analytics?select_provider=${provider}`);
  });
  it('uses its read-only scope, independent application, exact callback, state and PKCE', () => {
    vi.stubEnv('ANALYTICS_TEST_ORGANIZATION_IDS', 'internal'); resetEnvForTests();
    const url = new URL(oauthAdapter(provider).authorizationUrl({ state: 'one-use', challenge: 's256' }));
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(scopes);
    expect(url.searchParams.get('client_id')).toBe('analytics-client.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toMatch(new RegExp(`/api/oauth/${provider}/callback$`));
    expect(url.searchParams.get('state')).toBe('one-use');
    expect(url.searchParams.get('code_challenge')).toBe('s256');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.href).not.toContain('secret');
    const ads = new URL(oauthAdapter('google').authorizationUrl({ state: 'state', challenge: 's256' }));
    expect(ads.searchParams.get('client_id')).toBe('ads-client.apps.googleusercontent.com');
    expect(ads.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adwords');
  });
  it('rejects an incomplete app configuration and missing consent without replacing credentials', async () => {
    vi.stubEnv('ANALYTICS_TEST_ORGANIZATION_IDS', 'internal');
    vi.stubEnv('GOOGLE_ANALYTICS_CLIENT_SECRET', undefined); resetEnvForTests();
    expect(oauthAvailability('internal')[provider]).toBe(false);
    vi.stubEnv('GOOGLE_ANALYTICS_CLIENT_SECRET', 'analytics-secret'); resetEnvForTests();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: 'access', refresh_token: 'refresh', scope: 'unrelated' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(oauthAdapter(provider).exchange({ code: 'code', verifier: 'pkce' })).rejects.toThrow(/did not grant/);
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1].body));
    expect(body.get('client_secret')).toBe('analytics-secret'); expect(body.get('code_verifier')).toBe('pkce');
    fetchMock.mockResolvedValue(Response.json({ access_token: 'access', refresh_token: 'refresh', scope: scopes.join(' ') }));
    await expect(oauthAdapter(provider).exchange({ code: 'code', verifier: 'pkce' })).resolves.toEqual({ refreshToken: 'refresh' });
    fetchMock.mockClear();
    expect(await oauthAdapter(provider).revoke({ refreshToken: 'refresh' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
