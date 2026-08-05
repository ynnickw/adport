import http from 'node:http';
import { spawn } from 'node:child_process';
import { AdportError } from '@adport/core';

export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function buildGoogleAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_ADS_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

export async function exchangeCodeForTokens(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
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
export async function startLoopbackServer(): Promise<LoopbackServer> {
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
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      code
        ? '<h2>adport is connected.</h2><p>You can close this tab and return to the terminal.</p>'
        : `<h2>Authorization failed${error ? `: ${error}` : ''}</h2><p>Return to the terminal and retry.</p>`,
    );
    if (code) resolveCode(code);
    else if (error) rejectCode(new Error(`OAuth authorization failed: ${error}`));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server failed to bind');
  return {
    redirectUri: `http://127.0.0.1:${address.port}`,
    waitForCode,
    close: () => server.close(),
  };
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
