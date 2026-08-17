import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { googleEnv } from '@/lib/env';

export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function googleRedirectUri(): string {
  return new URL('/api/oauth/google/callback', googleEnv().ADPORT_CLOUD_BASE_URL).toString();
}

export function buildGoogleAuthorizationUrl(input: { state: string; challenge: string }): string {
  const config = googleEnv();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.GOOGLE_ADS_CLIENT_ID,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_ADS_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
  }).toString();
  return url.toString();
}

export async function exchangeGoogleCode(code: string, verifier: string): Promise<{ refreshToken: string; accessToken: string }> {
  const config = googleEnv();
  const response = await fetch(config.GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_ADS_CLIENT_ID,
      client_secret: config.GOOGLE_ADS_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    }),
    cache: 'no-store',
  });
  const payload = (await response.json()) as { access_token?: string; refresh_token?: string; error?: string };
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(`Google OAuth exchange failed${payload.error ? `: ${payload.error}` : ''}.`);
  }
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token };
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
