import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oauthAdapter, oauthRedirectUri } from '@/lib/cloud/provider-oauth';
import { cloudProviderApp } from '@/lib/cloud/provider-oauth-extra';
import { resetEnvForTests } from '@/lib/env';

const providers = ['snapchat', 'spotify', 'pinterest', 'linkedin'] as const;
const endpoints = {
  snapchat: ['https://accounts.snapchat.com/login/oauth2/authorize', 'https://accounts.snapchat.com/login/oauth2/access_token'],
  spotify: ['https://accounts.spotify.com/authorize/', 'https://accounts.spotify.com/api/token'],
  pinterest: ['https://www.pinterest.com/oauth/', 'https://api.pinterest.com/v5/oauth/token'],
  linkedin: ['https://www.linkedin.com/oauth/v2/authorization', 'https://www.linkedin.com/oauth/v2/accessToken'],
};

beforeEach(() => {
  vi.stubEnv('ADPORT_CLOUD_BASE_URL', 'https://app.adport.test');
  for (const provider of providers) {
    vi.stubEnv(`${provider.toUpperCase()}_CLIENT_ID`, `${provider}-client`);
    vi.stubEnv(`${provider.toUpperCase()}_CLIENT_SECRET`, `${provider}-secret`);
    vi.stubEnv(`${provider.toUpperCase()}_OAUTH_ENABLED`, 'false');
  }
  resetEnvForTests();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvForTests(); });

describe.each(providers)('%s hosted OAuth', provider => {
  it('requires an explicit rollout switch as well as app credentials', async () => {
    const adapter = oauthAdapter(provider);
    expect(adapter.configured()).toBe(false);
    expect(() => adapter.authorizationUrl({ state: 'state', challenge: 'unused' })).toThrow(/not enabled/);
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(adapter.exchange({ code: 'code', verifier: 'unused' })).rejects.toThrow(/not enabled/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv(`${provider.toUpperCase()}_OAUTH_ENABLED`, 'true'); resetEnvForTests();
    expect(adapter.configured()).toBe(true);
    vi.stubEnv(`${provider.toUpperCase()}_CLIENT_SECRET`, undefined); resetEnvForTests();
    expect(adapter.configured()).toBe(false);
  });

  it('carries state and the exact hosted callback without leaking app secrets', () => {
    vi.stubEnv(`${provider.toUpperCase()}_OAUTH_ENABLED`, 'true'); resetEnvForTests();
    const adapter = oauthAdapter(provider);
    const url = new URL(adapter.authorizationUrl({ state: 'one-time-state', challenge: 'unused' }));
    expect(url.origin + url.pathname).toBe(endpoints[provider][0]);
    expect(url.searchParams.get('state')).toBe('one-time-state');
    expect(url.searchParams.get('redirect_uri')).toBe(oauthRedirectUri(provider));
    expect(url.searchParams.get('client_id')).toBe(`${provider}-client`);
    expect(url.href).not.toContain(`${provider}-secret`);
    expect(url.searchParams.has('code_challenge')).toBe(false);
    if (provider === 'spotify') expect(url.searchParams.has('scope')).toBe(false);
    else expect(url.searchParams.get('scope')).toBe(adapter.scopes.join(provider === 'pinterest' ? ',' : ' '));
  });

  it('stores only the schema-checked tenant grant using the native wire exchange', async () => {
    vi.stubEnv(`${provider.toUpperCase()}_OAUTH_ENABLED`, 'true'); resetEnvForTests();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'tenant-access', refresh_token: 'tenant-refresh', expires_in: 3600, refresh_token_expires_in: 7200 })));
    vi.stubGlobal('fetch', fetchMock);
    const grant = await oauthAdapter(provider).exchange({ code: 'one-use-code', verifier: 'unused' });
    expect(grant).toEqual(provider === 'linkedin'
      ? { accessToken: 'tenant-access', refreshToken: 'tenant-refresh', expiresAt: 1_800_003_600_000, refreshExpiresAt: 1_800_007_200_000 }
      : { refreshToken: 'tenant-refresh' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(endpoints[provider][1]);
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('code')).toBe('one-use-code');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(oauthRedirectUri(provider));
    const headers = new Headers(init.headers);
    if (provider === 'spotify' || provider === 'pinterest') {
      expect(headers.get('authorization')).toBe(`Basic ${Buffer.from(`${provider}-client:${provider}-secret`).toString('base64')}`);
      expect(body.has('client_secret')).toBe(false);
    } else expect(body.get('client_secret')).toBe(`${provider}-secret`);
    if (provider === 'pinterest') expect(body.get('continuous_refresh')).toBe('true');
    vi.restoreAllMocks();
  });

  it('never repeats upstream secrets in an exchange error', async () => {
    vi.stubEnv(`${provider.toUpperCase()}_OAUTH_ENABLED`, 'true'); resetEnvForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-token-value', { status: 401 })));
    const error = await oauthAdapter(provider).exchange({ code: 'one-use-code', verifier: 'unused' }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain('secret-token-value');
  });

  it('injects server keys for runtime use and honestly requires manual revocation', async () => {
    expect(cloudProviderApp(provider)).toEqual({ clientId: `${provider}-client`, clientSecret: `${provider}-secret` });
    expect(await oauthAdapter(provider).revoke({ accessToken: 'access', refreshToken: 'refresh' })).toBe(false);
  });
});
