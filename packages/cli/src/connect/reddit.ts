import readline from 'node:readline/promises';
import { CredentialStore } from '@adport/core';
import { RedditAdsClient, RedditAdsProvider, type RedditCredentials } from '@adport/provider-reddit';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';
import {
  buildRedditAuthUrl,
  exchangeRedditCode,
  generateOAuthState,
  openInBrowser,
  startLoopbackServer,
} from './oauth.js';

export async function connectReddit(input: { openBrowser: boolean; io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    printLocalConnectionIntro(input.io, 'Reddit Ads');
    input.io.out('Create a Reddit developer app at https://www.reddit.com/prefs/apps (type: web app).');
    input.io.out('Reddit requires the redirect URI to match exactly. For local use, register');
    input.io.out('http://localhost:53682 and keep this terminal running during authorization.');
    input.io.out('');

    const existing = await store.get('reddit');
    const clientId = (await rl.question(`App/client ID${existing?.data.client_id ? ' (Enter to reuse stored)' : ''}: `)).trim()
      || existing?.data.client_id || '';
    const clientSecret = (await rl.question(`App secret${existing?.data.client_secret ? ' (Enter to reuse stored)' : ''}: `)).trim()
      || existing?.data.client_secret || '';
    const redirectUri = (await rl.question('Exact redirect URI [http://localhost:53682]: ')).trim()
      || 'http://localhost:53682';
    const userAgent = (await rl.question(
      `Honest User-Agent${existing?.data.user_agent ? ' (Enter to reuse stored)' : ' (e.g. desktop:dev.adport.local:v0.5.0 (by /u/yourname))'}: `,
    )).trim() || existing?.data.user_agent || '';
    if (!clientId || !clientSecret || !userAgent) {
      input.io.err('Missing app id, app secret, or User-Agent — aborting.');
      process.exitCode = 1;
      return;
    }

    const redirect = validateLocalRedirect(redirectUri);
    const state = generateOAuthState();
    const loopback = await startLoopbackServer(
      redirect.hostname as '127.0.0.1' | 'localhost',
      state,
      Number(redirect.port),
      redirect.pathname === '/' ? '' : redirect.pathname,
    );
    const authUrl = buildRedditAuthUrl(clientId, redirectUri, state);
    input.io.out('Authorizing scopes: adsread, adsedit, adsdatadeletion (permanent refresh token).');
    if (input.openBrowser) {
      openInBrowser(authUrl);
      input.io.out(`If the browser did not open, visit:\n  ${authUrl}`);
    } else {
      input.io.out(`Open this URL in a browser on this machine:\n  ${authUrl}`);
    }

    let refreshToken: string;
    try {
      const code = await loopback.waitForCode;
      ({ refreshToken } = await exchangeRedditCode({ clientId, clientSecret, code, redirectUri, userAgent }));
    } finally {
      loopback.close();
    }
    const credentials: RedditCredentials = { clientId, clientSecret, refreshToken, userAgent };
    input.io.out('Verifying business and ad-account access…');
    const accounts = await new RedditAdsProvider(new RedditAdsClient(credentials)).listAccounts();
    await store.set({
      provider: 'reddit', source: 'byo',
      data: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, user_agent: userAgent },
    });
    input.io.out(`✓ Connected. ${accounts.length} accessible Reddit ad account(s).`);
    for (const account of accounts) input.io.out(`  ${account.id}  ${account.name}${account.currency ? `  ${account.currency}` : ''}`);
    printLocalConnectionSaved(input.io);
    input.io.out('Try:  adport accounts --provider reddit   ·   adport report --provider reddit   ·   adport mcp');
  } finally {
    rl.close();
  }
}

function validateLocalRedirect(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.port || url.search || url.hash) {
    throw new Error('Reddit local redirect URI must be http://localhost:<port> or http://127.0.0.1:<port>, optionally with a path.');
  }
  return url;
}
