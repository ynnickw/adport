import { AdportError } from '@adport/core';
import { createClientSecret } from './jwt.js';

export interface AppleCredentials {
  clientId: string;
  teamId: string;
  keyId: string;
  /** PEM contents of the .p8 EC private key. */
  privateKeyPem: string;
  /** Delegated service-provider grant. Omit for a self-managed API user. */
  refreshToken?: string;
}

const TOKEN_URL = 'https://appleid.apple.com/auth/oauth2/token';

/** Apple Ads Platform API v1. The legacy Campaign Management API v5 retires 2027-01-26. */
export const APPLE_ADS_BASE = 'https://api.ads.apple.com/v1';

export interface AppleEnvelope<T> {
  result: T;
  pagination?: { offset?: number; pageSize?: number; totalCount?: number } | null;
  error?: {
    code?: string;
    message?: string;
    details?: Array<{ code?: string; message?: string }>;
  } | null;
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
    // Mint a fresh short-lived client secret per request — no stored client-secret rotation.
    const clientSecret = createClientSecret(this.credentials);
    const tokenParams = new URLSearchParams(this.credentials.refreshToken
      ? {
          grant_type: 'refresh_token',
          client_id: this.credentials.clientId,
          client_secret: clientSecret,
          refresh_token: this.credentials.refreshToken,
        }
      : {
          grant_type: 'client_credentials',
          client_id: this.credentials.clientId,
          client_secret: clientSecret,
          scope: 'searchadsorg',
        });
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenParams,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new AdportError(
        'PROVIDER_ERROR',
        `Apple Ads OAuth failed (${response.status}). Check the client identity, uploaded public key, and delegated account access.`,
        safeJson(raw),
      );
    }
    const data = JSON.parse(raw) as { access_token: string; expires_in: number };
    this.accessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return this.accessToken.token;
  }

  /** adAccountId context is required on account-scoped endpoints. */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { adAccountId?: string; body?: unknown; form?: FormData } = {},
  ): Promise<AppleEnvelope<T>> {
    const token = await this.getAccessToken();
    if (options.body !== undefined && options.form !== undefined) {
      throw new AdportError('INVALID_INPUT', 'Apple Ads request cannot contain both JSON and multipart bodies');
    }
    const response = await this.fetchImpl(`${APPLE_ADS_BASE}/${path.replace(/^\//, '')}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(options.adAccountId ? { 'X-AP-Context': `adAccountId=${options.adAccountId}` } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new AdportError('PROVIDER_ERROR', formatAppleError(response.status, raw), safeJson(raw));
    }
    return (raw ? JSON.parse(raw) : { result: undefined }) as AppleEnvelope<T>;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** v1 error shape: {"error":{"code","message","details":[{"code","message"}]}}. */
export function formatAppleError(status: number, raw: string): string {
  const parsed = safeJson(raw) as {
    error?: { code?: string; message?: string; details?: Array<{ code?: string; message?: string }> };
  };
  const head = `Apple Ads API error (HTTP ${status})`;
  const error = parsed?.error;
  if (!error) return head;
  const lines = [
    error.code || error.message ? `${error.code ?? '?'}: ${error.message ?? ''}` : undefined,
    ...(error.details ?? []).map((detail) => `${detail.code ?? '?'}: ${detail.message ?? ''}`),
  ].filter((line): line is string => Boolean(line));
  const hint = status === 401 ? '\n  Token or ad-account access problem — check credentials and account roles.' : '';
  return lines.length > 0 ? `${head}\n  ${lines.join('\n  ')}${hint}` : `${head}${hint}`;
}
