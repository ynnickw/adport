import { AdportError } from '@adport/core';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const GOOGLE_DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager';
export const isDataManagerFieldPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^(?:events|destinations|consent|encoding|encryptionInfo)(?:\[\d+\])?(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\d+\])?)*$/.test(value);

/**
 * Matches the google-ads.yaml naming conventions so credentials translate 1:1.
 */
export interface GoogleCredentials {
  /** @deprecated Ignored. API access belongs to the OAuth client's Cloud project. */
  developerToken?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Manager (MCC) customer id, digits only. */
  loginCustomerId?: string;
  /** Per-operating-customer manager ids for multi-manager hosted runtimes. */
  loginCustomerIds?: Record<string, string>;
}

export interface SearchOptions {
  /** Stop after this many rows. */
  maxRows?: number;
  /** Override the manager context for this search; null explicitly omits it. */
  loginCustomerId?: string | null;
  /** Explicitly include native in-design experiment campaigns and their children. */
  includeDrafts?: boolean;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://googleads.googleapis.com';
// Matches the API version the reference implementation pinned; bump deliberately.
export const DEFAULT_API_VERSION = 'v25';

export function normalizeCustomerId(id: string): string {
  const normalized = id.replace(/^customers\//, '').replace(/-/g, '').trim();
  if (!/^\d{10}$/.test(normalized)) {
    throw new AdportError('INVALID_INPUT', `"${id}" is not a valid Google Ads customer id (expected 10 digits).`);
  }
  return normalized;
}

/**
 * Minimal Google Ads REST client: OAuth token refresh + search + mutate.
 * Deliberately dependency-free — the REST interface is stable and we control
 * exactly what goes over the wire.
 */
export class GoogleAdsRestClient {
  private accessToken?: { token: string; expiresAt: number; scopes?: string[] };

  constructor(
    private readonly credentials: GoogleCredentials,
    private readonly version: string = process.env.GOOGLE_ADS_API_VERSION ?? DEFAULT_API_VERSION,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  setLoginCustomerId(customerId: string, loginCustomerId: string): void {
    (this.credentials.loginCustomerIds ??= {})[normalizeCustomerId(customerId)] = normalizeCustomerId(loginCustomerId);
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.token;
    }
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new AdportError(
        'PROVIDER_ERROR',
        `Google OAuth token refresh failed (${response.status}). Re-run \`adport connect google\` if the refresh token was revoked.`,
        safeJson(body),
      );
    }
    const data = (await response.json()) as { access_token: string; expires_in: number; scope?: string };
    this.accessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000, ...(typeof data.scope === 'string' ? { scopes: data.scope.split(/\s+/).filter(Boolean) } : {}) };
    return this.accessToken.token;
  }

  dataManagerLoginAccount(customerId: string): string {
    const account = normalizeCustomerId(customerId);
    return normalizeCustomerId(this.credentials.loginCustomerIds?.[account] ?? this.credentials.loginCustomerId ?? account);
  }

  async dataManagerAccess() {
    await this.getAccessToken();
    const scopes = this.accessToken?.scopes;
    return { required_scope: GOOGLE_DATA_MANAGER_SCOPE, scope_status: scopes ? scopes.includes(GOOGLE_DATA_MANAGER_SCOPE) ? 'GRANTED' as const : 'MISSING' as const : 'UNKNOWN' as const };
  }

  private dataManagerReceiptKey(): Buffer {
    return createHmac('sha256', this.credentials.clientSecret).update('adport.google.datamanager.v1\0').update(this.credentials.clientId).update('\0').update(this.credentials.refreshToken).digest();
  }

  dataManagerReceipt(value: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', this.dataManagerReceiptKey()).update(payload).digest('base64url')}`;
  }

  verifyDataManagerReceipt(receipt: string): unknown {
    const invalid = () => new AdportError('INVALID_INPUT', 'google: invalid Data Manager receipt; use the receipt from the approved ingestion');
    if (receipt.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(receipt)) throw invalid();
    const [payload, signature] = receipt.split('.'), expected = createHmac('sha256', this.dataManagerReceiptKey()).update(payload!).digest(), supplied = Buffer.from(signature!, 'base64url');
    if (supplied.toString('base64url') !== signature || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw invalid();
    try { return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')); } catch { throw invalid(); }
  }

  async dataManagerRequest(method: 'ingest' | 'status', input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method !== 'ingest' && method !== 'status') throw new AdportError('INVALID_INPUT', 'google: unsupported Data Manager route');
    const access = await this.dataManagerAccess();
    if (access.scope_status === 'MISSING') throw new AdportError('NOT_CONNECTED', 'google: the existing OAuth grant does not include Data Manager. Reauthorize explicitly with the datamanager scope; existing Ads access is unchanged.', access);
    const token = await this.getAccessToken(), url = new URL(`https://datamanager.googleapis.com/v1/${method === 'ingest' ? 'events:ingest' : 'requestStatus:retrieve'}`);
    if (method === 'status') url.searchParams.set('requestId', String(input.requestId));
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: method === 'ingest' ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'ingest' ? { body: JSON.stringify(input) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch { throw new AdportError('PROVIDER_ERROR', 'google: Data Manager response was not confirmed; the request was not retried. Reconcile an ingestion before sending it again.'); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new AdportError('PROVIDER_ERROR', 'google: invalid Data Manager response; do not assume ingestion or retry automatically'); }
    if (!response.ok) {
      const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const error = object(object(body).error), details = Array.isArray(error.details) ? error.details.map(object) : [];
      // Native descriptions may echo identifiers. Keep only enum codes and field paths.
      const reasons = details.flatMap(value => typeof value.reason === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value.reason) ? [value.reason] : []).slice(0, 30);
      const fields = details.flatMap(value => Array.isArray(value.fieldViolations) ? value.fieldViolations.map(object).flatMap(item => isDataManagerFieldPath(item.field) ? [item.field] : []) : []).slice(0, 100);
      const status = typeof error.status === 'string' && /^[A-Z_]{1,64}$/.test(error.status) ? error.status : 'UNKNOWN';
      throw new AdportError('PROVIDER_ERROR', `google: Data Manager rejected the request (HTTP ${response.status}; ${status}${reasons.length ? `; ${reasons.join(', ')}` : ''}). No automatic retry.`, { http_status: response.status, status, reasons, fields });
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AdportError('PROVIDER_ERROR', 'google: invalid Data Manager response object');
    return body as Record<string, unknown>;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; loginCustomerId?: string | null },
  ): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const operatingCustomerId = path.match(/^customers\/(\d{10})(?:\/|:)/)?.[1];
    const mappedLoginCustomerId = operatingCustomerId
      ? this.credentials.loginCustomerIds?.[operatingCustomerId]
      : undefined;
    const loginCustomerId = init.loginCustomerId === null
      ? undefined
      : init.loginCustomerId ?? mappedLoginCustomerId ?? this.credentials.loginCustomerId;
    if (loginCustomerId) {
      headers['login-customer-id'] = normalizeCustomerId(loginCustomerId);
    }
    const response = await this.fetchImpl(`${API_BASE}/${this.version}/${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new AdportError('PROVIDER_ERROR', formatGoogleAdsError(response.status, raw), safeJson(raw));
    }
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  async listAccessibleCustomers(): Promise<string[]> {
    const data = await this.request<{ resourceNames?: string[] }>('customers:listAccessibleCustomers', {
      method: 'GET',
      // Google documents that this call is scoped only by the OAuth user; a
      // manager header has no effect and must not leak between cloud tenants.
      loginCustomerId: null,
    });
    return (data.resourceNames ?? []).map((name) => name.replace('customers/', ''));
  }

  async keywordPlanning(
    customerId: string,
    method: 'generateKeywordIdeas' | 'generateKeywordHistoricalMetrics',
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(`customers/${normalizeCustomerId(customerId)}:${method}`, { method: 'POST', body });
  }

  async fieldMetadata(query: string, pageSize: number, pageToken?: string) {
    const response = await this.request<Record<string, unknown>>('googleAdsFields:search', {
      method: 'POST', body: { query, pageSize, ...(pageToken ? { pageToken } : {}) },
      // This is the API-wide catalog, not a manager/customer data operation.
      loginCustomerId: null,
    });
    return { apiVersion: this.version, response };
  }

  async uploadConversions(customerId: string, method: 'uploadClickConversions' | 'uploadCallConversions' | 'uploadConversionAdjustments', rows: Array<Record<string, unknown>>, validateOnly: boolean, jobId?: number): Promise<Record<string, unknown>> {
    return this.request(`customers/${normalizeCustomerId(customerId)}:${method}`, {
      method: 'POST', body: { [method === 'uploadConversionAdjustments' ? 'conversionAdjustments' : 'conversions']: rows, partialFailure: true, validateOnly, ...(jobId !== undefined ? { jobId } : {}) },
    });
  }

  /** Paged GAQL search; accumulates rows up to options.maxRows (default 1000). */
  async search(
    customerId: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<Array<Record<string, unknown>>> {
    const maxRows = options.maxRows ?? 1000;
    const rows: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    do {
      const data = await this.request<{ results?: Array<Record<string, unknown>>; nextPageToken?: string }>(
        `customers/${normalizeCustomerId(customerId)}/googleAds:search`,
        { method: 'POST', body: { query: options.includeDrafts ? `${query}${/\bPARAMETERS\b/i.test(query) ? ',' : ' PARAMETERS'} include_drafts=true` : query, pageToken }, loginCustomerId: options.loginCustomerId },
      );
      rows.push(...(data.results ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken && rows.length < maxRows);
    return rows.slice(0, maxRows);
  }

  /**
   * Service-specific mutate (campaigns, campaignBudgets, adGroups, adGroupCriteria, adGroupAds).
   * validateOnly=true is the server-side dry run.
   */
  async mutate(
    customerId: string,
    service: string,
    operations: Array<Record<string, unknown>>,
    { validateOnly, responseContentType }: { validateOnly: boolean; responseContentType?: 'MUTABLE_RESOURCE' },
  ): Promise<{ results?: Array<{ resourceName?: string; experimentArm?: Record<string, unknown> }> }> {
    const body: Record<string, unknown> = { operations, validateOnly, ...(responseContentType ? { responseContentType } : {}) };
    // These services omit partial_failure entirely; asset-group and product
    // tree requests must be atomic rather than accept partial writes.
    if (!['customerManagerLinks', 'assetGroups', 'assetGroupListingGroupFilters'].includes(service)) body.partialFailure = false;
    return this.request(`customers/${normalizeCustomerId(customerId)}/${service}:mutate`, {
      method: 'POST',
      body,
    });
  }

  async experimentAction(customerId: string, experimentId: string, action: 'endExperiment' | 'scheduleExperiment' | 'promoteExperiment' | 'graduateExperiment', payload: Record<string, unknown>, validateOnly: boolean): Promise<Record<string, unknown>> {
    if (!/^[1-9]\d*$/.test(experimentId) || !['endExperiment', 'scheduleExperiment', 'promoteExperiment', 'graduateExperiment'].includes(action)) throw new AdportError('INVALID_INPUT', 'google: invalid experiment action');
    return this.request(`customers/${normalizeCustomerId(customerId)}/experiments/${experimentId}:${action}`, { method: 'POST', body: { ...payload, validateOnly } });
  }

  async experimentAsyncErrors(customerId: string, experimentId: string, pageSize: number, pageToken?: string): Promise<Record<string, unknown>> {
    if (!/^[1-9]\d*$/.test(experimentId)) throw new AdportError('INVALID_INPUT', 'google: invalid experiment ID');
    const query = new URLSearchParams({ pageSize: String(pageSize), ...(pageToken ? { pageToken } : {}) });
    return this.request(`customers/${normalizeCustomerId(customerId)}/experiments/${experimentId}:listExperimentAsyncErrors?${query}`, { method: 'GET' });
  }

  async experimentOperation(customerId: string, operationName: string): Promise<Record<string, unknown>> {
    const account = normalizeCustomerId(customerId), prefix = `customers/${account}/operations/`, key = operationName.startsWith(prefix) ? operationName.slice(prefix.length) : '';
    if (!key || key.length > 512 || /[\s/\\?#%]/.test(key) || key === '.' || key === '..') throw new AdportError('INVALID_INPUT', 'google: operation is not scoped to the selected account');
    return this.request(`${prefix}${encodeURIComponent(key)}`, { method: 'GET' });
  }

  /** Cross-service atomic mutate (e.g. budget + campaign with temp resource ids). */
  async googleAdsMutate(
    customerId: string,
    mutateOperations: Array<Record<string, unknown>>,
    { validateOnly, responseContentType }: { validateOnly: boolean; responseContentType?: 'MUTABLE_RESOURCE' },
  ): Promise<{ mutateOperationResponses?: Array<Record<string, { resourceName?: string }>> }> {
    return this.request(`customers/${normalizeCustomerId(customerId)}/googleAds:mutate`, {
      method: 'POST',
      body: { mutateOperations, validateOnly, partialFailure: false, ...(responseContentType ? { responseContentType } : {}) },
    });
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Render Google Ads failures with field paths and request id so an agent can
 * self-correct ("error at operations[0].create.name: ...").
 */
export function formatGoogleAdsError(status: number, raw: string): string {
  const parsed = safeJson(raw) as {
    error?: {
      message?: string;
      details?: Array<{ requestId?: string; errors?: Array<GoogleAdsErrorItem> }>;
    };
  };
  const error = parsed?.error;
  if (!error) return `Google Ads API error (HTTP ${status})`;
  const lines: string[] = [];
  let requestId: string | undefined;
  for (const detail of error.details ?? []) {
    requestId = requestId ?? detail.requestId;
    for (const item of detail.errors ?? []) {
      const path = (item.location?.fieldPathElements ?? [])
        .map((el) => (el.index !== undefined ? `${el.fieldName}[${el.index}]` : el.fieldName))
        .join('.');
      lines.push(`${path ? `at ${path}: ` : ''}${item.message}`);
    }
  }
  const head = `Google Ads API error (HTTP ${status}): ${error.message ?? 'request failed'}`;
  const tail = requestId ? ` [request-id: ${requestId}]` : '';
  return lines.length > 0 ? `${head}\n  ${lines.join('\n  ')}${tail}` : `${head}${tail}`;
}

interface GoogleAdsErrorItem {
  message: string;
  location?: { fieldPathElements?: Array<{ fieldName: string; index?: number }> };
}
