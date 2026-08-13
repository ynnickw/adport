import { AdportError } from '@adport/core';

export interface MetaCredentials {
  /** Long-lived user token or (preferred) a system-user token. */
  accessToken: string;
  /** Optional app id+secret — enables token expiry checks via /debug_token. */
  appId?: string;
  appSecret?: string;
}

const GRAPH_BASE = 'https://graph.facebook.com';
// Latest published Graph/Marketing API version. Bump only after Meta publishes
// the matching reference and official Business SDK metadata.
export const DEFAULT_GRAPH_VERSION = 'v25.0';

/** Ad account ids are numeric; Graph URL paths require the "act_" prefix. */
export function normalizeAccountId(id: string): string {
  const normalized = id.replace(/^act_/, '').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new AdportError('INVALID_INPUT', `"${id}" is not a valid Meta ad account id (numeric, with or without act_).`);
  }
  return normalized;
}

/** Account status codes per the Ad Account reference. */
export const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE',
  2: 'DISABLED',
  3: 'UNSETTLED',
  7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE',
  101: 'CLOSED',
};

/**
 * Minimal Graph API client for the Marketing API. Bearer-token auth; GET with
 * query params, POST as form-encoded fields (arrays/objects JSON-stringified,
 * matching the documented curl examples).
 */
export class MetaGraphClient {
  constructor(
    private readonly credentials: MetaCredentials,
    private readonly version: string = process.env.META_API_VERSION ?? DEFAULT_GRAPH_VERSION,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const search = new URLSearchParams(params);
    const query = search.size > 0 ? `?${search}` : '';
    return this.send<T>(`${path}${query}`, { method: 'GET' });
  }

  async post<T>(path: string, fields: Record<string, unknown>): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return this.send<T>(path, { method: 'POST', body });
  }

  async delete<T>(path: string, fields: Record<string, unknown> = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return this.send<T>(path, { method: 'DELETE', ...(body.size > 0 ? { body } : {}) });
  }

  private async send<T>(path: string, init: { method: string; body?: URLSearchParams }): Promise<T> {
    const response = await this.fetchImpl(`${GRAPH_BASE}/${this.version}/${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${this.credentials.accessToken}`,
        ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: init.body,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new AdportError('PROVIDER_ERROR', formatMetaError(response.status, raw), safeJson(raw));
    }
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  /** Paged GET over an edge, following paging.next up to maxItems. */
  async getPaged<T>(path: string, params: Record<string, string>, maxItems: number): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined;
    let first = true;
    while (items.length < maxItems) {
      let data: { data?: T[]; paging?: { next?: string } };
      if (first) {
        data = await this.get(path, params);
        first = false;
      } else if (url) {
        const response = await this.fetchImpl(url, {
          headers: { authorization: `Bearer ${this.credentials.accessToken}` },
        });
        const raw = await response.text();
        if (!response.ok) {
          throw new AdportError('PROVIDER_ERROR', formatMetaError(response.status, raw), safeJson(raw));
        }
        data = JSON.parse(raw) as { data?: T[]; paging?: { next?: string } };
      } else {
        break;
      }
      items.push(...(data.data ?? []));
      url = data.paging?.next;
      if (!url) break;
    }
    return items.slice(0, maxItems);
  }

  /** Token health via /debug_token; needs appId+appSecret (app access token). */
  async debugToken(): Promise<{ isValid: boolean; expiresAt?: number; scopes?: string[] } | undefined> {
    if (!this.credentials.appId || !this.credentials.appSecret) return undefined;
    const data = await this.get<{ data?: { is_valid?: boolean; expires_at?: number; scopes?: string[] } }>(
      'debug_token',
      {
        input_token: this.credentials.accessToken,
        access_token: `${this.credentials.appId}|${this.credentials.appSecret}`,
      },
    );
    return data.data
      ? { isValid: data.data.is_valid ?? false, expiresAt: data.data.expires_at, scopes: data.data.scopes }
      : undefined;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Graph error shape: error.{message,type,code,error_subcode,error_user_msg,fbtrace_id}. */
export function formatMetaError(status: number, raw: string): string {
  const parsed = safeJson(raw) as {
    error?: {
      message?: string;
      type?: string;
      code?: number;
      error_subcode?: number;
      error_user_title?: string;
      error_user_msg?: string;
      fbtrace_id?: string;
    };
  };
  const error = parsed?.error;
  if (!error) return `Meta Marketing API error (HTTP ${status})`;
  const parts = [`Meta Marketing API error (HTTP ${status}, code ${error.code ?? '?'}`];
  if (error.error_subcode) parts.push(`subcode ${error.error_subcode}`);
  let message = `${parts.join(', ')}): ${error.message ?? 'request failed'}`;
  if (error.error_user_msg) message += `\n  ${error.error_user_title ? `${error.error_user_title}: ` : ''}${error.error_user_msg}`;
  if (error.code === 190) message += '\n  The access token is invalid or expired — re-run `adport connect meta`.';
  if (error.fbtrace_id) message += ` [fbtrace_id: ${error.fbtrace_id}]`;
  return message;
}
