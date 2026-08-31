import readline from 'node:readline/promises';
import { AdportError, CredentialStore } from '@adport/core';
import { SnapchatAdsClient, SnapchatAdsProvider, buildSnapchatAuthUrl, exchangeSnapchatCode } from '@adport/provider-snapchat';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';
import { generateOAuthState, openInBrowser, startLoopbackServer } from './oauth.js';

export async function connectSnapchat(input: { openBrowser: boolean; io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    printLocalConnectionIntro(input.io, 'Snapchat Ads');
    input.io.out('In Snap Business Manager → Business Details → OAuth Apps, create your own app.');
    input.io.out('Register the exact local callback http://127.0.0.1:53684/callback (or supply your registered local callback below).');
    const existing = (await store.get('snapchat'))?.data;
    const clientId = (await rl.question('Client ID (Enter to reuse stored/environment): ')).trim() || process.env.SNAPCHAT_CLIENT_ID || existing?.client_id || '';
    const clientSecret = process.env.SNAPCHAT_CLIENT_SECRET || (existing?.client_id === clientId ? existing.client_secret : '') || '';
    if (!clientId || !clientSecret) {
      throw new AdportError('INVALID_INPUT', 'Set SNAPCHAT_CLIENT_SECRET securely in your terminal environment and provide a client ID. Secrets are not requested through echoed terminal prompts.');
    }
    const defaultRedirect = (existing?.client_id === clientId && existing.redirect_uri) || 'http://127.0.0.1:53684/callback';
    const redirectUri = (await rl.question(`Exact local redirect URI [${defaultRedirect}]: `)).trim() || defaultRedirect;
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(redirect.hostname) || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
      throw new AdportError('INVALID_INPUT', 'Use an http://127.0.0.1:<port> or http://localhost:<port> loopback callback.');
    }
    const state = generateOAuthState();
    const loopback = await startLoopbackServer(redirect.hostname as '127.0.0.1' | 'localhost', state, Number(redirect.port), redirect.pathname);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let refreshToken: string;
    try {
      const authUrl = buildSnapchatAuthUrl(clientId, redirectUri, state);
      input.io.out(`Authorize your own app (read/write marketing access):\n  ${authUrl}`);
      if (input.openBrowser) openInBrowser(authUrl);
      const code = await Promise.race([
        loopback.waitForCode,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Snapchat authorization timed out after five minutes.')), 300_000); }),
      ]);
      refreshToken = await exchangeSnapchatCode({ clientId, clientSecret, code, redirectUri });
    } finally {
      clearTimeout(timeout);
      loopback.close();
    }
    const client = new SnapchatAdsClient({ clientId, clientSecret, refreshToken, onRefreshToken: async token => { refreshToken = token; } });
    const accounts = await new SnapchatAdsProvider(client).listAccounts();
    await store.set({ provider: 'snapchat', source: 'byo', data: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, redirect_uri: redirectUri } });
    input.io.out(`Connected: ${accounts.length} accessible Snapchat ad account(s).`);
    for (const account of accounts) input.io.out(`  ${account.id}  ${account.name}  ${account.currency}`);
    printLocalConnectionSaved(input.io);
  } finally {
    rl.close();
  }
}
