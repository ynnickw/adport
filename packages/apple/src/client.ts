import { AdportError } from '@adport/core';
import { createClientSecret } from './jwt.js';

export interface AppleCredentials {
  clientId: string;
  teamId: string;
  keyId: string;
  /** PEM contents of the .p8 EC private key. */
  privateKeyPem: string;
}

const TOKEN_URL = 'https://appleid.apple.com/auth/oauth2/token';

/**
 * VERSION ISOLATION: everything version-specific lives in these constants and
 * the envelope helpers. The Campaign Management API v5 sunsets 2027-01-26; the
 * successor "Apple Ads Platform API" (v1, preview July 2026) changes, per
 * Apple's preview guide: base URL → https://api.ads.apple.com/v1, envelope
 * `data` → `result`, X-AP-Context orgId= → adAccountId=, GET-all//find →
 * POST /{entity}/query, error shape → {error:{code,message,details[]}}.
 * Migrate here when the Platform API reference goes live.
 */
export const APPLE_ADS_BASE = 'https://api.searchads.apple.com/api/v5';

export interface AppleEnvelope<T> {
  data: T;
  pagination?: { totalResults: number; startIndex: number; itemsPerPage: number } | null;
  error?: { errors?: Array<{ messageCode?: string; message?: string; field?: string }> } | null;
}

export class AppleAdsClient {
  private accessToken?: { token: string; expiresAt: number };

  constructor(
    private readonly credentials: AppleCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.token;
    }
    // Mint a fresh short-lived client secret per request — no 180-day rotation to manage.
    const clientSecret = createClientSecret(this.credentials);
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.credentials.clientId,
        client_secret: clientSecret,
        scope: 'searchadsorg',
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new AdportError(
        'PROVIDER_ERROR',
        `Apple Ads OAuth failed (${response.status}). Check clientId/teamId/keyId and that the public key is uploaded in Account Settings > API.`,
        safeJson(raw),
      );
    }
    const data = JSON.parse(raw) as { access_token: string; expires_in: number };
    this.accessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return this.accessToken.token;
  }

  /** orgId (as X-AP-Context) is required on all endpoints except /acls and /me. */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options: { orgId?: string; body?: unknown } = {},
  ): Promise<AppleEnvelope<T>> {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(`${APPLE_ADS_BASE}/${path.replace(/^\//, '')}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.orgId ? { 'X-AP-Context': `orgId=${options.orgId}` } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new AdportError('PROVIDER_ERROR', formatAppleError(response.status, raw), safeJson(raw));
    }
    return (raw ? JSON.parse(raw) : { data: undefined }) as AppleEnvelope<T>;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** v5 error shape: {"error": {"errors": [{"messageCode", "message", "field"}]}} */
export function formatAppleError(status: number, raw: string): string {
  const parsed = safeJson(raw) as {
    error?: { errors?: Array<{ messageCode?: string; message?: string; field?: string }> };
  };
  const items = parsed?.error?.errors ?? [];
  const head = `Apple Ads API error (HTTP ${status})`;
  if (items.length === 0) return head;
  const lines = items.map(
    (e) => `${e.messageCode ?? '?'}: ${e.message ?? ''}${e.field && e.field !== 'null' ? ` (field: ${e.field})` : ''}`,
  );
  const hint = status === 401 ? '\n  Token or org access problem — check credentials and org roles.' : '';
  return `${head}\n  ${lines.join('\n  ')}${hint}`;
}
