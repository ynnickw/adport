import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const OAUTH_TTL_MS = 10 * 60_000;

interface GoogleOAuthState {
  nonce: string;
  workspaceId: string;
  userId: string;
  expiresAt: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function config() {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const baseUrl = process.env.ADPORT_CLOUD_BASE_URL;
  if (!clientId || !clientSecret || !developerToken || !baseUrl) {
    throw new Error('Managed Google OAuth requires GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN, and ADPORT_CLOUD_BASE_URL');
  }
  return {
    clientId,
    clientSecret,
    redirectUri: new URL('/api/oauth/google/callback', baseUrl).toString(),
  };
}

function stateSecret(): string {
  const configured = process.env.ADPORT_CLOUD_OAUTH_STATE_SECRET ?? process.env.ADPORT_CLOUD_SESSION_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') throw new Error('ADPORT_CLOUD_OAUTH_STATE_SECRET is required in production');
  return 'adport-local-oauth-state-development-only';
}

function signature(payload: string): string {
  return createHmac('sha256', stateSecret()).update(payload).digest('base64url');
}

export function managedGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_CLIENT_ID
    && process.env.GOOGLE_ADS_CLIENT_SECRET
    && process.env.GOOGLE_ADS_DEVELOPER_TOKEN
    && process.env.ADPORT_CLOUD_BASE_URL,
  );
}

export function createGoogleOAuthState(workspaceId: string, userId: string, now = Date.now()): string {
  const value: GoogleOAuthState = {
    nonce: randomBytes(24).toString('base64url'),
    workspaceId,
    userId,
    expiresAt: now + OAUTH_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifyGoogleOAuthState(encoded: string, workspaceId: string, userId: string, now = Date.now()): boolean {
  const [payload, supplied] = encoded.split('.');
  if (!payload || !supplied) return false;
  const expected = signature(payload);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GoogleOAuthState;
    return value.workspaceId === workspaceId && value.userId === userId && value.expiresAt > now && Boolean(value.nonce);
  } catch {
    return false;
  }
}

export function googleAuthorizationUrl(state: string): URL {
  const { clientId, redirectUri } = config();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    access_type: 'offline',
    client_id: clientId,
    include_granted_scopes: 'true',
    prompt: 'consent',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_ADS_SCOPE,
    state,
  }).toString();
  return url;
}

export async function exchangeGoogleCode(code: string, fetchImpl: typeof fetch = fetch): Promise<{ refreshToken: string }> {
  const { clientId, clientSecret, redirectUri } = config();
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
    cache: 'no-store',
  });
  const body = await response.json() as GoogleTokenResponse;
  if (!response.ok || !body.refresh_token) {
    throw new Error(`Google token exchange failed${body.error ? ` (${body.error})` : ''}`);
  }
  return { refreshToken: body.refresh_token };
}

export const GOOGLE_OAUTH_COOKIE = 'adport_google_oauth_state';
export const GOOGLE_OAUTH_MAX_AGE_SECONDS = OAUTH_TTL_MS / 1000;
