import { AdportError } from '@adport/core';

export interface AnalyticsCredentials { clientId: string; clientSecret: string; refreshToken: string }
export type Resource = Record<string, unknown>;
const services = {
  admin: { origin: 'https://analyticsadmin.googleapis.com/v1beta/', get: /^(?:accountSummaries|properties\/\d+)$/, post: /^$/ },
  data: { origin: 'https://analyticsdata.googleapis.com/v1beta/', get: /^properties\/\d+\/metadata$/, post: /^properties\/\d+:(?:runReport|runRealtimeReport)$/ },
  search: { origin: 'https://www.googleapis.com/webmasters/v3/', get: /^sites(?:\/[^/]+(?:\/sitemaps)?)?$/, post: /^sites\/[^/]+\/searchAnalytics\/query$/ },
  inspection: { origin: 'https://searchconsole.googleapis.com/v1/', get: /^$/, post: /^urlInspection\/index:inspect$/ },
} as const;

/** Only documented read endpoints are reachable, including POST-based reporting queries. */
export class AnalyticsClient {
  private token?: { value: string; until: number };
  constructor(private readonly credentials: AnalyticsCredentials, private readonly fetchImpl: typeof fetch = fetch) {}
  async request(service: keyof typeof services, path: string, body?: unknown, query: Record<string, string> = {}): Promise<Resource> {
    const api = services[service];
    if (!(body === undefined ? api.get : api.post).test(path) || !path) throw new AdportError('INVALID_INPUT', 'Unsupported analytics read endpoint.');
    if (!this.token || this.token.until <= Date.now()) {
      const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret,
          refresh_token: this.credentials.refreshToken, grant_type: 'refresh_token' }),
      });
      const token = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
      if (!response.ok || typeof token.access_token !== 'string' || !token.access_token) throw new AdportError('NOT_CONNECTED', 'Google analytics authorization expired or was revoked. Reconnect this analytics source.');
      this.token = { value: token.access_token, until: Date.now() + Math.max(0, Number(token.expires_in ?? 3600) - 60) * 1000 };
    }
    const params = new URLSearchParams(query);
    const response = await this.fetchImpl(`${api.origin}${path}${params.size ? `?${params}` : ''}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${this.token.value}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({})) as Resource;
    if (response.status === 401) throw new AdportError('NOT_CONNECTED', 'Google analytics authorization is no longer valid. Reconnect this analytics source.');
    if (!response.ok) throw new AdportError('PROVIDER_ERROR', `Google analytics read failed (HTTP ${response.status}). Check API enablement, property access and requested fields.`, { status: response.status });
    return result;
  }
}
