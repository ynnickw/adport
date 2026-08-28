import { AdportError } from '@adport/core';

/**
 * Matches the google-ads.yaml naming conventions so credentials translate 1:1.
 */
export interface GoogleCredentials {
  developerToken: string;
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
  private accessToken?: { token: string; expiresAt: number };

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
    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return this.accessToken.token;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; loginCustomerId?: string | null },
  ): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'developer-token': this.credentials.developerToken,
      'content-type': 'application/json',
    };
    const operatingCustomerId = path.match(/^customers\/(\d{10})\//)?.[1];
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
        { method: 'POST', body: { query, pageToken }, loginCustomerId: options.loginCustomerId },
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
    { validateOnly }: { validateOnly: boolean },
  ): Promise<{ results?: Array<{ resourceName?: string }> }> {
    const body: Record<string, unknown> = { operations, validateOnly };
    // CustomerManagerLinkService does not expose partial_failure in its mutate
    // request, unlike most resource-specific Google Ads mutate services.
    if (service !== 'customerManagerLinks') body.partialFailure = false;
    return this.request(`customers/${normalizeCustomerId(customerId)}/${service}:mutate`, {
      method: 'POST',
      body,
    });
  }

  /** Cross-service atomic mutate (e.g. budget + campaign with temp resource ids). */
  async googleAdsMutate(
    customerId: string,
    mutateOperations: Array<Record<string, unknown>>,
    { validateOnly }: { validateOnly: boolean },
  ): Promise<{ mutateOperationResponses?: Array<Record<string, { resourceName?: string }>> }> {
    return this.request(`customers/${normalizeCustomerId(customerId)}/googleAds:mutate`, {
      method: 'POST',
      body: { mutateOperations, validateOnly, partialFailure: false },
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
