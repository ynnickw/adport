import { AdportError, normalizeMatomoUrl } from '@adport/core';

export interface MatomoCredentials {
  /** Instance base URL, e.g. https://example.matomo.cloud or https://analytics.example.com/matomo. */
  url: string;
  /** Personal auth token of a user with view access to the sites. */
  tokenAuth: string;
}

/** Documented read methods only. Every other Matomo API method is refused before any request. */
export const MATOMO_READ_METHODS = new Set([
  'API.getMatomoVersion', 'API.getReportMetadata', 'API.getProcessedReport',
  'SitesManager.getSitesWithAtLeastViewAccess', 'SitesManager.getSiteFromId',
  'Goals.getGoals', 'SegmentEditor.getAll',
]);
const RESERVED = new Set(['module', 'method', 'format', 'token_auth', 'force_api_session']);

/**
 * Matomo Reporting API over POST so token_auth never appears in a URL. Matomo
 * answers most failures with HTTP 200 and {"result":"error"}; messages are
 * classified but never echoed, since they can contain instance details.
 */
export class MatomoClient {
  readonly baseUrl: string;
  constructor(private readonly credentials: MatomoCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = normalizeMatomoUrl(credentials.url);
    if (!credentials.tokenAuth.trim()) throw new AdportError('INVALID_INPUT', 'matomo: token_auth is empty');
  }

  async call(method: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!MATOMO_READ_METHODS.has(method)) throw new AdportError('INVALID_INPUT', 'Unsupported Matomo read method.');
    if (Object.keys(params).some(key => RESERVED.has(key))) throw new AdportError('INVALID_INPUT', 'Reserved Matomo request parameter.');
    const body = new URLSearchParams({ ...params, module: 'API', method, format: 'JSON', token_auth: this.credentials.tokenAuth.trim() });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/index.php`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body,
      });
    } catch {
      throw new AdportError('PROVIDER_ERROR', 'Matomo could not be reached (network error, redirect or timeout). Check MATOMO_URL.');
    }
    if (response.status === 401) throw new AdportError('NOT_CONNECTED', 'Matomo rejected the auth token. Create a new token and reconnect Matomo.');
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
    return new AdportError('NOT_CONNECTED', 'Matomo rejected the auth token. Create a new token and reconnect Matomo.', { reason: 'auth' });
  }
  // Before access: "not enough permission to access the segment X" is a segment problem, not a bad token.
  if (/segment/i.test(message)) return new AdportError('PROVIDER_ERROR', 'Matomo rejected the segment. Check its syntax, permissions or use matomo_segments.', { reason: 'segment' });
  if (/access|permission|not allowed/i.test(message)) {
    return new AdportError('PROVIDER_ERROR', 'Matomo denied access: the token is invalid or its user lacks view access to this site.', { reason: 'access_denied' });
  }
  if (/report|not found|does not exist|unknown/i.test(message) && method === 'API.getProcessedReport') {
    return new AdportError('PROVIDER_ERROR', 'Matomo could not find this report. Use matomo_report_metadata to choose module and action.', { reason: 'report_not_found' });
  }
  if (/date|period/i.test(message)) return new AdportError('PROVIDER_ERROR', 'Matomo rejected the date or period.', { reason: 'date' });
  return new AdportError('PROVIDER_ERROR', `Matomo returned an error for ${method}. Check the site ID and parameters.`, { reason: 'provider' });
}
