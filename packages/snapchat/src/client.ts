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
  const parsed = tokenSchema.safeParse(await response.json());
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

  async mutate<T>(path: string, method: 'POST' | 'PATCH', body: unknown, plural: string, singular: string, schema: z.ZodType<T>): Promise<T[]> {
    const data = await this.send(this.url(path), method, body);
    return this.items(data, plural, singular, schema);
  }

  private items<T>(data: z.infer<typeof envelopeSchema>, plural: string, singular: string, schema: z.ZodType<T>): T[] {
    const items = z.array(z.looseObject({ sub_request_status: z.string() })).safeParse(data[plural]);
    if (!items.success) throw new AdportError('PROVIDER_ERROR', `snapchat: malformed ${plural} response`);
    return items.data.map(item => {
      if (!success(item.sub_request_status)) {
        throw new AdportError('PROVIDER_ERROR', `snapchat: ${singular} sub-request failed`, { requestId: data.request_id });
      }
      const parsed = schema.safeParse(item[singular]);
      if (!parsed.success) throw new AdportError('PROVIDER_ERROR', `snapchat: malformed ${singular} response`);
      return parsed.data;
    });
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

  private async send(url: URL, method: 'GET' | 'POST' | 'PATCH', body?: unknown, retry = true): Promise<z.infer<typeof envelopeSchema>> {
    const token = await this.accessToken();
    const response = await this.fetchImpl(url.href, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': method === 'PATCH' ? 'application/json-patch+json' : 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 && method === 'GET' && retry) {
      if (this.token?.value === token) this.token = undefined;
      return this.send(url, method, body, false);
    }
    if (!response.ok) {
      const advice = response.status === 403 ? ' Check app approval and the user’s ad-account permissions; reconnecting alone may not resolve this.' : '';
      throw new AdportError('PROVIDER_ERROR', `snapchat: HTTP ${response.status}.${advice}`);
    }
    const parsed = envelopeSchema.safeParse(await response.json());
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'snapchat: malformed API envelope');
    if (!success(parsed.data.request_status)) {
      throw new AdportError('PROVIDER_ERROR', 'snapchat: API request failed', { requestId: parsed.data.request_id });
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
    const parsed = tokenSchema.safeParse(await response.json());
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
