import { AdportError } from '@adport/core';
import { z } from 'zod';

export const SNAPCHAT_API_BASE = 'https://adsapi.snapchat.com/v1/';
export const SNAPCHAT_TOKEN_URL = 'https://accounts.snapchat.com/login/oauth2/access_token';
export const SNAPCHAT_SCOPE = 'snapchat-marketing-api';

export function buildSnapchatAuthUrl(clientId: string, redirectUri: string, state: string): string {
  return `https://accounts.snapchat.com/login/oauth2/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SNAPCHAT_SCOPE, state,
  })}`;
}

export async function exchangeSnapchatCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(SNAPCHAT_TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri }),
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new AdportError('PROVIDER_ERROR', `snapchat: OAuth exchange failed (HTTP ${response.status})`);
  const parsed = tokenSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success || !parsed.data.refresh_token) throw new AdportError('PROVIDER_ERROR', 'snapchat: OAuth response did not include a valid refresh token');
  return parsed.data.refresh_token;
}

export interface SnapchatCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  onRefreshToken?: (refreshToken: string) => Promise<void>;
}

const envelopeSchema = z.looseObject({
  request_status: z.string(),
  request_id: z.string().optional(),
  paging: z.object({ next_link: z.string().optional() }).optional(),
});
const success = (status: string) => status.toUpperCase() === 'SUCCESS';
const tokenSchema = z.object({
  access_token: z.string().min(1), expires_in: z.number().positive(), refresh_token: z.string().min(1).optional(),
});

export function snapchatUploadPath(path: string, mediaId: string, action: 'ADD' | 'FINALIZE'): URL {
  if (!/^[A-Za-z0-9_-]+$/.test(mediaId)) throw new AdportError('INVALID_INPUT', 'snapchat: invalid media ID');
  const url = new URL(path, SNAPCHAT_API_BASE);
  if (url.origin !== 'https://adsapi.snapchat.com' || ![`/v1/media/${mediaId}/multipart-upload-v2`, `/us/v1/media/${mediaId}/multipart-upload-v2`].includes(url.pathname) || url.username || url.password || url.hash || url.searchParams.size !== 1 || url.searchParams.get('action') !== action) throw new AdportError('PROVIDER_ERROR', 'snapchat: upload path changed media/action scope');
  return url;
}

export class SnapchatAdsClient {
  private token?: { value: string; expiresAt: number };
  private refreshToken: string;
  private refreshing?: Promise<string>;

  constructor(private readonly credentials: SnapchatCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    this.refreshToken = credentials.refreshToken;
  }

  async collection<T>(path: string, plural: string, singular: string, schema: z.ZodType<T>, params: Record<string, string> = {}): Promise<T[]> {
    let url = this.url(path, params);
    const resourcePath = url.pathname;
    const visited = new Set<string>();
    const rows: T[] = [];
    while (true) {
      if (visited.has(url.href) || visited.size >= 1000) {
        throw new AdportError('PROVIDER_ERROR', 'snapchat: pagination did not terminate; refusing incomplete results');
      }
      visited.add(url.href);
      const data = await this.send(url, 'GET');
      rows.push(...this.items(data, plural, singular, schema));
      const next = data.paging?.next_link;
      if (!next) return rows;
      url = this.url(next);
      if (url.pathname !== resourcePath) throw new AdportError('PROVIDER_ERROR', 'snapchat: pagination changed resource scope');
    }
  }

  async mutate<T>(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown, plural: string, singular: string, schema: z.ZodType<T>): Promise<T[]> {
    return (await this.mutation(path, method, body, plural, singular, schema)).items;
  }

  async mutation<T>(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body: unknown, plural: string, singular: string, schema: z.ZodType<T>) {
    const data = await this.send(this.url(path), method, body, false, true);
    const items = this.items(data, plural, singular, schema);
    const warnings = this.warnings(data, plural);
    return { items, warnings };
  }

  async page<T>(path: string, plural: string, singular: string, schema: z.ZodType<T>, params: Record<string, string>) {
    const url = this.url(path, params), data = await this.send(url, 'GET');
    const rows = this.items(data, plural, singular, schema);
    let cursor: string | undefined;
    if (data.paging?.next_link) {
      const next = this.url(data.paging.next_link);
      if (next.pathname !== url.pathname || !(cursor = next.searchParams.get('cursor') ?? undefined) || cursor === params.cursor) throw new AdportError('PROVIDER_ERROR', 'snapchat: pagination changed scope or repeated cursor');
    }
    return { items: rows, truncated: Boolean(cursor), ...(cursor ? { next_cursor: cursor } : {}), warnings: this.warnings(data, plural) };
  }

  async request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const data = await this.send(this.url(path), method, body);
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'snapchat: malformed API response', { response_issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) });
    return parsed.data;
  }

  /** A read-only, account-bound Public Profile API call, never a caller-supplied URL. */
  async sharingPolicies(accountId: string, resourceType: 'public_profiles' | 'pixels' | 'mobile_apps' | 'catalogs') {
    if (!/^[A-Za-z0-9_-]+$/.test(accountId)) throw new AdportError('INVALID_INPUT', 'snapchat: invalid ad-account ID');
    const path = `/v1/adaccounts/${accountId}/sharing_policies`;
    let url = new URL(`https://businessapi.snapchat.com${path}?shared_resource_types=${resourceType}`);
    const policies: Array<{ sharing_policy_id: string; source: { resource_type: string; resource_id: string } }> = [], seen = new Set<string>();
    while (true) {
      if (seen.has(url.href) || seen.size >= 1000) throw new AdportError('PROVIDER_ERROR', 'snapchat: sharing-policy pagination did not terminate');
      seen.add(url.href);
      const data = await this.send(url, 'GET');
      const parsed = z.array(z.object({ sharing_policy_id: z.string(), source: z.object({ resource_type: z.string(), resource_id: z.string() }) })).safeParse(data.sharing_policies);
      if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'snapchat: malformed sharing policies');
      policies.push(...parsed.data.filter(row => row.source.resource_type === resourceType));
      if (!data.paging?.next_link) return policies;
      url = new URL(data.paging.next_link, url);
      if (url.origin !== 'https://businessapi.snapchat.com' || url.pathname !== path || url.username || url.password || url.hash || url.searchParams.get('shared_resource_types') !== resourceType) throw new AdportError('PROVIDER_ERROR', 'snapchat: sharing-policy pagination changed scope');
    }
  }

  /** Only INIT-provided paths for the exact media and action may carry authorization. */
  async uploadPart<T>(path: string, mediaId: string, action: 'ADD' | 'FINALIZE', form: FormData, schema: z.ZodType<T>): Promise<T> {
    const url = snapchatUploadPath(path, mediaId, action);
    const parsed = schema.safeParse(await this.send(url, 'POST', form));
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'snapchat: malformed media upload response');
    return parsed.data;
  }

  private items<T>(data: z.infer<typeof envelopeSchema>, plural: string, singular: string, schema: z.ZodType<T>): T[] {
    const items = z.array(z.looseObject({ sub_request_status: z.string() })).safeParse(data[plural]);
    if (!items.success) throw new AdportError('PROVIDER_ERROR', `snapchat: malformed ${plural} response`);
    const rows: T[] = [], ids: string[] = [];
    let failed = !success(data.request_status), malformed = false;
    for (const item of items.data) {
      const raw = item[singular];
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).id === 'string') ids.push(String((raw as Record<string, unknown>).id));
      if (!success(item.sub_request_status)) { failed = true; continue; }
      const parsed = schema.safeParse(item[singular]);
      if (!parsed.success) { malformed = true; continue; }
      rows.push(parsed.data);
    }
    if (failed || malformed) throw new AdportError('PROVIDER_ERROR', `snapchat: ${malformed ? `malformed ${singular} response` : `${singular} sub-request failed`}; reconcile returned IDs before retrying`, { requestId: data.request_id, resource_ids: ids, errors: items.data.filter(item => !success(item.sub_request_status)).map(item => this.errorDetails(item)), warnings: this.warnings(data, plural) });
    return rows;
  }

  private redact(value: string) {
    return [this.credentials.clientSecret, this.credentials.clientId, this.credentials.refreshToken, this.refreshToken, this.token?.value].reduce<string>((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, value).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b[a-f0-9]{64}\b/gi, '[redacted hash]').slice(0, 2000);
  }
  private errorDetails(input: Record<string, unknown>) {
    return Object.fromEntries(['error_code', 'display_message', 'debug_message', 'sub_request_error_reason'].flatMap(key => typeof input[key] === 'string' || typeof input[key] === 'number' ? [[key, this.redact(String(input[key]))]] : []));
  }
  private warnings(data: z.infer<typeof envelopeSchema>, plural: string): string[] {
    const items = Array.isArray(data[plural]) ? data[plural] as Record<string, unknown>[] : [];
    return [data, ...items].flatMap(row => Array.isArray(row.sub_request_warnings) ? row.sub_request_warnings.map(value => this.redact(typeof value === 'string' ? value : JSON.stringify(value))) : []);
  }

  private url(path: string, params: Record<string, string> = {}): URL {
    // Pagination must never forward an access token to another origin or API.
    const url = new URL(path, SNAPCHAT_API_BASE);
    if (url.origin !== 'https://adsapi.snapchat.com' || !url.pathname.startsWith('/v1/') || url.username || url.password || url.hash) {
      throw new AdportError('INVALID_INPUT', 'snapchat: invalid API URL');
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }

  private async send(url: URL, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown, retry = true, acceptBatchFailure = false): Promise<z.infer<typeof envelopeSchema>> {
    const token = await this.accessToken();
    const multipart = body instanceof FormData;
    const response = await this.fetchImpl(url.href, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && !multipart ? { 'content-type': method === 'PATCH' ? 'application/json-patch+json' : 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 && method === 'GET' && retry) {
      if (this.token?.value === token) this.token = undefined;
      return this.send(url, method, body, false, acceptBatchFailure);
    }
    if (!response.ok) {
      const advice = response.status === 403 ? ' Check app approval and the user’s ad-account permissions; reconnecting alone may not resolve this.' : '';
      const raw = await response.json().catch(() => undefined);
      const details = raw && typeof raw === 'object' && !Array.isArray(raw) ? this.errorDetails(raw as Record<string, unknown>) : {};
      throw new AdportError('PROVIDER_ERROR', `snapchat: HTTP ${response.status}.${advice}${details.display_message || details.debug_message ? ` ${details.display_message ?? details.debug_message}` : ''}`, { http_status: response.status, ...details });
    }
    const parsed = envelopeSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'snapchat: malformed API envelope');
    if (!success(parsed.data.request_status) && !acceptBatchFailure) {
      throw new AdportError('PROVIDER_ERROR', 'snapchat: API request failed', { requestId: parsed.data.request_id, ...this.errorDetails(parsed.data) });
    }
    return parsed.data;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const response = await this.fetchImpl(SNAPCHAT_TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret, refresh_token: this.refreshToken,
      }),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new AdportError('PROVIDER_ERROR', `snapchat: OAuth refresh failed (HTTP ${response.status}); re-authorize if the grant was revoked or expired`);
    const parsed = tokenSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'snapchat: malformed OAuth response');
    const token = parsed.data;
    if (token.refresh_token && token.refresh_token !== this.refreshToken) {
      this.refreshToken = token.refresh_token;
      await this.credentials.onRefreshToken?.(token.refresh_token);
    }
    this.token = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  }
}
