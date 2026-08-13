import { AdportError } from '@adport/core';

export interface TikTokCredentials {
  /** Long-term access token (does not expire; revoked by the advertiser). */
  accessToken: string;
  appId?: string;
  secret?: string;
  /** Use the sandbox environment (sandbox-ads.tiktok.com). */
  sandbox?: boolean;
}

export const TIKTOK_API_VERSION = 'v1.3';
const PROD_BASE = 'https://business-api.tiktok.com/open_api';
const SANDBOX_BASE = 'https://sandbox-ads.tiktok.com/open_api';

/** Business-error codes worth a targeted hint. */
const CODE_HINTS: Record<number, string> = {
  40105: 'The access token is invalid — re-run `adport connect tiktok`.',
  40102: 'The access token expired or was revoked — re-run `adport connect tiktok`.',
  40100: 'Rate limited (app level) — back off and retry.',
  40133: 'Rate limited (advertiser level) — back off and retry.',
};

/**
 * TikTok Business API client. Peculiarities handled here:
 * - every endpoint needs a TRAILING SLASH (404 otherwise)
 * - business errors arrive as HTTP 200 with a non-zero envelope `code`
 * - array query params are JSON-encoded strings
 */
export class TikTokClient {
  readonly baseUrl: string;

  constructor(
    private readonly credentials: TikTokCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = `${credentials.sandbox ? SANDBOX_BASE : PROD_BASE}/${TIKTOK_API_VERSION}`;
  }

  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      search.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const query = search.size > 0 ? `?${search}` : '';
    return this.send<T>(`${path}${query}`, { method: 'GET' });
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.send<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  private async send<T>(pathWithQuery: string, init: { method: string; body?: string }): Promise<T> {
    // Trailing slash is mandatory before the query string.
    const [path, query] = pathWithQuery.split('?');
    const url = `${this.baseUrl}/${path!.replace(/^\/|\/$/g, '')}/${query ? `?${query}` : ''}`;
    const response = await this.fetchImpl(url, {
      method: init.method,
      headers: {
        'Access-Token': this.credentials.accessToken,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new AdportError('PROVIDER_ERROR', `TikTok API HTTP ${response.status} for ${path} (check method and trailing slash)`, raw);
    }
    const envelope = JSON.parse(raw) as { code: number; message: string; request_id?: string; data?: T };
    if (envelope.code !== 0) {
      const hint = CODE_HINTS[envelope.code];
      throw new AdportError(
        'PROVIDER_ERROR',
        `TikTok API error ${envelope.code}: ${envelope.message}${hint ? `\n  ${hint}` : ''}` +
          (envelope.request_id ? ` [request_id: ${envelope.request_id}]` : ''),
        envelope,
      );
    }
    return (envelope.data ?? {}) as T;
  }
}
