import { describe, expect, it, vi } from 'vitest';
import {
  buildGoogleAuthUrl,
  buildMicrosoftAuthUrl,
  exchangeCodeForTokens,
  generateOAuthState,
  generatePkce,
  parseClientSecretJson,
  startLoopbackServer,
} from '../src/connect/oauth.js';

describe('buildGoogleAuthUrl', () => {
  it('requests offline access with the adwords scope', () => {
    const url = new URL(buildGoogleAuthUrl('my-client', 'http://127.0.0.1:1234', 'challenge', 'state'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adwords');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1234');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state');
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
      expect(body.get('code_verifier')).toBe('verifier');
      return new Response(JSON.stringify({ refresh_token: 'rt', access_token: 'at' }));
    });
    const tokens = await exchangeCodeForTokens(
      {
        clientId: 'id',
        clientSecret: 'secret',
        code: 'the-code',
        redirectUri: 'http://127.0.0.1:9',
        codeVerifier: 'verifier',
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(tokens).toEqual({ refreshToken: 'rt', accessToken: 'at' });
  });

  it('fails clearly when no refresh token comes back', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'at' })));
    await expect(
      exchangeCodeForTokens(
        { clientId: 'id', clientSecret: 'secret', code: 'c', redirectUri: 'r', codeVerifier: 'v' },
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

  it('can advertise localhost for providers that require the registered loopback host', async () => {
    const server = await startLoopbackServer('localhost');
    expect(new URL(server.redirectUri).hostname).toBe('localhost');
    server.close();
  });

  it('accepts the matching OAuth state', async () => {
    const server = await startLoopbackServer('127.0.0.1', 'expected');
    const response = await fetch(`${server.redirectUri}/?code=abc123&state=expected`);
    expect(response.status).toBe(200);
    await expect(server.waitForCode).resolves.toBe('abc123');
    server.close();
  });

  it('rejects a mismatched OAuth state', async () => {
    const server = await startLoopbackServer('127.0.0.1', 'expected');
    const codeResult = server.waitForCode.catch((error: unknown) => error);
    const response = await fetch(`${server.redirectUri}/?code=abc123&state=wrong`);
    expect(response.status).toBe(400);
    await expect(codeResult).resolves.toMatchObject({ message: expect.stringMatching(/state validation failed/) });
    server.close();
  });
});

describe('OAuth security parameters', () => {
  it('generates PKCE and state values and includes them in Microsoft authorization', () => {
    const pkce = generatePkce();
    const state = generateOAuthState();
    expect(pkce.verifier.length).toBeGreaterThan(32);
    expect(pkce.challenge).not.toBe(pkce.verifier);
    expect(state.length).toBeGreaterThan(32);

    const url = new URL(buildMicrosoftAuthUrl('client', 'http://localhost:1234', pkce.challenge, state));
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(state);
  });
});
