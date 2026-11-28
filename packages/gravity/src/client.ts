import { AdportError } from '@adport/core';
import { z } from 'zod';

export const GRAVITY_API_BASE = 'https://platform.trygravity.com/advertiser-dashboard/';
const ORIGIN = 'https://platform.trygravity.com';

export interface GravityCredentials {
  /** Advertiser API key from Settings → Organization; one key per advertiser account, no scopes. */
  apiKey: string;
}

type Params = Record<string, string | undefined>;

export class GravityClient {
  constructor(private readonly credentials: GravityCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    if (!credentials.apiKey.trim()) throw new AdportError('INVALID_INPUT', 'gravity: API key is empty');
  }

  async get<T>(path: string, schema: z.ZodType<T>, params: Params = {}): Promise<T> {
    return this.parse(await this.send(this.url(path, params), 'GET'), schema);
  }

  async post<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
    return this.parse(await this.send(this.url(path), 'POST', body), schema);
  }

  async patch<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
    return this.parse(await this.send(this.url(path), 'PATCH', body), schema);
  }

  private parse<T>(data: unknown, schema: z.ZodType<T>): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'gravity: malformed API response', { response_issues: parsed.error.issues.slice(0, 20).map(issue => ({ path: issue.path, code: issue.code })) });
    return parsed.data;
  }

  private url(path: string, params: Params = {}): URL {
    const url = new URL(path, GRAVITY_API_BASE);
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/advertiser-dashboard/') || url.username || url.password || url.hash) throw new AdportError('INVALID_INPUT', 'gravity: invalid API URL');
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
    return url;
  }

  private redact(value: string): string {
    return value.replaceAll(this.credentials.apiKey, '[redacted]').slice(0, 2000);
  }

  private async send(url: URL, method: 'GET' | 'POST' | 'PATCH', body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url.href, {
        method,
        headers: {
          'x-api-key': this.credentials.apiKey,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new AdportError('PROVIDER_ERROR', 'gravity: request failed before a response was received. Check connectivity and reconcile any pending write.');
    }
    const raw: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const advice = response.status === 401 ? ' Use the current advertiser API key from Gravity Settings → Organization.'
        : response.status === 402 ? ' Billing is not ready for activation; add a payment method in the Gravity dashboard.'
        : response.status === 429 ? ` Rate limited; retry after ${retryAfter && /^\d+$/.test(retryAfter) ? `${retryAfter} s` : 'a short wait'}.` : '';
      const message = errorMessage(raw);
      const code = errorCode(raw);
      throw new AdportError('PROVIDER_ERROR', `gravity: HTTP ${response.status}.${advice}${message ? ` ${this.redact(message)}` : ''}`, {
        http_status: response.status, ...(code ? { provider_code: code } : {}),
      });
    }
    return raw;
  }
}

/** Errors carry `detail`: a string, a FastAPI validation list, or `{ code, message }`. */
function errorMessage(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const detail = (raw as Record<string, unknown>).detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).msg === 'string' ? (item as Record<string, string>).msg : '').filter(Boolean).slice(0, 5).join('; ') || undefined;
  if (detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).message === 'string') return (detail as Record<string, string>).message;
  return undefined;
}

function errorCode(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { error, detail } = raw as Record<string, unknown>;
  for (const envelope of [error, detail]) {
    if (!envelope || typeof envelope !== 'object') continue;
    const code = (envelope as Record<string, unknown>).code;
    if (typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code)) return code;
  }
  return undefined;
}
