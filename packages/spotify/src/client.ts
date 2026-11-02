import { AdportError } from '@adport/core';
import { z } from 'zod';

export const SPOTIFY_API_BASE = 'https://api-partner.spotify.com/ads/v3/';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  onRefreshToken?: (refreshToken: string) => Promise<void>;
}
const tokenSchema = z.object({
  access_token: z.string().min(1), expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
});

export function buildSpotifyAuthUrl(clientId: string, redirectUri: string, state: string): string {
  // Ads API access is granted to the app, not through Web API music scopes.
  return `https://accounts.spotify.com/authorize/?${new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, state,
  })}`;
}

async function tokenRequest(credentials: Pick<SpotifyCredentials, 'clientId' | 'clientSecret'>, body: URLSearchParams, fetchImpl: typeof fetch) {
  const response = await fetchImpl(SPOTIFY_TOKEN_URL, {
    method: 'POST', headers: {
      authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    }, body, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new AdportError('PROVIDER_ERROR', `spotify: OAuth ${body.get('grant_type')} failed (HTTP ${response.status})`);
  const parsed = tokenSchema.safeParse(await response.json());
  if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'spotify: malformed OAuth response');
  return parsed.data;
}

export async function exchangeSpotifyCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = await tokenRequest(input, new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri }), fetchImpl);
  if (!token.refresh_token) throw new AdportError('PROVIDER_ERROR', 'spotify: OAuth exchange did not return a refresh token');
  return token.refresh_token;
}

export class SpotifyAdsClient {
  private token?: { value: string; expiresAt: number };
  private refreshToken: string;
  private refreshing?: Promise<string>;
  constructor(private readonly credentials: SpotifyCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    this.refreshToken = credentials.refreshToken;
  }

  async get<T>(path: string, schema: z.ZodType<T>, params = new URLSearchParams()): Promise<T> {
    return this.request(path, 'GET', schema, undefined, params);
  }
  async mutate<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown, schema: z.ZodType<T>, params = new URLSearchParams()): Promise<T> {
    return this.request(path, method, schema, body, params);
  }
  async upload<T>(path: string, body: FormData, schema: z.ZodType<T>): Promise<T> {
    return this.request(path, 'POST', schema, body);
  }

  private async request<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', schema: z.ZodType<T>, body?: unknown, params = new URLSearchParams(), retry = true): Promise<T> {
    // Resource paths are built from schema-checked IDs. Reject foreign URLs,
    // absolute paths, queries and dot segments before sending any credentials.
    if (!/^[a-z_]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) throw new AdportError('INVALID_INPUT', 'spotify: invalid API resource path');
    const url = new URL(path, SPOTIFY_API_BASE);
    url.search = params.toString();
    const token = await this.accessToken();
    const response = await this.fetchImpl(url.href, {
      method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 401 && method === 'GET' && retry) {
      if (this.token?.value === token) this.token = undefined;
      return this.request(path, method, schema, body, params, false);
    }
    if (!response.ok) {
      const advice = response.status === 403 ? ' Check Ads API terms/allowlisting and ad-account permissions; reauthorization alone may not help.' : '';
      const details: Record<string, unknown> = { http_status: response.status };
      if ([400, 404, 409, 422].includes(response.status)) {
        const errors = z.object({ messages: z.array(z.string().max(2000)).max(30).optional(), sp_trace_id: z.uuid().optional(), error_codes: z.array(z.object({ code: z.string().max(200), definition: z.string().max(2000).optional() })).max(30).optional() });
        const parsed = errors.safeParse(await response.json().catch(() => undefined));
        if (parsed.success) {
          const redact = (value: string) => [this.credentials.clientId, this.credentials.clientSecret, this.credentials.refreshToken, this.refreshToken, token].reduce((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, value);
          if (parsed.data.messages) details.messages = parsed.data.messages.map(redact);
          if (parsed.data.sp_trace_id) details.sp_trace_id = parsed.data.sp_trace_id;
          if (parsed.data.error_codes) details.error_codes = parsed.data.error_codes.map(error => ({ code: redact(error.code), ...(error.definition ? { definition: redact(error.definition) } : {}) }));
        }
      }
      const messages = Array.isArray(details.messages) ? ` ${details.messages.join('; ')}` : '';
      throw new AdportError('PROVIDER_ERROR', `spotify: HTTP ${response.status}.${advice}${messages}`, details);
    }
    const parsed = schema.safeParse(response.status === 204 ? undefined : await response.json());
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'spotify: malformed API response', { api_path: path, response_issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) });
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
    this.token = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  }
}
