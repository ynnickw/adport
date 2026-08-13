import { AdportError } from '@adport/core';

export interface MicrosoftCredentials {
  developerToken: string;
  clientId: string;
  refreshToken: string;
  /** Only for confidential (web) apps; native/CLI public clients have no secret. */
  clientSecret?: string;
  sandbox?: boolean;
}

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const MSADS_SCOPE = 'https://ads.microsoft.com/msads.manage offline_access';
/** Published universal sandbox developer token (anyone may use it in sandbox). */
export const SANDBOX_DEVELOPER_TOKEN = 'BBD37VB98';

function hosts(sandbox: boolean) {
  const infix = sandbox ? '.sandbox' : '';
  return {
    campaign: `https://campaign.api${infix}.bingads.microsoft.com/CampaignManagement/v13`,
    customer: `https://clientcenter.api${infix}.bingads.microsoft.com/CustomerManagement/v13`,
    reporting: `https://reporting.api${infix}.bingads.microsoft.com/Reporting/v13`,
  };
}

export type MicrosoftService = 'campaign' | 'customer' | 'reporting';

export interface RequestScope {
  /** Manager account (customer) id header. */
  customerId?: string;
  /** Ad account id header. */
  customerAccountId?: string;
}

/**
 * Microsoft Advertising REST v13 client. Public-client refresh tokens rotate —
 * onRefreshTokenRotated lets the credential store persist the replacement.
 */
export class MicrosoftAdsClient {
  private accessToken?: { token: string; expiresAt: number };
  private refreshToken: string;
  readonly sandbox: boolean;

  constructor(
    private readonly credentials: MicrosoftCredentials,
    private readonly onRefreshTokenRotated?: (token: string) => Promise<void>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.refreshToken = credentials.refreshToken;
    this.sandbox = credentials.sandbox ?? false;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.token;
    }
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      scope: 'https://ads.microsoft.com/msads.manage',
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
    });
    if (this.credentials.clientSecret) body.set('client_secret', this.credentials.clientSecret);
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new AdportError(
        'PROVIDER_ERROR',
        `Microsoft OAuth refresh failed (${response.status}). Public-client refresh tokens expire after ~90 days — re-run \`adport connect microsoft\`.`,
        safeJson(raw),
      );
    }
    const data = JSON.parse(raw) as { access_token: string; expires_in: number; refresh_token?: string };
    this.accessToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
      await this.onRefreshTokenRotated?.(data.refresh_token);
    }
    return this.accessToken.token;
  }

  async request<T>(
    service: MicrosoftService,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    scope: RequestScope = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      DeveloperToken: this.sandbox ? SANDBOX_DEVELOPER_TOKEN : this.credentials.developerToken,
      'content-type': 'application/json',
    };
    if (scope.customerId) headers.CustomerId = scope.customerId;
    if (scope.customerAccountId) headers.CustomerAccountId = scope.customerAccountId;
    const response = await this.fetchImpl(`${hosts(this.sandbox)[service]}/${path.replace(/^\//, '')}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new AdportError('PROVIDER_ERROR', formatMicrosoftError(response.status, raw), safeJson(raw));
    }
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  /** Plain authorized download (report files); returns raw bytes. */
  async download(url: string): Promise<Uint8Array> {
    const response = await this.fetchImpl(url, {});
    if (!response.ok) {
      throw new AdportError('PROVIDER_ERROR', `Microsoft report download failed (HTTP ${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface BatchErrorItem {
  Code?: number;
  ErrorCode?: string;
  Message?: string;
  FieldPath?: string;
  Index?: number;
  Details?: string;
  Detail?: string;
}

/**
 * REST errors are serialized fault objects: ApiFaultDetail
 * {OperationErrors, BatchErrors}, AdApiFaultDetail {Errors}, plus TrackingId.
 */
export function formatMicrosoftError(status: number, raw: string): string {
  const parsed = safeJson(raw) as {
    TrackingId?: string;
    Type?: string;
    OperationErrors?: BatchErrorItem[];
    BatchErrors?: BatchErrorItem[];
    Errors?: BatchErrorItem[];
  };
  if (!parsed || typeof parsed !== 'object' || (!parsed.OperationErrors && !parsed.Errors && !parsed.BatchErrors)) {
    return `Microsoft Advertising API error (HTTP ${status})`;
  }
  const items = [...(parsed.OperationErrors ?? []), ...(parsed.BatchErrors ?? []), ...(parsed.Errors ?? [])];
  const lines = items.map((e) => {
    const where = e.Index !== undefined ? ` [item ${e.Index}${e.FieldPath ? ` ${e.FieldPath}` : ''}]` : '';
    return `${e.Code ?? '?'} ${e.ErrorCode ?? ''}: ${e.Message ?? e.Details ?? e.Detail ?? ''}${where}`;
  });
  let message = `Microsoft Advertising API error (HTTP ${status}, ${parsed.Type ?? 'fault'}):\n  ${lines.join('\n  ')}`;
  if (items.some((e) => e.Code === 105)) {
    message += '\n  Code 105 InvalidCredentials: check the developer token matches the environment (sandbox vs production).';
  }
  if (items.some((e) => e.Code === 117)) {
    message += '\n  Code 117 CallRateExceeded: wait 60s before retrying.';
  }
  if (parsed.TrackingId) message += ` [TrackingId: ${parsed.TrackingId}]`;
  return message;
}

export function formatPartialErrors(partialErrors: BatchErrorItem[] | undefined): string | undefined {
  if (!partialErrors || partialErrors.length === 0) return undefined;
  return partialErrors
    .map((e) => `item ${e.Index ?? '?'}: ${e.Code ?? ''} ${e.ErrorCode ?? ''} ${e.Message ?? ''}${e.FieldPath ? ` (${e.FieldPath})` : ''}`)
    .join('; ');
}
