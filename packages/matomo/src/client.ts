import { AdportError, normalizeMatomoUrl } from '@adport/core';

type MatomoFetch = (url: string, init: {
  method: 'POST'; redirect: 'error'; signal: AbortSignal; headers: Record<string, string>; body: URLSearchParams;
}) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

export interface MatomoCredentials {
  /** Instance base URL, e.g. https://example.matomo.cloud or https://analytics.example.com/matomo. */
  url: string;
  /** Personal auth token of a user with view access to the sites. */
  tokenAuth: string;
}

export interface MatomoBearerCredentials {
  url: string;
  accessToken(): Promise<string>;
}

/** Documented read methods only. Every other Matomo API method is refused before any request. */
export const MATOMO_READ_METHODS = new Set([
  'API.getReportMetadata', 'SitesManager.getSitesWithAtLeastViewAccess', 'SitesManager.getSiteFromId', 'Goals.getGoals',
  'Referrers.getReferrerType', 'Referrers.getCampaigns', 'MarketingCampaignsReporting.getName',
  'MarketingCampaignsReporting.getSource', 'MarketingCampaignsReporting.getMedium', 'MarketingCampaignsReporting.getSourceMedium', 'Actions.getEntryPageUrls',
]);
const RESERVED = new Set(['module', 'method', 'format', 'token_auth', 'force_api_session']);

/**
 * Matomo Reporting API over POST so token_auth never appears in a URL. Matomo
 * answers most failures with HTTP 200 and {"result":"error"}; messages are
 * classified but never echoed, since they can contain instance details.
 */
export class MatomoClient {
  readonly baseUrl: string;
  constructor(private readonly credentials: MatomoCredentials | MatomoBearerCredentials, private readonly fetchImpl: MatomoFetch = fetch) {
    this.baseUrl = normalizeMatomoUrl(credentials.url);
    if ('tokenAuth' in credentials && !credentials.tokenAuth.trim()) throw new AdportError('INVALID_INPUT', 'matomo: token_auth is empty');
  }

  async call(method: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!MATOMO_READ_METHODS.has(method)) throw new AdportError('INVALID_INPUT', 'Unsupported Matomo read method.');
    if (Object.keys(params).some(key => RESERVED.has(key))) throw new AdportError('INVALID_INPUT', 'Reserved Matomo request parameter.');
    const body = new URLSearchParams({ ...params, module: 'API', method, format: 'JSON' });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if ('accessToken' in this.credentials) headers.authorization = 'Bearer ' + await this.credentials.accessToken();
    else body.set('token_auth', this.credentials.tokenAuth.trim());
    let response: Awaited<ReturnType<MatomoFetch>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/index.php`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers, body,
      });
    } catch {
      throw new AdportError('PROVIDER_ERROR', 'Matomo could not be reached (network error, redirect or timeout). Check MATOMO_URL.');
    }
    if (response.status === 401) throw new AdportError('NOT_CONNECTED', 'Matomo rejected the auth token. Reconnect Matomo to renew access.');
    if (!response.ok) throw new AdportError('PROVIDER_ERROR', `Matomo read failed (HTTP ${response.status}).`, { status: response.status });
    let data: unknown;
    try { data = JSON.parse(await response.text()); }
    catch { throw new AdportError('PROVIDER_ERROR', 'Matomo returned a non-JSON response. Check that MATOMO_URL points to the Matomo instance, not a login page or proxy.'); }
    if (data && typeof data === 'object' && !Array.isArray(data) && (data as Record<string, unknown>).result === 'error') {
      throw classify(String((data as Record<string, unknown>).message ?? ''), method);
    }
    return data;
  }
}

function classify(message: string, method: string): AdportError {
  const authFailure = /\b(?:unable to authenticate|authentication (?:failed|required)|not logged in|(?:must|please|need to) (?:log in|login))\b/i;
  const badToken = /\btoken_auth\b.{0,60}\b(?:invalid|not valid|expired|missing)|\b(?:invalid|expired|missing) (?:authentication token|token_auth)\b/i;
  if (authFailure.test(message) || badToken.test(message)) {
    return new AdportError('NOT_CONNECTED', 'Matomo rejected the auth token. Reconnect Matomo to renew access.', { reason: 'auth' });
  }
  // Before access: "not enough permission to access the segment X" is a segment problem, not a bad token.
  if (/segment/i.test(message)) return new AdportError('PROVIDER_ERROR', 'Matomo rejected the segment. This site must support aggregate entry-page segmentation to group by landing page.', { reason: 'segment' });
  if (/access|permission|not allowed/i.test(message)) {
    return new AdportError('PROVIDER_ERROR', 'Matomo denied access: the token is invalid or its user lacks view access to this site.', { reason: 'access_denied' });
  }
  if (/date|period/i.test(message)) return new AdportError('PROVIDER_ERROR', 'Matomo rejected the date or period.', { reason: 'date' });
  return new AdportError('PROVIDER_ERROR', `Matomo returned an error for ${method}. Check the site ID and parameters.`, { reason: 'provider' });
}
