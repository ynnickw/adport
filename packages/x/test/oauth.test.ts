import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { requestXToken, exchangeXToken, buildXAuthorizationUrl, revokeXToken } from '../src/oauth.js';

// Official X OAuth 1.0a guide and API-reference examples, reviewed 2026-08-31:
// https://docs.x.com/fundamentals/authentication/oauth-1-0a/obtaining-user-access-tokens
// https://docs.x.com/fundamentals/authentication/api-reference
const app = { consumerKey: 'synthetic-key', consumerSecret: 'synthetic+secret/&' };
const request = { requestToken: 'request-token', requestTokenSecret: 'temporary+secret/&' };
const grant = { accessToken: 'user-token', accessTokenSecret: 'user-secret' };
const callback = 'https://app.adport.test/api/oauth/x/callback';
const form = (extra = '') => `oauth_token=request-token&oauth_token_secret=temporary-secret${extra}`;
const percent = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function verify(init: RequestInit, url: string, tokenSecret = '') {
  const header = new Headers(init.headers).get('authorization')!;
  const auth = Object.fromEntries(header.slice('OAuth '.length).split(/,\s*/).map(pair => {
    const [key, ...value] = pair.split('='); return [decodeURIComponent(key!), decodeURIComponent(value.join('=').slice(1, -1))];
  }));
  const { oauth_signature: signature, ...fields } = auth;
  const normalized = Object.entries(fields).map(([key, value]) => `${percent(key)}=${percent(value)}`).sort().join('&');
  const base = ['POST', url, normalized].map(percent).join('&');
  expect(signature).toBe(createHmac('sha1', `${percent(app.consumerSecret)}&${percent(tokenSecret)}`).update(base).digest('base64'));
  expect(fields.oauth_nonce).toMatch(/^[a-f0-9]{48}$/);
  expect(init.method).toBe('POST'); expect(init.body).toBeUndefined(); expect(init.redirect).toBe('error');
  expect(header).not.toContain(app.consumerSecret); expect(header).not.toContain(request.requestTokenSecret);
  return fields;
}

describe('X hosted OAuth wire contracts', () => {
  it('signs the registered callback and requires callback confirmation', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.x.com/oauth/request_token');
      const fields = verify(init!, String(url));
      expect(fields.oauth_callback).toBe(callback); expect(fields.oauth_token).toBeUndefined();
      return new Response(form('&oauth_callback_confirmed=true'));
    });
    expect(await requestXToken(app, callback, fetchMock)).toEqual({ requestToken: 'request-token', requestTokenSecret: 'temporary-secret' });
  });

  it('uses authorize, not authenticate, and never redirects with the token secret', () => {
    const url = new URL(buildXAuthorizationUrl(request.requestToken));
    expect(url.origin + url.pathname).toBe('https://api.x.com/oauth/authorize');
    expect([...url.searchParams]).toEqual([['oauth_token', request.requestToken]]);
  });

  it('signs the verifier with the matching temporary token secret', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.x.com/oauth/access_token');
      const fields = verify(init!, String(url), request.requestTokenSecret);
      expect(fields.oauth_verifier).toBe('verifier+encoded/&');
      expect(fields.oauth_token).toBe(request.requestToken); expect(fields.oauth_callback).toBeUndefined();
      return new Response('oauth_token=user-token&oauth_token_secret=user-secret&user_id=123&screen_name=fixture');
    });
    expect(await exchangeXToken(app, request, 'verifier+encoded/&', fetchMock)).toEqual(grant);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['', '&oauth_callback_confirmed=false', '&oauth_callback_confirmed=true&oauth_callback_confirmed=false'])('rejects missing/ambiguous callback confirmation %s', async suffix => {
    await expect(requestXToken(app, callback, async () => new Response(form(suffix)))).rejects.toThrow(/not confirmed/);
  });

  it.each(['oauth_token=a', 'oauth_token=a&oauth_token_secret=', 'oauth_token=a&oauth_token=b&oauth_token_secret=c', '{"oauth_token":"secret"}', 'oauth_token=a&oauth_token_secret=%0A'])('rejects malformed token fields', async body => {
    await expect(exchangeXToken(app, request, 'verifier', async () => new Response(body))).rejects.toThrow(/malformed/);
  });

  it.each(['http://app.adport.test/callback', 'https://user:pass@app.adport.test/callback', 'https://app.adport.test/callback?state=arbitrary', 'https://app.adport.test/callback#fragment'])('rejects unregistered callback shapes before fetching', async callback => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(requestXToken(app, callback, fetchMock)).rejects.toThrow(/HTTPS callback/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes network errors and does not replay a one-time exchange', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => { throw new Error('sensitive-token-secret'); });
    const error = await exchangeXToken(app, request, 'verifier', fetchMock).catch(error => error);
    expect(error.message).not.toContain('sensitive-token-secret'); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects oversized responses without exposing their contents', async () => {
    await expect(exchangeXToken(app, request, 'verifier', async () => new Response('sensitive'.repeat(4096)))).rejects.toThrow(/oversized/);
  });

  it('requires exactly HTTP 200, without echoing an upstream failure body', async () => {
    for (const status of [201, 302, 401, 403, 429, 500]) {
      const error = await exchangeXToken(app, request, 'verifier', async () => new Response('sensitive-token', { status })).catch(error => error);
      expect(error.message).toContain(`HTTP ${status}`); expect(error.message).not.toContain('sensitive-token');
    }
  });

  it('revokes using user-context signing and checks the confirmed token', async () => {
    await revokeXToken({ ...app, ...grant }, async (url, init) => {
      expect(url).toBe('https://api.x.com/1.1/oauth/invalidate_token.json');
      expect(verify(init!, String(url), grant.accessTokenSecret).oauth_token).toBe(grant.accessToken);
      return Response.json({ access_token: grant.accessToken });
    });
    await expect(revokeXToken({ ...app, ...grant }, async () => Response.json({ access_token: 'different-token' }))).rejects.toThrow(/not confirmed/);
  });
});
