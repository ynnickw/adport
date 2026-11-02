import { AdportError } from '@adport/core';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Reddit requires an honest, uniquely identifying User-Agent on every request. */
  userAgent: string;
  onRefreshToken?: (refreshToken: string) => Promise<void>;
}

export const REDDIT_API_VERSION = 'v3';
export const REDDIT_API_BASE = `https://ads-api.reddit.com/api/${REDDIT_API_VERSION}`;
export const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

export interface RedditEnvelope<T> {
  data: T;
  pagination?: { next_url?: string; previous_url?: string; page_index?: number; total_count?: number };
}

/** OAuth-refreshing Reddit Ads API v3 client with exact next_url pagination. */
export class RedditAdsClient {
  private token?: TokenState;
  private refreshToken: string;
  private refreshing?: Promise<string>;

  constructor(
    private readonly credentials: RedditCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.refreshToken = credentials.refreshToken;
  }

  /** Bind account-less native async job IDs to their approved create request. */
  resourceReceipt(kind: 'post_job' | 'asset_upload', accountId: string, profileId: string, resourceId: string): string {
    for (const value of [accountId, profileId, resourceId]) if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new AdportError('PROVIDER_ERROR', 'reddit: invalid resource ID in create receipt');
    const payload = Buffer.from(JSON.stringify({ kind, account_id: accountId, profile_id: profileId, resource_id: resourceId, expires_at: Math.floor(Date.now() / 1000) + 86_400 })).toString('base64url');
    return `${payload}.${this.receiptMac(payload).toString('base64url')}`;
  }

  verifyResourceReceipt(receipt: string, kind: 'post_job' | 'asset_upload', accountId: string, resourceId: string): { profile_id: string } {
    const invalid = () => new AdportError('INVALID_INPUT', 'reddit: invalid or expired resource receipt; use the receipt returned by the approved create operation');
    if (receipt.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(receipt)) throw invalid();
    const [payload, signature] = receipt.split('.'), expected = this.receiptMac(payload!), supplied = Buffer.from(signature!, 'base64url');
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw invalid();
    let value: unknown;
    try { value = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')); } catch { throw invalid(); }
    const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (data.kind !== kind || data.account_id !== accountId || data.resource_id !== resourceId || typeof data.profile_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.profile_id) || typeof data.expires_at !== 'number' || !Number.isSafeInteger(data.expires_at) || data.expires_at <= Math.floor(Date.now() / 1000) || data.expires_at > Math.floor(Date.now() / 1000) + 86_400) throw invalid();
    return { profile_id: data.profile_id };
  }

  private receiptMac(payload: string): Buffer { return createHmac('sha256', this.credentials.clientSecret).update(`adport.reddit.resource.v1.${payload}`).digest(); }

  diagnostic(value: unknown): string | undefined { return typeof value === 'string' ? this.redact(value) : undefined; }

  async get<T>(pathOrUrl: string, params: Record<string, unknown> = {}): Promise<RedditEnvelope<T>> {
    const url = this.url(pathOrUrl, params);
    return this.send<T>(url, { method: 'GET' });
  }

  async post<T>(pathOrUrl: string, body: Record<string, unknown>): Promise<RedditEnvelope<T>> {
    return this.send<T>(this.url(pathOrUrl), { method: 'POST', body: JSON.stringify(body) });
  }

  async patch<T>(pathOrUrl: string, body: Record<string, unknown>): Promise<RedditEnvelope<T>> {
    return this.send<T>(this.url(pathOrUrl), { method: 'PATCH', body: JSON.stringify(body) });
  }

  async delete<T>(pathOrUrl: string): Promise<RedditEnvelope<T>> {
    return this.send<T>(this.url(pathOrUrl), { method: 'DELETE' });
  }

  async getPaged<T>(path: string, params: Record<string, unknown> = {}, limit = 1000): Promise<T[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'reddit: list limit must be a positive safe integer');
    const rows: T[] = [];
    let url = this.url(path, params);
    const seen = new Set<string>();
    while (true) {
      if (seen.has(url) || seen.size >= 1000) throw new AdportError('PROVIDER_ERROR', 'reddit: pagination did not terminate');
      seen.add(url);
      const page = await this.get<T[]>(url);
      if (!Array.isArray(page.data)) throw new AdportError('PROVIDER_ERROR', 'reddit: expected a native list response');
      rows.push(...page.data.slice(0, Math.max(0, limit - rows.length)));
      if (rows.length >= limit || !page.pagination?.next_url) return rows;
      url = this.nextUrl(page.pagination.next_url, url);
    }
  }

  nextUrl(next: string, current: string): string {
    const target = this.url(next), previous = this.url(current);
    if (new URL(target).pathname !== new URL(previous).pathname) throw new AdportError('PROVIDER_ERROR', 'reddit: pagination changed resource scope');
    return target;
  }

  private url(pathOrUrl: string, params: Record<string, unknown> = {}): string {
    const normalized = pathOrUrl.trim();
    const url = normalized.startsWith('https://')
      ? new URL(normalized)
      : new URL(`${REDDIT_API_BASE}/${normalized.replace(/^\/+/, '')}`);
    if (url.origin !== 'https://ads-api.reddit.com' || !url.pathname.startsWith('/api/v3/') || url.username || url.password || url.hash) {
      throw new AdportError('INVALID_INPUT', 'reddit: pagination or API URL must stay within https://ads-api.reddit.com/api/v3/');
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return url.toString();
  }

  private async send<T>(url: string, init: { method: string; body?: string }): Promise<RedditEnvelope<T>> {
    const accessToken = await this.accessToken();
    const response = await this.fetchImpl(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'user-agent': this.credentials.userAgent,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body,
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    const parsed = raw ? safeJson(raw) : response.status === 204 ? { data: {} } : undefined;
    if (!response.ok) {
      const message = this.redact(redditErrorMessage(parsed));
      throw new AdportError(
        'PROVIDER_ERROR',
        `Reddit Ads API ${response.status} ${init.method} ${new URL(url).pathname}: ${message}`,
        { http_status: response.status, api_message: message },
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'data')) throw new AdportError('PROVIDER_ERROR', 'reddit: malformed API response');
    return parsed as RedditEnvelope<T>;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.accessToken;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private redact(value: string): string {
    return [this.credentials.clientId, this.credentials.clientSecret, this.credentials.refreshToken, this.refreshToken, this.token?.accessToken, Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString('base64')].reduce<string>((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, value).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b[a-f0-9]{64}\b/gi, '[redacted hash]').replace(/([?&](?:token|sig|signature|access_token|x-amz-signature|x-goog-signature)=)[^&\s"'<>]+/gi, '$1[redacted]').slice(0, 2000);
  }

  private async refresh(): Promise<string> {
    const response = await this.fetchImpl(REDDIT_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': this.credentials.userAgent,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const raw: unknown = await response.json().catch(() => undefined);
    const data = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
      message?: string;
    };
    if (!response.ok || typeof data.access_token !== 'string' || !data.access_token || (data.expires_in !== undefined && (!Number.isFinite(data.expires_in) || data.expires_in <= 0))) {
      throw new AdportError(
        'PROVIDER_ERROR',
        `Reddit OAuth refresh failed (HTTP ${response.status}); re-authorize if the existing grant was revoked or expired`,
      );
    }
    if (typeof data.refresh_token === 'string' && data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
      await this.credentials.onRefreshToken?.(data.refresh_token);
    }
    this.token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return data.access_token;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function redditErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'provider returned an invalid error response';
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail']) if (typeof record[key] === 'string') return record[key];
  const error = record.error;
  if (error && typeof error === 'object' && !Array.isArray(error) && typeof (error as Record<string, unknown>).message === 'string') return (error as Record<string, unknown>).message as string;
  return 'provider request failed';
}
