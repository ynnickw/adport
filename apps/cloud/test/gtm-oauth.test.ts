import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GTM_SCOPES } from '@adport/core';
import { oauthAdapter, oauthAvailability } from '@/lib/cloud/provider-oauth';
import { resetEnvForTests } from '@/lib/env';

beforeEach(() => {
  vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'test-client.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'test-secret');
  resetEnvForTests();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvForTests(); });

describe('cloud GTM OAuth', () => {
  it('offers GTM to customer projects and keeps Google Ads consent separate', () => {
    expect(oauthAvailability('customer-org').gtm).toBe(true);
    const ads = new URL(oauthAdapter('google').authorizationUrl({ state: 'state', challenge: 'challenge' }));
    expect(ads.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adwords');
    expect(ads.searchParams.get('redirect_uri')).toMatch(/\/api\/oauth\/google\/callback$/);
  });
  it('requires the server-owned Google client', () => {
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', undefined);
    resetEnvForTests();
    expect(oauthAvailability('customer-org').gtm).toBe(false);
    expect(() => oauthAdapter('gtm').authorizationUrl({ state: 'state', challenge: 'challenge' })).toThrow(/not enabled/);
  });
  it('reuses the server-owned Google client with GTM-only scopes, exact callback, state and PKCE', () => {
    expect(oauthAvailability().gtm).toBe(true);
    const url = new URL(oauthAdapter('gtm').authorizationUrl({ state: 'one-time', challenge: 's256-challenge' }));
    expect(url.searchParams.get('client_id')).toBe('test-client.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/oauth\/gtm\/callback$/);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(GTM_SCOPES);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('state')).toBe('one-time');
    expect(url.searchParams.get('code_challenge')).toBe('s256-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.href).not.toContain('test-secret');
  });
  it('checks granular consent and stores only the refresh-token grant', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: 'tenant-access', refresh_token: 'tenant-refresh', scope: GTM_SCOPES.join(' ') }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await oauthAdapter('gtm').exchange({ code: 'one-use', verifier: 'pkce' })).toEqual({ refreshToken: 'tenant-refresh' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token'); expect(init.method).toBe('POST');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('code_verifier')).toBe('pkce');
    expect(body.get('redirect_uri')).toMatch(/\/api\/oauth\/gtm\/callback$/);
    expect(body.get('client_secret')).toBe('test-secret');
  });
  it.each([undefined, 'https://www.googleapis.com/auth/tagmanager.edit.containers'])('rejects missing or partially granted scopes (%s)', async scope => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: 'tenant-access', refresh_token: 'tenant-refresh', scope })));
    await expect(oauthAdapter('gtm').exchange({ code: 'code', verifier: 'pkce' })).rejects.toThrow(/permissions were incomplete/);
  });
  it('does not revoke the shared Google application grant when removing GTM', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(await oauthAdapter('gtm').revoke({ refreshToken: 'grant' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
