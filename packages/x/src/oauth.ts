import { AdportError } from '@adport/core';
import { createXSigner, type XAdsCredentials } from './client.js';

type App = Pick<XAdsCredentials, 'consumerKey' | 'consumerSecret'>;
export interface XUserTokens { accessToken: string; accessTokenSecret: string }
export interface XRequestTokens { requestToken: string; requestTokenSecret: string }
const REQUEST_TOKEN_URL = 'https://api.x.com/oauth/request_token';
const ACCESS_TOKEN_URL = 'https://api.x.com/oauth/access_token';
const INVALIDATE_TOKEN_URL = 'https://api.x.com/1.1/oauth/invalidate_token.json';
const LIMIT = 16 * 1024;

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(value);
}
function requireValues(...values: unknown[]): void {
  if (!values.every(validToken)) throw new AdportError('INVALID_INPUT', 'x: OAuth credentials or verifier are missing or malformed');
}
function failure(message: string): AdportError { return new AdportError('PROVIDER_ERROR', `x: ${message}`); }

async function textBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw failure('empty OAuth response');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) { await reader.cancel(); throw failure('OAuth response exceeded size limit'); }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch { throw failure('invalid or oversized OAuth response'); }
  finally { reader.releaseLock(); }
}

async function signedPost(app: App, url: string, parameters: Record<string, string>, token: { key: string; secret: string } | undefined, fetchImpl: typeof fetch): Promise<Response> {
  requireValues(app.consumerKey, app.consumerSecret);
  const signer = createXSigner(app);
  // OAuth-specific parameters belong in the Authorization header. Include
  // them in the signature once, and send no query string or request body.
  const authorization = signer.authorize({ method: 'POST', url, data: parameters }, token);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { ...signer.toHeader({ ...authorization, ...parameters }) }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch { throw failure('OAuth transport failed; restart authorization rather than replaying the exchange'); }
  if (response.status !== 200) throw failure(`OAuth request failed (HTTP ${response.status})`);
  return response;
}

async function tokens(response: Response): Promise<URLSearchParams> {
  // The official examples return form-encoded tokens, not JSON, despite the
  // generic endpoint metadata saying JSON. Reject duplicate token fields.
  const values = new URLSearchParams(await textBody(response));
  for (const key of ['oauth_token', 'oauth_token_secret']) {
    if (values.getAll(key).length !== 1 || !validToken(values.get(key))) throw failure('malformed OAuth token response');
  }
  return values;
}

export async function requestXToken(app: App, callback: string, fetchImpl: typeof fetch = fetch): Promise<XRequestTokens> {
  let url: URL;
  try { url = new URL(callback); } catch { throw new AdportError('INVALID_INPUT', 'x: an exact registered HTTPS callback is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new AdportError('INVALID_INPUT', 'x: an exact registered HTTPS callback without query or fragment is required');
  const values = await tokens(await signedPost(app, REQUEST_TOKEN_URL, { oauth_callback: url.href }, undefined, fetchImpl));
  if (values.getAll('oauth_callback_confirmed').length !== 1 || values.get('oauth_callback_confirmed') !== 'true') throw failure('OAuth callback was not confirmed');
  return { requestToken: values.get('oauth_token')!, requestTokenSecret: values.get('oauth_token_secret')! };
}

export function buildXAuthorizationUrl(requestToken: string): string {
  requireValues(requestToken);
  return `https://api.x.com/oauth/authorize?${new URLSearchParams({ oauth_token: requestToken })}`;
}

export async function exchangeXToken(app: App, request: XRequestTokens, verifier: string, fetchImpl: typeof fetch = fetch): Promise<XUserTokens> {
  requireValues(request.requestToken, request.requestTokenSecret, verifier);
  const values = await tokens(await signedPost(app, ACCESS_TOKEN_URL, { oauth_verifier: verifier }, { key: request.requestToken, secret: request.requestTokenSecret }, fetchImpl));
  return { accessToken: values.get('oauth_token')!, accessTokenSecret: values.get('oauth_token_secret')! };
}

export async function revokeXToken(credentials: XAdsCredentials, fetchImpl: typeof fetch = fetch): Promise<void> {
  requireValues(credentials.accessToken, credentials.accessTokenSecret);
  const response = await signedPost(credentials, INVALIDATE_TOKEN_URL, {}, { key: credentials.accessToken, secret: credentials.accessTokenSecret }, fetchImpl);
  let value: unknown;
  try { value = JSON.parse(await textBody(response)); } catch { throw failure('invalid OAuth revocation response'); }
  if (!value || typeof value !== 'object' || !('access_token' in value) || value.access_token !== credentials.accessToken) throw failure('OAuth revocation was not confirmed for this token');
}
