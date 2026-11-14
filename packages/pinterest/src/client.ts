import { AdportError } from '@adport/core';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PINTEREST_API_BASE = 'https://api.pinterest.com/v5/';
export const PINTEREST_TOKEN_URL = `${PINTEREST_API_BASE}oauth/token`;
export const PINTEREST_ADS_SCOPES = ['ads:read', 'ads:write'] as const;
export const PINTEREST_PIN_SCOPES = [...PINTEREST_ADS_SCOPES, 'boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'] as const;
export const PINTEREST_SECRET_PIN_SCOPES = [...PINTEREST_PIN_SCOPES, 'boards:read_secret', 'boards:write_secret', 'pins:read_secret', 'pins:write_secret'] as const;
export const PINTEREST_CATALOG_SCOPES = ['catalogs:read', 'catalogs:write'] as const;
export interface PinterestAuthorizationOptions {
  pinManagement?: boolean;
  secretPins?: boolean;
  catalogManagement?: boolean;
}
export function pinterestAuthorizationScopes(options: PinterestAuthorizationOptions = {}): readonly string[] {
  return [...(options.secretPins ? PINTEREST_SECRET_PIN_SCOPES : options.pinManagement ? PINTEREST_PIN_SCOPES : PINTEREST_ADS_SCOPES), ...(options.catalogManagement ? PINTEREST_CATALOG_SCOPES : [])];
}
export interface PinterestCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  onRefreshToken?: (refreshToken: string) => Promise<void>;
}
const tokenSchema = z.object({
  access_token: z.string().min(1), expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export function buildPinterestAuthUrl(clientId: string, redirectUri: string, state: string, options: PinterestAuthorizationOptions = {}): string {
  return `https://www.pinterest.com/oauth/?${new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, state, scope: pinterestAuthorizationScopes(options).join(','),
  })}`;
}

async function tokenRequest(credentials: Pick<PinterestCredentials, 'clientId' | 'clientSecret'>, body: URLSearchParams, fetchImpl: typeof fetch) {
  const response = await fetchImpl(PINTEREST_TOKEN_URL, {
    method: 'POST', headers: {
      authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    }, body, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new AdportError('PROVIDER_ERROR', `pinterest: OAuth ${body.get('grant_type')} failed (HTTP ${response.status})`);
  const parsed = tokenSchema.safeParse(await response.json());
  if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'pinterest: malformed OAuth response');
  return parsed.data;
}

export async function exchangePinterestCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string } & PinterestAuthorizationOptions, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = await tokenRequest(input, new URLSearchParams({
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, continuous_refresh: 'true',
  }), fetchImpl);
  if (!token.refresh_token) throw new AdportError('PROVIDER_ERROR', 'pinterest: OAuth exchange did not return a refresh token');
  if (input.pinManagement || input.secretPins || input.catalogManagement) {
    const granted = new Set(token.scope?.split(/[\s,]+/).filter(Boolean));
    const requested = pinterestAuthorizationScopes(input);
    if (requested.some(scope => !granted.has(scope))) throw new AdportError('PROVIDER_ERROR', input.catalogManagement ? 'pinterest: requested Ads, catalog and existing Pin management permissions were not all confirmed. The previous connection was preserved.' : `pinterest: Ads and ${input.secretPins ? 'secret ' : ''}Pin management permissions were not all confirmed. The previous connection was preserved.`);
  }
  return token.refresh_token;
}

export class PinterestAdsClient {
  private token?: { value: string; expiresAt: number; scopes?: ReadonlySet<string> };
  private refreshToken: string;
  private refreshing?: Promise<string>;
  constructor(private readonly credentials: PinterestCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    this.refreshToken = credentials.refreshToken;
  }
  catalogBatchReceipt(value: unknown): string {
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
    if (encoded.length > 1_500_000) throw new AdportError('INVALID_INPUT', 'Catalog batch proof exceeds its bound; split this batch before previewing.');
    return encoded + '.' + createHmac('sha256', this.credentials.clientSecret).update('pinterest_catalog_batch_v1:' + this.credentials.clientId + ':' + encoded).digest('hex');
  }
  verifyCatalogBatchReceipt(value: string): unknown {
    const [encoded, signature, extra] = value.split('.');
    if (extra !== undefined || !encoded || encoded.length > 1_500_000 || !/^[a-f0-9]{64}$/.test(signature ?? '')) throw new AdportError('INVALID_INPUT', 'Invalid catalog batch receipt.');
    const expected = createHmac('sha256', this.credentials.clientSecret).update('pinterest_catalog_batch_v1:' + this.credentials.clientId + ':' + encoded).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature!, 'hex'))) throw new AdportError('INVALID_INPUT', 'Catalog batch receipt belongs to another application or was changed.');
    try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new AdportError('INVALID_INPUT', 'Invalid catalog batch receipt.'); }
  }
  async get<T>(path: string, schema: z.ZodType<T>, params = new URLSearchParams()): Promise<T> {
    return this.request(path, 'GET', schema, undefined, params);
  }
  async mutate<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown, schema: z.ZodType<T>, params = new URLSearchParams()): Promise<T> {
    return this.request(path, method, schema, body, params);
  }
  async uploadVideo(url: string, parameters: Record<string, string>, bytes: Uint8Array<ArrayBuffer>, name: string) {
    const destination = new URL(url);
    if (destination.origin !== 'https://pinterest-media-upload.s3-accelerate.amazonaws.com' || destination.pathname !== '/' || destination.search || destination.hash || destination.username || destination.password) throw new AdportError('PROVIDER_ERROR', 'pinterest: unrecognized native upload destination; no bytes sent');
    const required = ['Content-Type', 'key', 'policy', 'x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'x-amz-security-token', 'x-amz-signature'];
    if (Object.keys(parameters).length !== required.length || required.some(key => !parameters[key] || parameters[key]!.length > 32_768) || parameters['Content-Type'] !== 'multipart/form-data' || parameters['x-amz-algorithm'] !== 'AWS4-HMAC-SHA256' || !parameters.key!.startsWith('uploads/')) throw new AdportError('PROVIDER_ERROR', 'pinterest: invalid native multipart instructions; no bytes sent');
    const body = new FormData();
    for (const key of required) body.set(key, parameters[key]!);
    body.set('file', new Blob([bytes], { type: 'video/mp4' }), name);
    // The signed Storage capability replaces OAuth here; never forward a bearer token.
    const response = await this.fetchImpl(destination.href, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (response.status !== 204) throw new AdportError('PROVIDER_ERROR', 'pinterest: video transfer was not confirmed');
  }
  private async request<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', schema: z.ZodType<T>, body?: unknown, params = new URLSearchParams(), retry = true): Promise<T> {
    if (!/^[a-z_]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) throw new AdportError('INVALID_INPUT', 'pinterest: invalid API resource path');
    const url = new URL(path, PINTEREST_API_BASE);
    url.search = params.toString();
    const token = await this.accessToken();
    const missingCatalogScope = method === 'GET' && (path === 'catalogs' || path.startsWith('catalogs/'))
      && this.token?.value === token && this.token.scopes !== undefined && !this.token.scopes.has('catalogs:read');
    const response = await this.fetchImpl(url.href, {
      method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 && method === 'GET' && retry && !missingCatalogScope) {
      if (this.token?.value === token) this.token = undefined;
      return this.request(path, method, schema, body, params, false);
    }
    if (!response.ok) {
      const advice = response.status === 401 && missingCatalogScope
        ? ' The current token is missing catalogs:read. Ask the connection owner to review catalog access; refreshing the same grant cannot add permissions.'
        : response.status === 403 ? ' Check app Trial/Standard access, endpoint-specific scopes and ad-account permissions; reauthorization alone may not help.' : '';
      const details: Record<string, unknown> = { http_status: response.status };
      if (response.status === 401 && missingCatalogScope) details.missing_scopes = ['catalogs:read'];
      if ([400, 404, 409, 422].includes(response.status)) {
        const error = z.object({ code: z.union([z.string(), z.number()]).optional(), message: z.string().max(2000).optional() }).safeParse(await response.json().catch(() => undefined));
        if (error.success) {
          if (error.data.code !== undefined) details.api_code = error.data.code;
          const payload = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
          const auth = payload.credentials && typeof payload.credentials === 'object' ? payload.credentials as Record<string, unknown> : {};
          const sourceSecrets = path.startsWith('catalogs/') ? [payload.location, auth.username, auth.password].filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
          if (error.data.message) details.api_message = [...sourceSecrets, this.credentials.clientId, this.credentials.clientSecret, this.credentials.refreshToken, this.refreshToken, token].reduce((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, error.data.message);
        }
      }
      throw new AdportError('PROVIDER_ERROR', `pinterest: HTTP ${response.status}.${advice}${details.api_message ? ` ${details.api_message}` : ''}`, details);
    }
    const raw: unknown = response.status === 204 ? undefined : await response.json();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const resourceIds = [value.id, value.media_id].filter((id): id is string => typeof id === 'string' && /^\d{1,30}$/.test(id));
      if ((path === 'catalogs/items/batch' || /^catalogs\/\d{1,30}\/local_inventory_items\/batch$/.test(path)) && typeof value.batch_id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.batch_id)) resourceIds.push(value.batch_id);
      throw new AdportError('PROVIDER_ERROR', 'pinterest: malformed API response', { api_path: path, response_issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })), ...(method !== 'GET' && resourceIds.length ? { resource_ids: [...new Set(resourceIds)] } : {}) });
    }
    return parsed.data;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refresh(): Promise<string> {
    const token = await tokenRequest(this.credentials, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }), this.fetchImpl);
    if (token.refresh_token && token.refresh_token !== this.refreshToken) {
      this.refreshToken = token.refresh_token;
      await this.credentials.onRefreshToken?.(token.refresh_token);
    }
    this.token = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000,
      ...(token.scope?.trim() ? { scopes: new Set(token.scope.split(/[\s,]+/).filter(Boolean)) } : {}) };
    return token.access_token;
  }
}
