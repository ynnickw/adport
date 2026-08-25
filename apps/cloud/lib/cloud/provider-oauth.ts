import 'server-only';
import { createClientSecret, type AppleCredentials } from '@adport/provider-apple';
import { DEFAULT_GRAPH_VERSION } from '@adport/provider-meta';
import { TIKTOK_API_VERSION } from '@adport/provider-tiktok';
import { env } from '@/lib/env';
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  GOOGLE_ADS_SCOPE,
  googleConfigured,
  revokeGoogleToken,
} from './google-oauth';
import type { OAuthProvider, ProviderCredentialMap, StoredProviderCredential } from './types';

/**
 * Hosted OAuth broker. Every OAuth-capable provider is connected through an
 * Adport-owned application; tenants never paste application secrets. Each
 * adapter knows how to build the consent URL, exchange the returned code for
 * a tenant grant, and revoke that grant again on disconnect.
 */
export interface OAuthAdapter<P extends OAuthProvider = OAuthProvider> {
  provider: P;
  /** Human-readable name of the provider's OAuth application flow. */
  flowLabel: string;
  /** Scopes recorded on the connection row (informational). */
  scopes: string[];
  /** Whether the authorization request carries a PKCE S256 challenge. */
  pkce: boolean;
  /** Query parameter that carries the authorization code on the callback. */
  codeParam: string;
  /** Where the tenant can revoke Adport's access on the provider side. */
  manualRevocationUrl: string;
  configured(): boolean;
  authorizationUrl(input: { state: string; challenge: string }): string;
  exchange(input: { code: string; verifier: string }): Promise<ProviderCredentialMap[P]>;
  /**
   * Revoke the tenant grant at the provider. Resolves `true` when the provider
   * confirmed revocation, `false` when the provider offers no revocation API
   * and the tenant must revoke manually. Throws for transient failures so the
   * caller can keep the encrypted credential and retry.
   */
  revoke(credential: ProviderCredentialMap[P]): Promise<boolean>;
}

export function oauthRedirectUri(provider: OAuthProvider): string {
  return new URL(`/api/oauth/${provider}/callback`, env().ADPORT_CLOUD_BASE_URL).toString();
}

function providerMessage(provider: string, action: string, detail?: string): Error {
  return new Error(`${provider} ${action} failed${detail ? ` (${detail})` : ''}.`);
}

// ── Google Ads ────────────────────────────────────────────────────────────

const google: OAuthAdapter<'google'> = {
  provider: 'google',
  flowLabel: 'Google OAuth 2.0 (verified Adport project)',
  scopes: [GOOGLE_ADS_SCOPE],
  pkce: true,
  codeParam: 'code',
  manualRevocationUrl: 'https://myaccount.google.com/permissions',
  configured: googleConfigured,
  authorizationUrl: buildGoogleAuthorizationUrl,
  async exchange({ code, verifier }) {
    const tokens = await exchangeGoogleCode(code, verifier);
    return { refreshToken: tokens.refreshToken, loginCustomerId: env().GOOGLE_ADS_LOGIN_CUSTOMER_ID };
  },
  async revoke(credential) {
    await revokeGoogleToken(credential.refreshToken);
    return true;
  },
};

// ── Meta Ads (Facebook Login for Business) ────────────────────────────────

const META_SCOPES = ['ads_read', 'ads_management'];

function metaVersion(): string {
  return env().META_API_VERSION ?? DEFAULT_GRAPH_VERSION;
}

function metaApp(): { appId: string; appSecret: string; configId: string } {
  const value = env();
  if (!value.META_APP_ID || !value.META_APP_SECRET || !value.META_LOGIN_CONFIG_ID) {
    throw new Error('Meta OAuth is not configured. Set META_APP_ID, META_APP_SECRET, and META_LOGIN_CONFIG_ID.');
  }
  return { appId: value.META_APP_ID, appSecret: value.META_APP_SECRET, configId: value.META_LOGIN_CONFIG_ID };
}

interface MetaTokenResponse { access_token?: string; expires_in?: number; error?: { message?: string; code?: number } }

async function metaTokenRequest(params: Record<string, string>): Promise<MetaTokenResponse> {
  const response = await fetch(`https://graph.facebook.com/${metaVersion()}/oauth/access_token?${new URLSearchParams(params)}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => ({}))) as MetaTokenResponse;
  if (!response.ok || !body.access_token) throw providerMessage('Meta', 'token exchange', body.error?.code ? `code ${body.error.code}` : undefined);
  return body;
}

const meta: OAuthAdapter<'meta'> = {
  provider: 'meta',
  flowLabel: 'Facebook Login for Business',
  scopes: META_SCOPES,
  pkce: false,
  codeParam: 'code',
  manualRevocationUrl: 'https://www.facebook.com/settings?tab=business_tools',
  configured: () => Boolean(env().META_APP_ID && env().META_APP_SECRET && env().META_LOGIN_CONFIG_ID),
  authorizationUrl({ state }) {
    const url = new URL(`https://www.facebook.com/${metaVersion()}/dialog/oauth`);
    url.search = new URLSearchParams({
      client_id: metaApp().appId,
      config_id: metaApp().configId,
      redirect_uri: oauthRedirectUri('meta'),
      response_type: 'code',
      override_default_response_type: 'true',
      state,
    }).toString();
    return url.toString();
  },
  async exchange({ code }) {
    const { appId, appSecret } = metaApp();
    const shortLived = await metaTokenRequest({ client_id: appId, client_secret: appSecret, redirect_uri: oauthRedirectUri('meta'), code });
    const longLived = await metaTokenRequest({
      grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortLived.access_token!,
    });
    return {
      accessToken: longLived.access_token!,
      expiresAt: longLived.expires_in ? Math.floor(Date.now() / 1000) + longLived.expires_in : undefined,
    };
  },
  async revoke(credential) {
    const response = await fetch(`https://graph.facebook.com/${metaVersion()}/me/permissions?${new URLSearchParams({ access_token: credential.accessToken })}`, {
      method: 'DELETE', cache: 'no-store',
    });
    // 400 means the token is already invalid or expired: nothing left to revoke.
    if (!response.ok && response.status !== 400) throw providerMessage('Meta', 'permission revocation', String(response.status));
    return true;
  },
};

// ── TikTok Ads (TikTok for Business) ──────────────────────────────────────

const TIKTOK_BASE = `https://business-api.tiktok.com/open_api/${TIKTOK_API_VERSION}`;

function tiktokApp(): { appId: string; secret: string } {
  const value = env();
  if (!value.TIKTOK_APP_ID || !value.TIKTOK_APP_SECRET) throw new Error('TikTok OAuth is not configured. Set TIKTOK_APP_ID and TIKTOK_APP_SECRET.');
  return { appId: value.TIKTOK_APP_ID, secret: value.TIKTOK_APP_SECRET };
}

const tiktok: OAuthAdapter<'tiktok'> = {
  provider: 'tiktok',
  flowLabel: 'TikTok for Business advertiser authorization',
  scopes: ['ads_management', 'reporting'],
  pkce: false,
  codeParam: 'auth_code',
  manualRevocationUrl: 'https://business.tiktok.com/manage/authorized_apps',
  configured: () => Boolean(env().TIKTOK_APP_ID && env().TIKTOK_APP_SECRET),
  authorizationUrl({ state }) {
    const url = new URL('https://business-api.tiktok.com/portal/auth');
    url.search = new URLSearchParams({ app_id: tiktokApp().appId, state, redirect_uri: oauthRedirectUri('tiktok') }).toString();
    return url.toString();
  },
  async exchange({ code }) {
    const { appId, secret } = tiktokApp();
    const response = await fetch(`${TIKTOK_BASE}/oauth2/access_token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ app_id: appId, secret, auth_code: code }),
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => ({}))) as { code?: number; message?: string; data?: { access_token?: string } };
    if (!response.ok || body.code !== 0 || !body.data?.access_token) throw providerMessage('TikTok', 'token exchange', body.code ? `code ${body.code}` : undefined);
    return { accessToken: body.data.access_token };
  },
  async revoke(credential) {
    const { appId, secret } = tiktokApp();
    const response = await fetch(`${TIKTOK_BASE}/oauth2/revoke_token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ app_id: appId, secret, access_token: credential.accessToken }),
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => ({}))) as { code?: number };
    if (!response.ok || body.code !== 0) {
      throw providerMessage('TikTok', 'token revocation', body.code ? `code ${body.code}` : String(response.status));
    }
    return true;
  },
};

// ── Apple Ads (approved service-provider authorization) ──────────────────

const APPLE_AUTHORIZE = 'https://appleid.apple.com/auth/oauth2/v2/authorize';
const APPLE_TOKEN = 'https://appleid.apple.com/auth/oauth2/token';
const APPLE_SCOPE = 'searchads';

function appleApp(): AppleCredentials {
  const value = env();
  if (!value.APPLE_ADS_CLIENT_ID || !value.APPLE_ADS_TEAM_ID || !value.APPLE_ADS_KEY_ID || !value.APPLE_ADS_PRIVATE_KEY) {
    throw new Error('Apple Ads OAuth is not configured. Set APPLE_ADS_CLIENT_ID, APPLE_ADS_TEAM_ID, APPLE_ADS_KEY_ID, and APPLE_ADS_PRIVATE_KEY.');
  }
  return {
    clientId: value.APPLE_ADS_CLIENT_ID,
    teamId: value.APPLE_ADS_TEAM_ID,
    keyId: value.APPLE_ADS_KEY_ID,
    privateKeyPem: value.APPLE_ADS_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}

const apple: OAuthAdapter<'apple'> = {
  provider: 'apple',
  flowLabel: 'Apple Ads service-provider authorization',
  scopes: [APPLE_SCOPE],
  pkce: false,
  codeParam: 'code',
  manualRevocationUrl: 'https://ui.ads.apple.com/',
  configured: () => Boolean(env().APPLE_ADS_CLIENT_ID && env().APPLE_ADS_TEAM_ID && env().APPLE_ADS_KEY_ID && env().APPLE_ADS_PRIVATE_KEY),
  authorizationUrl({ state }) {
    const application = appleApp();
    const url = new URL(APPLE_AUTHORIZE);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: application.clientId,
      redirect_uri: oauthRedirectUri('apple'),
      scope: APPLE_SCOPE,
      state,
    }).toString();
    return url.toString();
  },
  async exchange({ code }) {
    const application = appleApp();
    const response = await fetch(APPLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: application.clientId,
        client_secret: createClientSecret(application),
        redirect_uri: oauthRedirectUri('apple'),
        code,
      }),
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
    if (!response.ok || !body.refresh_token) throw providerMessage('Apple Ads', 'token exchange', body.error);
    return { refreshToken: body.refresh_token };
  },
  // Apple requires the user to remove the service provider in Apple Ads API settings.
  async revoke() { return false; },
};

// ── Microsoft Advertising (Microsoft identity platform) ───────────────────

const MS_AUTHORIZE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_SCOPE = 'https://ads.microsoft.com/msads.manage offline_access';

function microsoftApp(): { clientId: string; clientSecret: string; developerToken: string } {
  const value = env();
  if (!value.MICROSOFT_ADS_CLIENT_ID || !value.MICROSOFT_ADS_CLIENT_SECRET || !value.MICROSOFT_ADS_DEVELOPER_TOKEN) {
    throw new Error('Microsoft Advertising OAuth is not configured. Set MICROSOFT_ADS_CLIENT_ID, MICROSOFT_ADS_CLIENT_SECRET, and MICROSOFT_ADS_DEVELOPER_TOKEN.');
  }
  return { clientId: value.MICROSOFT_ADS_CLIENT_ID, clientSecret: value.MICROSOFT_ADS_CLIENT_SECRET, developerToken: value.MICROSOFT_ADS_DEVELOPER_TOKEN };
}

const microsoft: OAuthAdapter<'microsoft'> = {
  provider: 'microsoft',
  flowLabel: 'Microsoft identity platform (Entra) consent',
  scopes: MS_SCOPE.split(' '),
  pkce: true,
  codeParam: 'code',
  manualRevocationUrl: 'https://account.live.com/consent/Manage',
  configured: () => Boolean(env().MICROSOFT_ADS_CLIENT_ID && env().MICROSOFT_ADS_CLIENT_SECRET && env().MICROSOFT_ADS_DEVELOPER_TOKEN),
  authorizationUrl({ state, challenge }) {
    const url = new URL(MS_AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: microsoftApp().clientId,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: oauthRedirectUri('microsoft'),
      scope: MS_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
      state,
    }).toString();
    return url.toString();
  },
  async exchange({ code, verifier }) {
    const { clientId, clientSecret } = microsoftApp();
    const response = await fetch(MS_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, scope: MS_SCOPE, code,
        redirect_uri: oauthRedirectUri('microsoft'), grant_type: 'authorization_code', code_verifier: verifier,
      }),
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
    if (!response.ok || !body.refresh_token) throw providerMessage('Microsoft', 'token exchange', body.error);
    return { refreshToken: body.refresh_token };
  },
  // The identity platform exposes no app-initiated refresh-token revocation; the
  // user removes Adport under their Microsoft account's app permissions.
  async revoke() { return false; },
};

// ── Reddit Ads ────────────────────────────────────────────────────────────

const REDDIT_AUTHORIZE = 'https://www.reddit.com/api/v1/authorize';
const REDDIT_TOKEN = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_REVOKE = 'https://www.reddit.com/api/v1/revoke_token';
const REDDIT_SCOPES = 'adsread,adsedit,adsdatadeletion';

function redditApp(): { clientId: string; clientSecret: string; userAgent: string } {
  const value = env();
  if (!value.REDDIT_CLIENT_ID || !value.REDDIT_CLIENT_SECRET || !value.REDDIT_USER_AGENT) {
    throw new Error('Reddit OAuth is not configured. Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_USER_AGENT.');
  }
  return { clientId: value.REDDIT_CLIENT_ID, clientSecret: value.REDDIT_CLIENT_SECRET, userAgent: value.REDDIT_USER_AGENT };
}

function redditHeaders(): Record<string, string> {
  const { clientId, clientSecret, userAgent } = redditApp();
  return {
    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': userAgent,
  };
}

const reddit: OAuthAdapter<'reddit'> = {
  provider: 'reddit',
  flowLabel: 'Reddit OAuth 2.0 (permanent grant)',
  scopes: REDDIT_SCOPES.split(','),
  pkce: false,
  codeParam: 'code',
  manualRevocationUrl: 'https://www.reddit.com/prefs/apps',
  configured: () => Boolean(env().REDDIT_CLIENT_ID && env().REDDIT_CLIENT_SECRET && env().REDDIT_USER_AGENT),
  authorizationUrl({ state }) {
    const url = new URL(REDDIT_AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: redditApp().clientId, response_type: 'code', state,
      redirect_uri: oauthRedirectUri('reddit'), duration: 'permanent', scope: REDDIT_SCOPES,
    }).toString();
    return url.toString();
  },
  async exchange({ code }) {
    const response = await fetch(REDDIT_TOKEN, {
      method: 'POST',
      headers: redditHeaders(),
      body: new URLSearchParams({ grant_type: 'authorization_code', code: code.replace(/#_$/, ''), redirect_uri: oauthRedirectUri('reddit') }),
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
    if (!response.ok || !body.refresh_token) throw providerMessage('Reddit', 'token exchange', body.error);
    return { refreshToken: body.refresh_token };
  },
  async revoke(credential) {
    const response = await fetch(REDDIT_REVOKE, {
      method: 'POST',
      headers: redditHeaders(),
      body: new URLSearchParams({ token: credential.refreshToken, token_type_hint: 'refresh_token' }),
      cache: 'no-store',
    });
    if (!response.ok && response.status !== 400 && response.status !== 401) throw providerMessage('Reddit', 'token revocation', String(response.status));
    return true;
  },
};

const adapters = { google, meta, tiktok, microsoft, reddit, apple } satisfies { [P in OAuthProvider]: OAuthAdapter<P> };

export function oauthAdapter<P extends OAuthProvider>(provider: P): OAuthAdapter<P> {
  return adapters[provider] as unknown as OAuthAdapter<P>;
}

export function revokeGrant(provider: OAuthProvider, credential: StoredProviderCredential): Promise<boolean> {
  return (adapters[provider] as OAuthAdapter).revoke(credential as ProviderCredentialMap[OAuthProvider] as never);
}

/** Availability of every hosted OAuth application, for the connections UI. */
export function oauthAvailability(): Record<OAuthProvider, boolean> {
  return {
    google: google.configured(),
    meta: meta.configured(),
    tiktok: tiktok.configured(),
    microsoft: microsoft.configured(),
    reddit: reddit.configured(),
    apple: apple.configured(),
  };
}

/**
 * Merge the tenant grant with the Adport-owned application identity so the
 * provider client can be constructed. Records that predate the broker may
 * still carry their own application fields; those take precedence.
 */
export function hydrateMeta(stored: ProviderCredentialMap['meta']): { accessToken: string; appId?: string; appSecret?: string } {
  const value = env();
  return { accessToken: stored.accessToken, appId: stored.appId ?? value.META_APP_ID, appSecret: stored.appSecret ?? value.META_APP_SECRET };
}

export function hydrateTikTok(stored: ProviderCredentialMap['tiktok']): { accessToken: string; appId: string; secret: string; sandbox?: boolean } {
  const value = env();
  const appId = stored.appId ?? value.TIKTOK_APP_ID;
  const secret = stored.secret ?? value.TIKTOK_APP_SECRET;
  if (!appId || !secret) throw new Error('TikTok application credentials are not configured for this deployment.');
  return { accessToken: stored.accessToken, appId, secret, sandbox: stored.sandbox };
}

export function hydrateMicrosoft(stored: ProviderCredentialMap['microsoft']): { developerToken: string; clientId: string; clientSecret?: string; refreshToken: string; sandbox?: boolean } {
  const value = env();
  const clientId = stored.clientId ?? value.MICROSOFT_ADS_CLIENT_ID;
  const developerToken = stored.developerToken ?? value.MICROSOFT_ADS_DEVELOPER_TOKEN;
  if (!clientId || !developerToken) throw new Error('Microsoft Advertising application credentials are not configured for this deployment.');
  return {
    developerToken, clientId, refreshToken: stored.refreshToken, sandbox: stored.sandbox,
    clientSecret: stored.clientSecret ?? (stored.clientId ? undefined : value.MICROSOFT_ADS_CLIENT_SECRET),
  };
}

export function hydrateReddit(stored: ProviderCredentialMap['reddit']): { clientId: string; clientSecret: string; refreshToken: string; userAgent: string } {
  const value = env();
  const clientId = stored.clientId ?? value.REDDIT_CLIENT_ID;
  const clientSecret = stored.clientSecret ?? value.REDDIT_CLIENT_SECRET;
  const userAgent = stored.userAgent ?? value.REDDIT_USER_AGENT;
  if (!clientId || !clientSecret || !userAgent) throw new Error('Reddit application credentials are not configured for this deployment.');
  return { clientId, clientSecret, refreshToken: stored.refreshToken, userAgent };
}

export function hydrateApple(stored: ProviderCredentialMap['apple']): AppleCredentials {
  return { ...appleApp(), refreshToken: stored.refreshToken };
}
