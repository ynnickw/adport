import readline from 'node:readline/promises';
import { AdportError, CredentialStore, GA4_SCOPES, GSC_SCOPES } from '@adport/core';
import { AnalyticsClient, Ga4Provider, SearchConsoleProvider } from '@adport/provider-analytics';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';
import { buildGoogleAuthUrl, exchangeCodeForTokens, generateOAuthState, generatePkce, openInBrowser, startLoopbackServer } from './oauth.js';

export async function connectAnalytics(provider: 'ga4' | 'gsc', input: { openBrowser: boolean; io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout }), store = new CredentialStore();
  const title = provider === 'ga4' ? 'Google Analytics 4' : 'Google Search Console', prefix = provider.toUpperCase();
  try {
    printLocalConnectionIntro(input.io, title);
    input.io.out(provider === 'ga4' ? 'Enable Google Analytics Data API and Google Analytics Admin API in your Google project.' : 'Enable Google Search Console API in your Google project.');
    input.io.out('Use an OAuth Desktop app client. This connection requests read-only access.');
    const existing = (await store.get(provider))?.data;
    const clientId = (await rl.question('OAuth client ID (Enter to reuse stored/environment): ')).trim() || existing?.client_id || process.env[`${prefix}_CLIENT_ID`] || '';
    const clientSecret = (clientId === existing?.client_id ? existing.client_secret : undefined) || process.env[`${prefix}_CLIENT_SECRET`] || '';
    if (!clientId || !clientSecret) throw new AdportError('INVALID_INPUT', `Set ${prefix}_CLIENT_SECRET securely in your terminal and provide the OAuth client ID.`);
    const pkce = generatePkce(), state = generateOAuthState(), loopback = await startLoopbackServer('127.0.0.1', state);
    let timeout: ReturnType<typeof setTimeout> | undefined, refreshToken: string;
    try {
      const url = buildGoogleAuthUrl(clientId, loopback.redirectUri, pkce.challenge, state, false, provider === 'ga4' ? GA4_SCOPES : GSC_SCOPES);
      input.io.out(`Authorize ${title}:\n  ${url}`); if (input.openBrowser) openInBrowser(url);
      const code = await Promise.race([loopback.waitForCode, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Analytics authorization timed out after five minutes.')), 300_000);
      })]);
      ({ refreshToken } = await exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri: loopback.redirectUri, codeVerifier: pkce.verifier }));
    } finally { clearTimeout(timeout); loopback.close(); }
    const client = new AnalyticsClient({ clientId, clientSecret, refreshToken });
    const accounts = await (provider === 'ga4' ? new Ga4Provider(client) : new SearchConsoleProvider(client)).listAccounts();
    await store.set({ provider, source: 'byo', data: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken } });
    input.io.out(`Connected: ${accounts.length} accessible ${title} properties.`); printLocalConnectionSaved(input.io);
  } finally { rl.close(); }
}
