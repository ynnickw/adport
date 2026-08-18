import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateMicrosoft, hydrateReddit, hydrateTikTok, oauthAdapter, oauthAvailability, oauthRedirectUri } from '@/lib/cloud/provider-oauth';
import { resetEnvForTests } from '@/lib/env';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';

const APP_ENV: Record<string, string> = {
  GOOGLE_ADS_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_ADS_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'test-developer-token',
  META_APP_ID: '1234567890',
  META_APP_SECRET: 'meta-app-secret',
  TIKTOK_APP_ID: '7000000000',
  TIKTOK_APP_SECRET: 'tiktok-app-secret',
  MICROSOFT_ADS_CLIENT_ID: 'ms-client-id-0000',
  MICROSOFT_ADS_CLIENT_SECRET: 'ms-client-secret',
  MICROSOFT_ADS_DEVELOPER_TOKEN: 'ms-developer-token',
  REDDIT_CLIENT_ID: 'reddit-client',
  REDDIT_CLIENT_SECRET: 'reddit-client-secret',
  REDDIT_USER_AGENT: 'web:cloud.adport:v1 (by /u/adport)',
};

const BASE = (process.env.ADPORT_CLOUD_BASE_URL ?? 'https://app.adport.test').replace(/\/$/, '');

describe('hosted provider OAuth broker', () => {
  beforeEach(() => {
    for (const key of Object.keys(APP_ENV)) delete process.env[key];
    resetEnvForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports every provider as unavailable until its Adport-owned application is configured', () => {
    expect(oauthAvailability()).toEqual({ google: false, meta: false, tiktok: false, microsoft: false, reddit: false });
    Object.assign(process.env, APP_ENV);
    resetEnvForTests();
    expect(oauthAvailability()).toEqual({ google: true, meta: true, tiktok: true, microsoft: true, reddit: true });
  });

  it('routes every provider callback through the hosted broker path', () => {
    for (const provider of OAUTH_PROVIDERS) {
      expect(oauthRedirectUri(provider)).toBe(`${BASE}/api/oauth/${provider}/callback`);
    }
  });

  it('builds provider consent URLs with the state and, where supported, PKCE', () => {
    Object.assign(process.env, APP_ENV);
    resetEnvForTests();
    const input = { state: 'state-value', challenge: 'challenge-value' };

    const meta = new URL(oauthAdapter('meta').authorizationUrl(input));
    expect(meta.hostname).toBe('www.facebook.com');
    expect(meta.pathname.endsWith('/dialog/oauth')).toBe(true);
    expect(meta.searchParams.get('client_id')).toBe('1234567890');
    expect(meta.searchParams.get('scope')).toBe('ads_read,ads_management');
    expect(meta.searchParams.get('redirect_uri')).toBe(`${BASE}/api/oauth/meta/callback`);
    expect(meta.searchParams.get('state')).toBe('state-value');
    expect(meta.searchParams.has('client_secret')).toBe(false);

    const tiktok = new URL(oauthAdapter('tiktok').authorizationUrl(input));
    expect(tiktok.origin + tiktok.pathname).toBe('https://business-api.tiktok.com/portal/auth');
    expect(tiktok.searchParams.get('app_id')).toBe('7000000000');
    expect(tiktok.searchParams.get('redirect_uri')).toBe(`${BASE}/api/oauth/tiktok/callback`);
    expect(oauthAdapter('tiktok').codeParam).toBe('auth_code');

    const microsoft = new URL(oauthAdapter('microsoft').authorizationUrl(input));
    expect(microsoft.origin + microsoft.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(microsoft.searchParams.get('scope')).toBe('https://ads.microsoft.com/msads.manage offline_access');
    expect(microsoft.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(microsoft.searchParams.get('code_challenge_method')).toBe('S256');

    const reddit = new URL(oauthAdapter('reddit').authorizationUrl(input));
    expect(reddit.origin + reddit.pathname).toBe('https://www.reddit.com/api/v1/authorize');
    expect(reddit.searchParams.get('duration')).toBe('permanent');
    expect(reddit.searchParams.get('scope')).toBe('adsread,adsedit,adsdatadeletion');
    expect(reddit.searchParams.get('client_id')).toBe('reddit-client');

    const google = new URL(oauthAdapter('google').authorizationUrl(input));
    expect(google.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adwords');
    expect(google.searchParams.get('code_challenge')).toBe('challenge-value');
  });

  it('refuses to build a consent URL when the application is not configured', () => {
    expect(() => oauthAdapter('meta').authorizationUrl({ state: 's', challenge: 'c' })).toThrow(/META_APP_ID/);
    expect(() => oauthAdapter('reddit').authorizationUrl({ state: 's', challenge: 'c' })).toThrow(/REDDIT_CLIENT_ID/);
  });

  it('injects the Adport-owned application identity into tenant grants at runtime', () => {
    Object.assign(process.env, APP_ENV);
    resetEnvForTests();
    expect(hydrateTikTok({ accessToken: 'grant' })).toEqual({ accessToken: 'grant', appId: '7000000000', secret: 'tiktok-app-secret', sandbox: undefined });
    expect(hydrateMicrosoft({ refreshToken: 'grant' })).toMatchObject({ refreshToken: 'grant', clientId: 'ms-client-id-0000', clientSecret: 'ms-client-secret', developerToken: 'ms-developer-token' });
    expect(hydrateReddit({ refreshToken: 'grant' })).toEqual({ refreshToken: 'grant', clientId: 'reddit-client', clientSecret: 'reddit-client-secret', userAgent: 'web:cloud.adport:v1 (by /u/adport)' });
    // Legacy tenant-supplied application fields keep precedence.
    expect(hydrateReddit({ refreshToken: 'grant', clientId: 'own', clientSecret: 'own-secret', userAgent: 'own-agent' })).toEqual({ refreshToken: 'grant', clientId: 'own', clientSecret: 'own-secret', userAgent: 'own-agent' });
  });

  it('keeps the TikTok grant when provider-side revocation fails', async () => {
    Object.assign(process.env, APP_ENV);
    resetEnvForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 50002 }), { status: 502 })));

    await expect(oauthAdapter('tiktok').revoke({ accessToken: 'tenant-grant' })).rejects.toThrow(/TikTok token revocation failed/);
  });
});
