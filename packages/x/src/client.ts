import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import OAuth from 'oauth-1.0a';
import { z } from 'zod';
import { AdportError } from '@adport/core';

export const X_ADS_API_BASE = 'https://ads-api.x.com/12/';
export interface XAdsCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}
export type XParams = Record<string, string | number | boolean>;
export type XMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export function createXSigner(credentials: Pick<XAdsCredentials, 'consumerKey' | 'consumerSecret'>): OAuth {
  const oauth = new OAuth({
    consumer: { key: credentials.consumerKey, secret: credentials.consumerSecret },
    signature_method: 'HMAC-SHA1',
    hash_function: (base, key) => createHmac('sha1', key).update(base).digest('base64'),
  });
  // The library's default nonce uses Math.random. Use cryptographic entropy.
  oauth.getNonce = () => randomBytes(24).toString('hex');
  return oauth;
}

export class XAdsClient {
  private readonly signer: OAuth;
  private readonly token: OAuth.Token;
  private readonly receiptKey: Buffer;
  constructor(credentials: XAdsCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    if (Object.values(credentials).some(value => typeof value !== 'string' || !value.trim()) ||
      !credentials.consumerKey || !credentials.consumerSecret || !credentials.accessToken || !credentials.accessTokenSecret) {
      throw new AdportError('INVALID_INPUT', 'x: all four OAuth 1.0a credentials are required');
    }
    this.signer = createXSigner(credentials);
    this.token = { key: credentials.accessToken, secret: credentials.accessTokenSecret };
    this.receiptKey = createHmac('sha256', credentials.consumerSecret).update(`adport.x.media.v1.${credentials.accessTokenSecret}`).digest();
  }

  async request<T>(method: XMethod, path: string, schema: z.ZodType<T>, params: XParams = {}, jsonBody?: unknown): Promise<T> {
    if (!/^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/.test(path)) throw new AdportError('INVALID_INPUT', 'x: invalid API resource path');
    return this.send(method, new URL(path, X_ADS_API_BASE), schema, params, jsonBody);
  }

  async mediaRequest<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, params: XParams = {}, jsonBody?: unknown): Promise<T> {
    if (!(method === 'GET' ? path === 'media/upload' : path === 'media/upload/initialize' || /^media\/upload\/[1-9]\d{0,18}\/(?:append|finalize)$/.test(path))) throw new AdportError('INVALID_INPUT', 'x: unsupported native media route');
    return this.send(method, new URL(path, 'https://api.x.com/2/'), schema, params, jsonBody);
  }

  resourceReceipt(value: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', this.receiptKey).update(payload).digest('base64url')}`;
  }
  verifyResourceReceipt(receipt: string): unknown {
    const invalid = () => new AdportError('INVALID_INPUT', 'x: invalid resource receipt; use the receipt from the approved upload');
    if (receipt.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(receipt)) throw invalid();
    const [payload, signature] = receipt.split('.'), expected = createHmac('sha256', this.receiptKey).update(payload!).digest(), supplied = Buffer.from(signature!, 'base64url');
    if (supplied.toString('base64url') !== signature || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw invalid();
    try { return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')); } catch { throw invalid(); }
  }

  private async send<T>(method: XMethod, url: URL, schema: z.ZodType<T>, params: XParams, jsonBody?: unknown): Promise<T> {
    const path = url.pathname.replace(/^\/(?:12|2)\//, '');
    for (const [key, value] of Object.entries(params)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key) || key.startsWith('oauth_') || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new AdportError('INVALID_INPUT', 'x: invalid API parameter');
      }
      url.searchParams.set(key, String(value));
    }
    // oauth-1.0a decodes percent escapes but not form-style '+' spaces.
    // Serialize spaces as %20 so the signed values match X's query parser.
    url.search = url.search.replace(/\+/g, '%20');
    // Single-resource writes use query parameters; documented batches use JSON.
    // JSON is excluded from OAuth 1 form-parameter normalization.
    const headers = this.signer.toHeader(this.signer.authorize({ url: url.href, method }, this.token));
    let response: Response;
    try {
      response = await this.fetchImpl(url.href, { method, headers: { ...headers, accept: 'application/json', ...(jsonBody !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new AdportError('PROVIDER_ERROR', `x: transport failed${method === 'GET' ? '' : '; write outcome unknown, inspect the account before retrying'}`);
    }
    if (!response.ok) {
      const guidance = response.status === 403 ? 'Check Ads API app approval and this user’s ad-account permissions; reconnecting alone may not help.'
        : response.status === 401 ? 'Check OAuth 1.0a credentials, token permissions and the local clock. Regenerate user tokens after Ads API approval.'
        : response.status === 429 ? 'Rate limit reached; wait for the provider reset before retrying.' : 'Provider request failed.';
      throw new AdportError('PROVIDER_ERROR', `x: HTTP ${response.status}. ${guidance}${method === 'GET' ? '' : ' The write was not retried.'}`, { http_status: response.status });
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new AdportError('PROVIDER_ERROR', 'x: invalid JSON response'); }
    const nonempty = (value: unknown) => Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.keys(value).length > 0 : typeof value === 'string' && value.length > 0;
    if (body && typeof body === 'object' && 'errors' in body && nonempty(body.errors)) {
      throw new AdportError('PROVIDER_ERROR', 'x: provider returned an error envelope');
    }
    if (body && typeof body === 'object' && 'operation_errors' in body && nonempty(body.operation_errors)) {
      const data = /^batch\/accounts\/[a-z0-9]+\/(?:targeting_criteria|line_items)$/.test(path) && 'data' in body && Array.isArray(body.data) ? body.data : [];
      const ids = data.flatMap(row => row && typeof row === 'object' && typeof row.id === 'string' && /^[a-z0-9]{1,32}$/.test(row.id) ? [row.id] : []).slice(0, 500);
      throw new AdportError('PROVIDER_ERROR', 'x: provider rejected batch operations; inspect the account before retrying', { resource_ids: ids });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const data = method !== 'GET' && /^(?:accounts\/[a-z0-9]+\/(?:draft_tweets|media_library|line_items|campaigns)(?:\/[a-z0-9_]+)?|media\/upload(?:\/[a-z0-9]+){1,2})$/.test(path) && body && typeof body === 'object' && 'data' in body ? body.data : undefined;
      const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
      const ids = [...new Set(rows.flatMap(row => row && typeof row === 'object' ? ['id_str', 'id', 'media_key'].flatMap(key => { const value = (row as Record<string, unknown>)[key]; return typeof value === 'string' && /^(?:[a-z0-9]{1,32}|\d{1,3}_[1-9]\d{0,24})$/.test(value) ? [value] : []; }) : []))].slice(0, 500);
      throw new AdportError('PROVIDER_ERROR', `x: unexpected API response schema${method === 'GET' ? '' : '; write may have succeeded, reconcile before retrying'}`, ids.length ? { resource_ids: ids } : undefined);
    }
    return parsed.data;
  }

  async list<T extends { id: string }>(path: string, item: z.ZodType<T>, params: XParams = {}): Promise<T[]> {
    const schema = z.object({ data: z.array(item), next_cursor: z.string().nullable().optional() });
    const rows: T[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const page = await this.request('GET', path, schema, { ...params, count: 200, ...(cursor ? { cursor } : {}) });
      for (const row of page.data) {
        if (ids.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'x: pagination repeated an entity');
        ids.add(row.id); rows.push(row);
      }
      if (!page.next_cursor) return rows;
      if (cursors.has(page.next_cursor) || cursors.size >= 1000) throw new AdportError('PROVIDER_ERROR', 'x: cursor pagination did not terminate');
      cursors.add(page.next_cursor); cursor = page.next_cursor;
    }
  }
}
