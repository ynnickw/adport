import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_GRAPH_VERSION } from '@adport/provider-meta';

const OAUTH_TTL_MS = 10 * 60_000;
const META_SCOPES = ['ads_read', 'ads_management'];

interface MetaOAuthState {
  nonce: string;
  workspaceId: string;
  userId: string;
  expiresAt: number;
}

interface MetaTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string; code?: number };
}

function config() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const baseUrl = process.env.ADPORT_CLOUD_BASE_URL;
  if (!appId || !appSecret || !baseUrl) {
    throw new Error('Managed Meta OAuth requires META_APP_ID, META_APP_SECRET, and ADPORT_CLOUD_BASE_URL');
  }
  return { appId, appSecret, redirectUri: new URL('/api/oauth/meta/callback', baseUrl).toString() };
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

export function managedMetaOAuthConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.ADPORT_CLOUD_BASE_URL);
}

export function createMetaOAuthState(workspaceId: string, userId: string, now = Date.now()): string {
  const value: MetaOAuthState = {
    nonce: randomBytes(24).toString('base64url'),
    workspaceId,
    userId,
    expiresAt: now + OAUTH_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifyMetaOAuthState(encoded: string, workspaceId: string, userId: string, now = Date.now()): boolean {
  const [payload, supplied] = encoded.split('.');
  if (!payload || !supplied) return false;
  const expected = signature(payload);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MetaOAuthState;
    return value.workspaceId === workspaceId && value.userId === userId && value.expiresAt > now && Boolean(value.nonce);
  } catch {
    return false;
  }
}

export function metaAuthorizationUrl(state: string): URL {
  const { appId, redirectUri } = config();
  const url = new URL(`https://www.facebook.com/${process.env.META_API_VERSION ?? DEFAULT_GRAPH_VERSION}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: META_SCOPES.join(','),
    state,
  }).toString();
  return url;
}

async function tokenRequest(params: Record<string, string>): Promise<MetaTokenResponse> {
  const version = process.env.META_API_VERSION ?? DEFAULT_GRAPH_VERSION;
  const response = await fetch(`https://graph.facebook.com/${version}/oauth/access_token?${new URLSearchParams(params)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const body = await response.json() as MetaTokenResponse;
  if (!response.ok || !body.access_token) {
    throw new Error(`Meta token exchange failed${body.error?.code ? ` (code ${body.error.code})` : ''}`);
  }
  return body;
}

export async function exchangeMetaCode(code: string): Promise<{ accessToken: string; appId: string }> {
  const { appId, appSecret, redirectUri } = config();
  const shortLived = await tokenRequest({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  const longLived = await tokenRequest({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLived.access_token!,
  });
  return { accessToken: longLived.access_token!, appId };
}

export const META_OAUTH_COOKIE = 'adport_meta_oauth_state';
export const META_OAUTH_MAX_AGE_SECONDS = OAUTH_TTL_MS / 1000;
