import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { AdportError } from '@adport/core';

export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function buildGoogleAuthUrl(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_ADS_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

export async function exchangeCodeForTokens(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string; accessToken: string }> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: input.codeVerifier,
    }),
  });
  const data = (await response.json()) as { refresh_token?: string; access_token?: string; error?: string };
  if (!response.ok || !data.refresh_token || !data.access_token) {
    throw new AdportError(
      'PROVIDER_ERROR',
      `OAuth code exchange failed${data.error ? ` (${data.error})` : ''}. ` +
        'If no refresh_token was returned, revoke the app at myaccount.google.com/permissions and retry.',
      data,
    );
  }
  return { refreshToken: data.refresh_token, accessToken: data.access_token };
}

/** Parse a downloaded OAuth client JSON (client_secret_*.json, "installed" or "web"). */
export function parseClientSecretJson(text: string): { clientId: string; clientSecret: string } {
  const parsed = JSON.parse(text) as {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  };
  const entry = parsed.installed ?? parsed.web;
  if (!entry?.client_id || !entry?.client_secret) {
    throw new AdportError('INVALID_INPUT', 'Not a valid OAuth client JSON (expected "installed" or "web" key).');
  }
  return { clientId: entry.client_id, clientSecret: entry.client_secret };
}

export interface LoopbackServer {
  redirectUri: string;
  /** Resolves with the authorization code once Google redirects back. */
  waitForCode: Promise<string>;
  close: () => void;
}

/** Loopback listener for the OAuth redirect — the desktop-app flow's return path. */
export async function startLoopbackServer(
  redirectHostname: '127.0.0.1' | 'localhost' = '127.0.0.1',
  expectedState?: string,
  port = 0,
  callbackPath = '',
): Promise<LoopbackServer> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    if (expectedState && state !== expectedState) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h2>Authorization failed</h2><p>OAuth state validation failed. Return to the terminal and retry.</p>');
      rejectCode(new AdportError('PROVIDER_ERROR', 'OAuth state validation failed. Retry the connection.'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      code
        ? '<h2>adport is connected.</h2><p>You can close this tab and return to the terminal.</p>'
        : `<h2>Authorization failed${error ? `: ${escapeHtml(error)}` : ''}</h2><p>Return to the terminal and retry.</p>`,
    );
    if (code) resolveCode(code);
    else if (error) rejectCode(new Error(`OAuth authorization failed: ${error}`));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server failed to bind');
  return {
    redirectUri: `http://${redirectHostname}:${address.port}${callbackPath}`,
    waitForCode,
    close: () => server.close(),
  };
}

// ---- Reddit Ads API (confidential web app + permanent refresh token) -------

const REDDIT_AUTHORIZE = 'https://www.reddit.com/api/v1/authorize';
const REDDIT_TOKEN = 'https://www.reddit.com/api/v1/access_token';
export const REDDIT_ADS_SCOPES = 'adsread,adsedit,adsdatadeletion';

export function buildRedditAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    state,
    redirect_uri: redirectUri,
    duration: 'permanent',
    scope: REDDIT_ADS_SCOPES,
  });
  return `${REDDIT_AUTHORIZE}?${params}`;
}

export async function exchangeRedditCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string; userAgent: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string }> {
  const response = await fetchImpl(REDDIT_TOKEN, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': input.userAgent,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code.replace(/#_$/, ''),
      redirect_uri: input.redirectUri,
    }),
  });
  const data = (await response.json()) as { refresh_token?: string; error?: string; message?: string };
  if (!response.ok || !data.refresh_token) {
    throw new AdportError(
      'PROVIDER_ERROR',
      `Reddit OAuth exchange failed${data.error ? ` (${data.error})` : ''}: ${data.message ?? 'no refresh token returned'}`,
      data,
    );
  }
  return { refreshToken: data.refresh_token };
}

// ---- Microsoft identity platform (public client + PKCE) ---------------------

const MS_AUTHORIZE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const MS_ADS_SCOPE = 'openid profile https://ads.microsoft.com/msads.manage offline_access';

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export function buildMicrosoftAuthUrl(clientId: string, redirectUri: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: MS_ADS_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    state,
  });
  return `${MS_AUTHORIZE}?${params}`;
}

export async function exchangeMicrosoftCode(
  input: { clientId: string; code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string }> {
  const response = await fetchImpl(MS_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      scope: 'https://ads.microsoft.com/msads.manage offline_access',
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: input.codeVerifier,
    }),
  });
  const data = (await response.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!response.ok || !data.refresh_token) {
    throw new AdportError(
      'PROVIDER_ERROR',
      `Microsoft OAuth exchange failed${data.error ? ` (${data.error})` : ''}: ${data.error_description ?? ''}`,
      data,
    );
  }
  return { refreshToken: data.refresh_token };
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).unref();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}
