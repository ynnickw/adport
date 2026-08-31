import { createHmac, randomBytes } from 'node:crypto';
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
export type XMethod = 'GET' | 'POST' | 'PUT';

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
  constructor(credentials: XAdsCredentials, private readonly fetchImpl: typeof fetch = fetch) {
    if (Object.values(credentials).some(value => typeof value !== 'string' || !value.trim()) ||
      !credentials.consumerKey || !credentials.consumerSecret || !credentials.accessToken || !credentials.accessTokenSecret) {
      throw new AdportError('INVALID_INPUT', 'x: all four OAuth 1.0a credentials are required');
    }
    this.signer = createXSigner(credentials);
    this.token = { key: credentials.accessToken, secret: credentials.accessTokenSecret };
  }

  async request<T>(method: XMethod, path: string, schema: z.ZodType<T>, params: XParams = {}): Promise<T> {
    if (!/^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/.test(path)) throw new AdportError('INVALID_INPUT', 'x: invalid API resource path');
    const url = new URL(path, X_ADS_API_BASE);
    for (const [key, value] of Object.entries(params)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key) || key.startsWith('oauth_') || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new AdportError('INVALID_INPUT', 'x: invalid API parameter');
      }
      url.searchParams.set(key, String(value));
    }
    // oauth-1.0a decodes percent escapes but not form-style '+' spaces.
    // Serialize spaces as %20 so the signed values match X's query parser.
    url.search = url.search.replace(/\+/g, '%20');
    // X's endpoint reference specifies query parameters for POST and PUT too.
    // Sign the final encoded URL, and send exactly that URL without a JSON body.
    const headers = this.signer.toHeader(this.signer.authorize({ url: url.href, method }, this.token));
    let response: Response;
    try {
      response = await this.fetchImpl(url.href, { method, headers: { ...headers, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new AdportError('PROVIDER_ERROR', `x: transport failed${method === 'GET' ? '' : '; write outcome unknown, inspect the account before retrying'}`);
    }
    if (!response.ok) {
      const guidance = response.status === 403 ? 'Check Ads API app approval and this user’s ad-account permissions; reconnecting alone may not help.'
        : response.status === 401 ? 'Check OAuth 1.0a credentials, token permissions and the local clock. Regenerate user tokens after Ads API approval.'
        : response.status === 429 ? 'Rate limit reached; wait for the provider reset before retrying.' : 'Provider request failed.';
      throw new AdportError('PROVIDER_ERROR', `x: HTTP ${response.status}. ${guidance}${method === 'GET' ? '' : ' The write was not retried.'}`);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new AdportError('PROVIDER_ERROR', 'x: invalid JSON response'); }
    if (body && typeof body === 'object' && 'errors' in body && Array.isArray(body.errors) && body.errors.length) {
      throw new AdportError('PROVIDER_ERROR', 'x: provider returned an error envelope');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'x: unexpected API response schema');
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
