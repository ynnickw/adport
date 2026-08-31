import readline from 'node:readline/promises';
import { AdportError, CredentialStore } from '@adport/core';
import { SpotifyAdsClient, SpotifyAdsProvider, buildSpotifyAuthUrl, exchangeSpotifyCode } from '@adport/provider-spotify';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';
import { generateOAuthState, openInBrowser, startLoopbackServer } from './oauth.js';

export async function connectSpotify(input: { openBrowser: boolean; io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    printLocalConnectionIntro(input.io, 'Spotify Ads');
    input.io.out('Create your own app at developer.spotify.com/dashboard, select Ads API, and accept the Ads API terms in Ads Manager for that client ID.');
    input.io.out('Allowlisting can take one hour. Register http://127.0.0.1:53685/callback as the exact local redirect URI.');
    const existing = (await store.get('spotify'))?.data;
    const clientId = (await rl.question('Client ID (Enter to reuse stored/environment): ')).trim() || existing?.client_id || process.env.SPOTIFY_CLIENT_ID || '';
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || existing?.client_secret || '';
    if (!clientId || !clientSecret) {
      throw new AdportError('INVALID_INPUT', 'Set SPOTIFY_CLIENT_SECRET securely in your terminal environment and provide a client ID. Secrets are not requested through echoed terminal prompts.');
    }
    const redirectUri = (await rl.question('Exact local redirect URI [http://127.0.0.1:53685/callback]: ')).trim() || 'http://127.0.0.1:53685/callback';
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
      throw new AdportError('INVALID_INPUT', 'Use an http://127.0.0.1:<port> loopback callback registered on your Spotify app.');
    }
    const state = generateOAuthState();
    const loopback = await startLoopbackServer('127.0.0.1', state, Number(redirect.port), redirect.pathname);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let refreshToken: string;
    try {
      const authUrl = buildSpotifyAuthUrl(clientId, redirectUri, state);
      input.io.out(`Authorize your own Spotify Ads app:\n  ${authUrl}`);
      if (input.openBrowser) openInBrowser(authUrl);
      const code = await Promise.race([
        loopback.waitForCode,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Spotify authorization timed out after five minutes.')), 300_000); }),
      ]);
      refreshToken = await exchangeSpotifyCode({ clientId, clientSecret, code, redirectUri });
    } finally {
      clearTimeout(timeout);
      loopback.close();
    }
    const client = new SpotifyAdsClient({ clientId, clientSecret, refreshToken, onRefreshToken: async token => { refreshToken = token; } });
    const accounts = await new SpotifyAdsProvider(client).listAccounts();
    await store.set({ provider: 'spotify', source: 'byo', data: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, redirect_uri: redirectUri } });
    input.io.out(`Connected: ${accounts.length} accessible Spotify ad account(s).`);
    for (const account of accounts) input.io.out(`  ${account.id}  ${account.name}  ${account.currency}`);
    printLocalConnectionSaved(input.io);
  } finally {
    rl.close();
  }
}
