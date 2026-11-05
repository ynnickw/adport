import { AdportError } from '@adport/core';

export interface GtmCredentials { clientId: string; clientSecret: string; refreshToken: string }
export type GtmResource = Record<string, unknown>;
export const GTM_API_BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';
const resourcePaths = [
  /^accounts$/,
  /^accounts\/\d+\/containers$/,
  /^accounts\/\d+\/containers\/\d+(?::snippet)?$/,
  /^accounts\/\d+\/containers\/\d+\/workspaces$/,
  /^accounts\/\d+\/containers\/\d+\/workspaces\/\d+(?:\/status|:create_version)?$/,
  /^accounts\/\d+\/containers\/\d+\/workspaces\/\d+\/(?:tags|triggers|variables)(?:\/\d+)?$/,
  /^accounts\/\d+\/containers\/\d+\/version_headers$/,
  /^accounts\/\d+\/containers\/\d+\/versions:live$/,
  /^accounts\/\d+\/containers\/\d+\/versions\/\d+(?::publish)?$/,
];

/** Fixed-origin REST client. Paths are constructed from validated numeric IDs, never caller URLs. */
export class GtmClient {
  private accessToken?: { token: string; expiresAt: number };
  constructor(private readonly credentials: GtmCredentials, private readonly fetchImpl: typeof fetch = fetch) {}

  async request(path: string, method = 'GET', body?: unknown, query: Record<string, string> = {}): Promise<GtmResource> {
    if (!resourcePaths.some(pattern => pattern.test(path))) {
      throw new AdportError('INVALID_INPUT', 'Invalid Google Tag Manager resource path.');
    }
    if (!this.accessToken || this.accessToken.expiresAt <= Date.now()) {
      const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret,
          refresh_token: this.credentials.refreshToken, grant_type: 'refresh_token' }),
      });
      const token = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
      if (!response.ok || !token.access_token) throw new AdportError('PROVIDER_ERROR', 'Google Tag Manager authorization expired or was revoked. Reconnect GTM.');
      this.accessToken = { token: token.access_token, expiresAt: Date.now() + (Number(token.expires_in ?? 3600) - 60) * 1000 };
    }
    const params = new URLSearchParams(query);
    const response = await this.fetchImpl(`${GTM_API_BASE}/${path}${params.size ? `?${params}` : ''}`, {
      method, redirect: 'error', headers: { authorization: `Bearer ${this.accessToken.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({})) as GtmResource;
    // Upstream response bodies may contain custom code or private configuration.
    if (!response.ok) throw new AdportError('PROVIDER_ERROR', `Google Tag Manager API request failed (HTTP ${response.status}). Check GTM permissions, API enablement and the requested resource.`, { status: response.status });
    return result;
  }
}
