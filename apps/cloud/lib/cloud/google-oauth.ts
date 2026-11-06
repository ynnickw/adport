import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { env, googleEnv } from '@/lib/env';
import { GOOGLE_DATA_MANAGER_SCOPE } from '@adport/provider-google';
export { GOOGLE_DATA_MANAGER_SCOPE };

export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

export type GoogleOAuthProvider = 'google' | 'gtm' | 'ga4' | 'gsc';
export function googleConfigured(provider: GoogleOAuthProvider = 'google'): boolean {
  const value = env();
  if ((provider === 'ga4' || provider === 'gsc') && (value.GOOGLE_ANALYTICS_CLIENT_ID || value.GOOGLE_ANALYTICS_CLIENT_SECRET)) {
    return Boolean(value.GOOGLE_ANALYTICS_CLIENT_ID && value.GOOGLE_ANALYTICS_CLIENT_SECRET);
  }
  return Boolean(value.GOOGLE_ADS_CLIENT_ID && value.GOOGLE_ADS_CLIENT_SECRET);
}

export function googleOAuthClient(provider: GoogleOAuthProvider) {
  const value = env();
  if (!googleConfigured(provider)) throw new Error('Google OAuth application is not configured.');
  const analytics = (provider === 'ga4' || provider === 'gsc') && Boolean(value.GOOGLE_ANALYTICS_CLIENT_ID);
  return { clientId: (analytics ? value.GOOGLE_ANALYTICS_CLIENT_ID : value.GOOGLE_ADS_CLIENT_ID)!,
    clientSecret: (analytics ? value.GOOGLE_ANALYTICS_CLIENT_SECRET : value.GOOGLE_ADS_CLIENT_SECRET)! };
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function googleRedirectUri(provider: GoogleOAuthProvider = 'google'): string {
  return new URL(`/api/oauth/${provider}/callback`, env().ADPORT_CLOUD_BASE_URL).toString();
}

export function buildGoogleAuthorizationUrl(input: { state: string; challenge: string }, requested: boolean | { provider: GoogleOAuthProvider; scopes: readonly string[] } = false): string {
  const options = typeof requested === 'boolean'
    ? { provider: 'google' as const, scopes: [GOOGLE_ADS_SCOPE, ...(requested ? [GOOGLE_DATA_MANAGER_SCOPE] : [])] }
    : requested;
  const config = googleOAuthClient(options.provider);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: googleRedirectUri(options.provider),
    response_type: 'code',
    scope: options.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
  }).toString();
  return url.toString();
}

export async function exchangeGoogleCode(code: string, verifier: string, provider: GoogleOAuthProvider = 'google'): Promise<{ refreshToken: string; accessToken: string; scopes: string[] }> {
  const config = env(), client = googleOAuthClient(provider);
  const response = await fetch(config.GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: googleRedirectUri(provider),
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    }),
    cache: 'no-store',
  });
  const payload = (await response.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(`Google OAuth exchange failed${payload.error ? `: ${payload.error}` : ''}.`);
  }
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token, scopes: payload.scope?.split(/\s+/).filter(Boolean) ?? [] };
}

export async function revokeGoogleToken(refreshToken: string): Promise<void> {
  const response = await fetch(googleEnv().GOOGLE_OAUTH_REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }),
    cache: 'no-store',
  });
  if (!response.ok && response.status !== 400) throw new Error(`Google token revocation failed (${response.status}).`);
}
