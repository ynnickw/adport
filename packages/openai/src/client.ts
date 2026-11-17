import { AdportError } from '@adport/core';
import { z } from 'zod';
import { listEnvelope } from './schemas.js';

export const OPENAI_ADS_API_BASE = 'https://api.ads.openai.com/v1/';
const ORIGIN = 'https://api.ads.openai.com';

export interface OpenAIAdsCredentials {
  /** Advertiser API key from Ads Manager settings; each key is bound to one ad account. */
  apiKey: string;
}

type Params = Record<string, string | string[]>;

export class OpenAIAdsClient {
  constructor(private readonly credentials: OpenAIAdsCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    if (!credentials.apiKey.trim()) throw new AdportError('INVALID_INPUT', 'openai: API key is empty');
  }

  async get<T>(path: string, schema: z.ZodType<T>, params: Params = {}): Promise<T> {
    return this.parse(await this.send(this.url(path, params), 'GET'), schema);
  }

  async post<T>(path: string, schema: z.ZodType<T>, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.parse(await this.send(this.url(path), 'POST', body, idempotencyKey), schema);
  }

  /** Follows `after` cursors until `has_more` is false or `max` rows were read. */
  async list<T extends z.ZodType>(path: string, item: T, params: Params = {}, max = 10_000): Promise<{ items: z.infer<T>[]; truncated: boolean }> {
    const envelope = listEnvelope(item), items: z.infer<T>[] = [], seen = new Set<string>();
    let after: string | undefined;
    while (true) {
      const page = await this.get(path, envelope, { ...params, ...(after ? { after } : {}) });
      items.push(...page.data);
      if (!page.has_more) return { items, truncated: false };
      if (items.length >= max) return { items: items.slice(0, max), truncated: true };
      const next = page.last_id ?? undefined;
      if (!next || seen.has(next) || seen.size >= 1000) throw new AdportError('PROVIDER_ERROR', 'openai: pagination did not terminate; refusing incomplete results');
      seen.add(next);
      after = next;
    }
  }

  private parse<T>(data: unknown, schema: z.ZodType<T>): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'openai: malformed API response', { response_issues: parsed.error.issues.slice(0, 20).map(issue => ({ path: issue.path, code: issue.code })) });
    return parsed.data;
  }

  private url(path: string, params: Params = {}): URL {
    const url = new URL(path, OPENAI_ADS_API_BASE);
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/v1/') || url.username || url.password || url.hash) throw new AdportError('INVALID_INPUT', 'openai: invalid API URL');
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) for (const entry of value) url.searchParams.append(key, entry);
      else url.searchParams.set(key, value);
    }
    return url;
  }

  private redact(value: string): string {
    return value.replaceAll(this.credentials.apiKey, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 2000);
  }

  private async send(url: URL, method: 'GET' | 'POST', body?: unknown, idempotencyKey?: string): Promise<unknown> {
    const response = await this.fetchImpl(url.href, {
      method,
      headers: {
        authorization: `Bearer ${this.credentials.apiKey}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const raw: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const advice = response.status === 401 ? ' Use an active Advertiser API key from Ads Manager settings.'
        : response.status === 429 ? ' Rate limited (600 requests/minute per endpoint, 1,200 overall); retry later.' : '';
      const message = errorMessage(raw);
      throw new AdportError('PROVIDER_ERROR', `openai: HTTP ${response.status}.${advice}${message ? ` ${this.redact(message)}` : ''}`, { http_status: response.status });
    }
    return raw;
  }
}

function errorMessage(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') return (error as Record<string, string>).message;
  return typeof record.message === 'string' ? record.message : undefined;
}
