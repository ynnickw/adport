import readline from 'node:readline/promises';
import { AdportError, CredentialStore, GTM_SCOPES } from '@adport/core';
import { GtmClient, GtmProvider } from '@adport/provider-gtm';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';
import { buildGoogleAuthUrl, exchangeCodeForTokens, generateOAuthState, generatePkce, openInBrowser, startLoopbackServer } from './oauth.js';

export async function connectGtm(input: { openBrowser: boolean; io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    printLocalConnectionIntro(input.io, 'Google Tag Manager');
    input.io.out('Enable Tag Manager API in your Google Cloud project and create an OAuth Desktop app client.');
    input.io.out('This flow requests container editing, version creation and publishing. Every change uses preview/apply.');
    const existing = (await store.get('gtm'))?.data;
    const clientId = (await rl.question('OAuth client ID (Enter to reuse stored/environment): ')).trim() || existing?.client_id || process.env.GTM_CLIENT_ID || '';
    const clientSecret = existing?.client_secret || process.env.GTM_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) throw new AdportError('INVALID_INPUT', 'Set GTM_CLIENT_SECRET securely in your terminal and provide the OAuth client ID.');
    const pkce = generatePkce();
    const state = generateOAuthState();
    const loopback = await startLoopbackServer('127.0.0.1', state);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let refreshToken: string;
    try {
      const authUrl = buildGoogleAuthUrl(clientId, loopback.redirectUri, pkce.challenge, state, false, GTM_SCOPES);
      input.io.out(`Authorize your Google Tag Manager connection:\n  ${authUrl}`);
      if (input.openBrowser) openInBrowser(authUrl);
      const code = await Promise.race([loopback.waitForCode, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('GTM authorization timed out after five minutes.')), 300_000);
      })]);
      ({ refreshToken } = await exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri: loopback.redirectUri, codeVerifier: pkce.verifier }));
    } finally { clearTimeout(timeout); loopback.close(); }
    const accounts = await new GtmProvider(new GtmClient({ clientId, clientSecret, refreshToken })).listAccounts();
    await store.set({ provider: 'gtm', source: 'byo', data: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken } });
    input.io.out(`Connected: ${accounts.length} accessible Google Tag Manager account(s).`);
    printLocalConnectionSaved(input.io);
  } finally { rl.close(); }
}
