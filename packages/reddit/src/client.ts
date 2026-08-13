import { AdportError } from '@adport/core';

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

  constructor(
    private readonly credentials: RedditCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.refreshToken = credentials.refreshToken;
  }

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
    const rows: T[] = [];
    let page = await this.get<T[]>(path, params);
    while (true) {
      rows.push(...page.data.slice(0, Math.max(0, limit - rows.length)));
      if (rows.length >= limit || !page.pagination?.next_url) return rows;
      page = await this.get<T[]>(page.pagination.next_url);
    }
  }

  private url(pathOrUrl: string, params: Record<string, unknown> = {}): string {
    const normalized = pathOrUrl.trim();
    const url = normalized.startsWith('https://')
      ? new URL(normalized)
      : new URL(`${REDDIT_API_BASE}/${normalized.replace(/^\/+/, '')}`);
    if (url.origin !== 'https://ads-api.reddit.com' || !url.pathname.startsWith('/api/v3/')) {
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
    });
    const raw = await response.text();
    const parsed = raw ? safeJson(raw) : { data: {} };
    if (!response.ok) {
      throw new AdportError(
        'PROVIDER_ERROR',
        `Reddit Ads API ${response.status} ${init.method} ${new URL(url).pathname}: ${redditErrorMessage(parsed)}`,
        parsed,
      );
    }
    return parsed as RedditEnvelope<T>;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.accessToken;
    const response = await this.fetchImpl(REDDIT_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': this.credentials.userAgent,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
    });
    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
      message?: string;
    };
    if (!response.ok || !data.access_token) {
      throw new AdportError(
        'PROVIDER_ERROR',
        `Reddit OAuth refresh failed${data.error ? ` (${data.error})` : ''}: ${data.message ?? 'no access token returned'}`,
        data,
      );
    }
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
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
    return { message: raw };
  }
}

function redditErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  return String(record.message ?? record.error ?? record.detail ?? 'unknown provider error');
}
