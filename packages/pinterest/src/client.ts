import { AdportError } from '@adport/core';
import { z } from 'zod';

export const PINTEREST_API_BASE = 'https://api.pinterest.com/v5/';
export const PINTEREST_TOKEN_URL = `${PINTEREST_API_BASE}oauth/token`;
export interface PinterestCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  onRefreshToken?: (refreshToken: string) => Promise<void>;
}
const tokenSchema = z.object({
  access_token: z.string().min(1), expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
});

export function buildPinterestAuthUrl(clientId: string, redirectUri: string, state: string): string {
  return `https://www.pinterest.com/oauth/?${new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, state, scope: 'ads:read,ads:write',
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

export async function exchangePinterestCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = await tokenRequest(input, new URLSearchParams({
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, continuous_refresh: 'true',
  }), fetchImpl);
  if (!token.refresh_token) throw new AdportError('PROVIDER_ERROR', 'pinterest: OAuth exchange did not return a refresh token');
  return token.refresh_token;
}

export class PinterestAdsClient {
  private token?: { value: string; expiresAt: number };
  private refreshToken: string;
  private refreshing?: Promise<string>;
  constructor(private readonly credentials: PinterestCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    this.refreshToken = credentials.refreshToken;
  }
  async get<T>(path: string, schema: z.ZodType<T>, params = new URLSearchParams()): Promise<T> {
    return this.request(path, 'GET', schema, undefined, params);
  }
  async mutate<T>(path: string, method: 'POST' | 'PATCH', body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.request(path, method, schema, body);
  }
  private async request<T>(path: string, method: 'GET' | 'POST' | 'PATCH', schema: z.ZodType<T>, body?: unknown, params = new URLSearchParams(), retry = true): Promise<T> {
    if (!/^[a-z_]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) throw new AdportError('INVALID_INPUT', 'pinterest: invalid API resource path');
    const url = new URL(path, PINTEREST_API_BASE);
    url.search = params.toString();
    const token = await this.accessToken();
    const response = await this.fetchImpl(url.href, {
      method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 && method === 'GET' && retry) {
      if (this.token?.value === token) this.token = undefined;
      return this.request(path, method, schema, body, params, false);
    }
    if (!response.ok) {
      const advice = response.status === 403 ? ' Check app Trial/Standard access, ads scopes and ad-account permissions; reauthorization alone may not help.' : '';
      throw new AdportError('PROVIDER_ERROR', `pinterest: HTTP ${response.status}.${advice}`);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'pinterest: malformed API response');
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
