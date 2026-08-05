import { describe, expect, it, vi } from 'vitest';
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  parseClientSecretJson,
  startLoopbackServer,
} from '../src/connect/oauth.js';

describe('buildGoogleAuthUrl', () => {
  it('requests offline access with the adwords scope', () => {
    const url = new URL(buildGoogleAuthUrl('my-client', 'http://127.0.0.1:1234'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adwords');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1234');
  });
});

describe('parseClientSecretJson', () => {
  it('parses installed-app client JSON', () => {
    const parsed = parseClientSecretJson(
      JSON.stringify({ installed: { client_id: 'id', client_secret: 'secret' } }),
    );
    expect(parsed).toEqual({ clientId: 'id', clientSecret: 'secret' });
  });
  it('rejects unrelated JSON', () => {
    expect(() => parseClientSecretJson('{}')).toThrow(/OAuth client JSON/);
  });
});

describe('exchangeCodeForTokens', () => {
  it('posts the authorization code and returns tokens', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('the-code');
      return new Response(JSON.stringify({ refresh_token: 'rt', access_token: 'at' }));
    });
    const tokens = await exchangeCodeForTokens(
      { clientId: 'id', clientSecret: 'secret', code: 'the-code', redirectUri: 'http://127.0.0.1:9' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(tokens).toEqual({ refreshToken: 'rt', accessToken: 'at' });
  });

  it('fails clearly when no refresh token comes back', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'at' })));
    await expect(
      exchangeCodeForTokens(
        { clientId: 'id', clientSecret: 'secret', code: 'c', redirectUri: 'r' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/refresh_token/);
  });
});

describe('startLoopbackServer', () => {
  it('captures the authorization code from the redirect', async () => {
    const server = await startLoopbackServer();
    const response = await fetch(`${server.redirectUri}/?code=abc123`);
    expect(response.status).toBe(200);
    expect(await server.waitForCode).toBe('abc123');
    server.close();
  });
});
