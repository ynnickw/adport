import readline from 'node:readline/promises';
import { AdportError, CredentialStore } from '@adport/core';
import { PinterestAdsClient, PinterestAdsProvider, buildPinterestAuthUrl, exchangePinterestCode } from '@adport/provider-pinterest';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';
import { generateOAuthState, openInBrowser, startLoopbackServer } from './oauth.js';

export async function connectPinterest(input: { openBrowser: boolean; io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    printLocalConnectionIntro(input.io, 'Pinterest Ads');
    input.io.out('Register your own app at developers.pinterest.com/apps and obtain Trial access for your own account or Standard access for external users.');
    input.io.out('Register http://localhost:53686/callback as an exact redirect URI on your app. This local flow requests ads:read and ads:write only.');
    const existing = (await store.get('pinterest'))?.data;
    const clientId = (await rl.question('App ID (Enter to reuse stored/environment): ')).trim() || existing?.client_id || process.env.PINTEREST_CLIENT_ID || '';
    const clientSecret = process.env.PINTEREST_CLIENT_SECRET || existing?.client_secret || '';
    if (!clientId || !clientSecret) throw new AdportError('INVALID_INPUT', 'Set PINTEREST_CLIENT_SECRET securely in your terminal environment and provide an app ID. Secrets are not requested through echoed terminal prompts.');
    const redirectUri = (await rl.question('Exact local redirect URI [http://localhost:53686/callback]: ')).trim() || 'http://localhost:53686/callback';
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname) || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
      throw new AdportError('INVALID_INPUT', 'Use an http://localhost:<port> or http://127.0.0.1:<port> callback registered on your Pinterest app.');
    }
    const state = generateOAuthState();
    const loopback = await startLoopbackServer(redirect.hostname as 'localhost' | '127.0.0.1', state, Number(redirect.port), redirect.pathname);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let refreshToken: string;
    try {
      const authUrl = buildPinterestAuthUrl(clientId, redirectUri, state);
      input.io.out(`Authorize your own Pinterest app:\n  ${authUrl}`);
      if (input.openBrowser) openInBrowser(authUrl);
      const code = await Promise.race([
        loopback.waitForCode,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Pinterest authorization timed out after five minutes.')), 300_000); }),
      ]);
      refreshToken = await exchangePinterestCode({ clientId, clientSecret, code, redirectUri });
    } finally {
      clearTimeout(timeout); loopback.close();
    }
    const client = new PinterestAdsClient({ clientId, clientSecret, refreshToken, onRefreshToken: async token => { refreshToken = token; } });
    const accounts = await new PinterestAdsProvider(client).listAccounts();
    await store.set({ provider: 'pinterest', source: 'byo', data: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, redirect_uri: redirectUri } });
    input.io.out(`Connected: ${accounts.length} accessible Pinterest ad account(s).`);
    for (const account of accounts) input.io.out(`  ${account.id}  ${account.name}  ${account.currency ?? ''}`);
    printLocalConnectionSaved(input.io);
  } finally {
    rl.close();
  }
}
