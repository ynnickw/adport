import readline from 'node:readline/promises';
import { AdportError, CredentialStore } from '@adport/core';
import { PinterestAdsClient, PinterestAdsProvider, buildPinterestAuthUrl, exchangePinterestCode } from '@adport/provider-pinterest';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';
import { generateOAuthState, openInBrowser, startLoopbackServer } from './oauth.js';

export async function connectPinterest(input: { openBrowser: boolean; pinManagement?: boolean; secretPins?: boolean; catalogManagement?: boolean; io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    printLocalConnectionIntro(input.io, 'Pinterest Ads');
    input.io.out('Register your own app at developers.pinterest.com/apps and obtain Trial access for your own account or Standard access for external users.');
    input.io.out('Register http://localhost:53686/callback as an exact redirect URI on your app.');
    input.io.out(input.secretPins ? 'Secret Pin management additionally requests boards:read_secret, boards:write_secret, pins:read_secret and pins:write_secret. This permits access to private content. Your app must have native access to these scopes. No content is created by connecting.' : input.pinManagement ? 'Pin management requests Ads, public boards, public Pins and user-account permissions. Secret content requires --secret-pins separately. Your app must have native access to these scopes. No content is created by connecting.' : 'This flow requests ads:read and ads:write only. Use --pin-management for public Pin/image/video management, or --secret-pins to additionally authorize secret content.');
    const existing = (await store.get('pinterest'))?.data;
    if (input.catalogManagement) input.io.out('Catalog management additionally requests catalogs:read and catalogs:write. Combine --pin-management or --secret-pins to retain those permissions. Connecting does not create catalogs, feeds or products.');
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
      const authUrl = buildPinterestAuthUrl(clientId, redirectUri, state, { pinManagement: input.pinManagement, secretPins: input.secretPins, catalogManagement: input.catalogManagement });
      input.io.out(`Authorize your own Pinterest app:\n  ${authUrl}`);
      if (input.openBrowser) openInBrowser(authUrl);
      const code = await Promise.race([
        loopback.waitForCode,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Pinterest authorization timed out after five minutes.')), 300_000); }),
      ]);
      refreshToken = await exchangePinterestCode({ clientId, clientSecret, code, redirectUri, pinManagement: input.pinManagement, secretPins: input.secretPins, catalogManagement: input.catalogManagement });
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
