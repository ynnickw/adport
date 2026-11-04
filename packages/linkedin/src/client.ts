import { AdportError } from '@adport/core';
import { z } from 'zod';

export const LINKEDIN_API_BASE = 'https://api.linkedin.com/rest/';
export const LINKEDIN_API_VERSION = '202608';
export const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
export interface LinkedInTokens {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}
export interface LinkedInCredentials extends Partial<LinkedInTokens> {
  clientId?: string;
  clientSecret?: string;
  onTokens?: (tokens: LinkedInTokens) => Promise<void>;
}
const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive(), refresh_token: z.string().min(1).optional(), refresh_token_expires_in: z.number().nonnegative().optional() });

export function buildLinkedInAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'https:' || redirect.hash || redirect.username || redirect.password || redirect.search) throw new AdportError('INVALID_INPUT', 'linkedin: register an exact HTTPS callback on your own app');
  return `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, scope: 'rw_ads r_ads_reporting' })}`;
}
async function tokenRequest(body: URLSearchParams, fetchImpl: typeof fetch): Promise<LinkedInTokens> {
  const response = await fetchImpl(LINKEDIN_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new AdportError('PROVIDER_ERROR', `linkedin: OAuth ${body.get('grant_type')} failed (HTTP ${response.status}); reauthorize your own app if the grant expired`);
  const result = tokenSchema.safeParse(await response.json());
  if (!result.success) throw new AdportError('PROVIDER_ERROR', 'linkedin: malformed OAuth response');
  const token = result.data, now = Date.now();
  return { accessToken: token.access_token, expiresAt: now + token.expires_in * 1000,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(token.refresh_token_expires_in !== undefined ? { refreshExpiresAt: now + token.refresh_token_expires_in * 1000 } : {}),
  };
}
export async function exchangeLinkedInCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }, fetchImpl: typeof fetch = fetch) {
  buildLinkedInAuthUrl(input.clientId, input.redirectUri, 'validation');
  return tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, client_id: input.clientId, client_secret: input.clientSecret }), fetchImpl);
}

// Rest.li encodes leaf values, not List/record punctuation. URLSearchParams
// would incorrectly encode the structural parentheses and commas as well.
export type RestliValue = string | number | RestliValue[] | { [key: string]: RestliValue };
export function restli(value: RestliValue): string {
  if (Array.isArray(value)) return `List(${value.map(restli).join(',')})`;
  if (typeof value === 'object') return `(${Object.entries(value).map(([key, child]) => `${encodeURIComponent(key)}:${restli(child)}`).join(',')})`;
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export class LinkedInAdsClient {
  private tokens: Partial<LinkedInTokens>;
  private refreshing?: Promise<string>;
  constructor(private readonly credentials: LinkedInCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    this.tokens = { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt, refreshToken: credentials.refreshToken, refreshExpiresAt: credentials.refreshExpiresAt };
  }
  async get<T>(path: string, schema: z.ZodType<T>, params: Record<string, RestliValue> = {}): Promise<T> {
    const response = await this.request(path, 'GET', params);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'linkedin: malformed API response');
    return parsed.data;
  }
  async create(path: string, body: unknown): Promise<string> {
    const response = await this.request(path, 'POST', {}, body);
    const id = response.headers.get('x-restli-id');
    if (response.status !== 201 || !id || !/^[1-9]\d*$/.test(id)) throw new AdportError('PROVIDER_ERROR', 'linkedin: create did not return 201 and x-restli-id; inspect the account before retrying');
    return id;
  }
  async update(path: string, fields: Record<string, unknown>): Promise<void> {
    await this.partialUpdate(path, { $set: fields });
  }
  async partialUpdate(path: string, patch: Record<string, unknown>, params: Record<string, RestliValue> = {}): Promise<void> {
    const response = await this.request(path, 'POST', params, { patch }, true);
    if (response.status !== 204) throw new AdportError('PROVIDER_ERROR', 'linkedin: partial update did not return 204; inspect the account before retrying');
  }
  async createCreative(path: string, body: unknown): Promise<string> {
    const response = await this.request(path, 'POST', {}, body), raw = response.headers.get('x-restli-id');
    let id: string | undefined;
    try { id = raw ? decodeURIComponent(raw) : undefined; } catch { /* Invalid receipt remains a provider error. */ }
    if (response.status !== 201 || !id || !/^urn:li:sponsoredCreative:[1-9]\d*$/.test(id)) throw new AdportError('PROVIDER_ERROR', 'linkedin: creative create did not return 201 and a valid sponsoredCreative URN; inspect the account before retrying');
    return id;
  }
  async action<T>(path: string, action: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await this.request(path, 'POST', { action }, body), parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'linkedin: malformed action response; inspect the account before retrying');
    return parsed.data;
  }
  async remove(path: string): Promise<void> {
    const response = await this.request(path, 'DELETE', {});
    if (response.status !== 204) throw new AdportError('PROVIDER_ERROR', 'linkedin: delete did not return 204; inspect the account before retrying');
  }
  async uploadImage(url: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const target = new URL(url);
    if (target.origin !== 'https://www.linkedin.com' || !target.pathname.startsWith('/dms-uploads/') || target.username || target.password || target.hash) throw new AdportError('PROVIDER_ERROR', 'linkedin: unrecognized native image upload destination');
    const response = await this.fetchImpl(target.href, { method: 'PUT', headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/octet-stream' }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new AdportError('PROVIDER_ERROR', `linkedin: image upload HTTP ${response.status}; inspect its initialized image before retrying`);
  }
  validateMediaUpload(url: string, kind: 'video' | 'document', resource: string): URL {
    const target = new URL(url), key = resource.split(':').at(-1)!;
    const path = kind === 'video' ? `/dms-uploads/${key}/uploadedVideo` : undefined;
    if (target.origin !== 'https://www.linkedin.com' || target.username || target.password || target.hash || (kind === 'video' ? target.pathname !== path : !/^\/dms-uploads\/[A-Za-z0-9_-]+\/ads-uploadedDocument\/0$/.test(target.pathname))) throw new AdportError('PROVIDER_ERROR', 'linkedin: unrecognized native media upload destination');
    return target;
  }
  async uploadMedia(url: string, bytes: Uint8Array<ArrayBuffer>, kind: 'video' | 'document', resource: string): Promise<string> {
    const target = this.validateMediaUpload(url, kind, resource);
    const response = await this.fetchImpl(target.href, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(kind === 'document' ? { authorization: `Bearer ${await this.accessToken()}` } : {}) }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(90_000) });
    if (response.status !== (kind === 'video' ? 200 : 201)) throw new AdportError('PROVIDER_ERROR', 'linkedin: native media transfer was not acknowledged');
    const etag = response.headers.get('etag')?.replace(/^"(.*)"$/, '$1');
    if (kind === 'video' && (!etag || etag.length > 8192 || /[\r\n]/.test(etag))) throw new AdportError('PROVIDER_ERROR', 'linkedin: video part ETag was not acknowledged');
    return etag ?? '';
  }
  async finalizeVideo(body: unknown): Promise<void> {
    const response = await this.request('videos', 'POST', { action: 'finalizeUpload' }, body);
    if (response.status !== 200) throw new AdportError('PROVIDER_ERROR', 'linkedin: video finalization was not acknowledged');
  }
  private async request(path: string, method: 'GET' | 'POST' | 'DELETE', params: Record<string, RestliValue>, body?: unknown, partial = false, retry = true): Promise<Response> {
    if (!/^[a-zA-Z]+(?:\/(?:[a-zA-Z0-9]+|urn%3Ali%3A[a-zA-Z]+%3A[a-zA-Z0-9_-]+))*$/.test(path)) throw new AdportError('INVALID_INPUT', 'linkedin: invalid API resource path');
    const query = Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${key === 'fields' && typeof value === 'string' ? value.split(',').map(restli).join(',') : restli(value)}`).join('&');
    const url = new URL(path, LINKEDIN_API_BASE); url.search = query;
    const token = await this.accessToken();
    const response = await this.fetchImpl(url.href, {
      method, headers: { authorization: `Bearer ${token}`, 'Linkedin-Version': LINKEDIN_API_VERSION, 'X-Restli-Protocol-Version': '2.0.0',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(partial ? { 'X-RestLi-Method': 'PARTIAL_UPDATE' } : method === 'DELETE' ? { 'X-RestLi-Method': 'DELETE' } : params.q ? { 'X-RestLi-Method': 'FINDER' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 && method === 'GET' && retry && this.canRefresh()) {
      if (this.tokens.accessToken === token) this.tokens.expiresAt = 0;
      return this.request(path, method, params, body, partial, false);
    }
    if (!response.ok) {
      const advice = response.status === 403 ? ' Check Advertising API approval, r_ads_reporting/rw_ads scopes and account roles; reauthorization alone may not help.' : response.status === 401 ? ' Reauthorize your own LinkedIn app; a non-refreshable token must be replaced.' : '';
      throw new AdportError('PROVIDER_ERROR', `linkedin: HTTP ${response.status}.${advice}`);
    }
    return response;
  }
  private canRefresh() { return Boolean(this.tokens.refreshToken && this.credentials.clientId && this.credentials.clientSecret && (this.tokens.refreshExpiresAt === undefined || this.tokens.refreshExpiresAt > Date.now())); }
  private async accessToken(): Promise<string> {
    if (this.tokens.accessToken && (this.tokens.expiresAt === undefined || this.tokens.expiresAt > Date.now() + 60_000)) return this.tokens.accessToken;
    if (!this.canRefresh()) throw new AdportError('NOT_CONNECTED', 'linkedin: access token expired or missing; run adport connect linkedin with a fresh authorized token');
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refresh(): Promise<string> {
    const updated = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken!, client_id: this.credentials.clientId!, client_secret: this.credentials.clientSecret! }), this.fetchImpl);
    const tokens = { ...this.tokens, ...updated } as LinkedInTokens;
    // The refresh grant has a fixed lifetime. Missing TTL is not a renewal.
    if (this.tokens.refreshExpiresAt !== undefined && tokens.refreshExpiresAt !== undefined) tokens.refreshExpiresAt = Math.min(tokens.refreshExpiresAt, this.tokens.refreshExpiresAt);
    await this.credentials.onTokens?.(tokens);
    this.tokens = tokens;
    return tokens.accessToken;
  }
}
