import { beforeEach, describe, expect, it } from 'vitest';
import { buildGoogleAuthorizationUrl, createPkce, GOOGLE_ADS_SCOPE } from '@/lib/cloud/google-oauth';
import { resetEnvForTests } from '@/lib/env';

describe('hosted Google OAuth', () => {
  beforeEach(() => {
    process.env.GOOGLE_ADS_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_ADS_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'test-developer-token';
    resetEnvForTests();
  });

  it('requests only the Google Ads scope with offline access and PKCE', () => {
    const pkce = createPkce();
    const url = new URL(buildGoogleAuthorizationUrl({ state: 'state-value', challenge: pkce.challenge }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_ADS_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(pkce.verifier).not.toBe(pkce.challenge);
  });
});
