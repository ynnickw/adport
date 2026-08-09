import readline from 'node:readline/promises';
import { CredentialStore } from '@adport/core';
import { MicrosoftAdsClient, MicrosoftAdsProvider, SANDBOX_DEVELOPER_TOKEN } from '@adport/provider-microsoft';
import type { ProgramIO } from '../program.js';
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  generateOAuthState,
  generatePkce,
  openInBrowser,
  startLoopbackServer,
} from './oauth.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';

/**
 * Microsoft Advertising is the friendliest setup of all providers: the dev
 * token is self-serve (no review), and the sandbox has a public universal token.
 */
export async function connectMicrosoft({ openBrowser, io }: { openBrowser: boolean; io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    printLocalConnectionIntro(io, 'Microsoft Advertising');
    io.out('Connecting Microsoft Advertising. Setup:');
    io.out('  1. Azure Portal → App registrations → New: "Mobile and desktop applications"');
    io.out('     platform with redirect URI http://localhost (public client, no secret).');
    io.out('  2. Developer token (self-serve, no review): sign in as Super Admin at');
    io.out('     https://ads.microsoft.com/cc/Settings/DevSettings → Request Token.');
    io.out(`  3. Sandbox alternative: universal token ${SANDBOX_DEVELOPER_TOKEN} works for everyone.`);
    io.out('  Microsoft may show an unverified-publisher or admin-consent notice for your');
    io.out('  Entra app; its branding and tenant policy belong to you, not Adport Cloud.');
    io.out('');

    const sandboxAnswer = (await rl.question('Use the SANDBOX environment? [y/N] ')).trim().toLowerCase();
    const sandbox = sandboxAnswer === 'y' || sandboxAnswer === 'yes';
    const clientId = (await rl.question('Azure application (client) id: ')).trim();
    const developerToken = sandbox
      ? SANDBOX_DEVELOPER_TOKEN
      : (await rl.question('Developer token: ')).trim();
    if (!clientId || !developerToken) {
      io.err('Missing values — aborting.');
      process.exitCode = 1;
      return;
    }

    io.out('');
    io.out('Starting the Microsoft sign-in (PKCE, no client secret)…');
    const pkce = generatePkce();
    const state = generateOAuthState();
    const loopback = await startLoopbackServer('localhost', state);
    const authUrl = buildMicrosoftAuthUrl(clientId, loopback.redirectUri, pkce.challenge, state);
    if (openBrowser) {
      openInBrowser(authUrl);
      io.out(`If the browser did not open, visit:\n  ${authUrl}`);
    } else {
      io.out(`Open this URL in a browser on this machine:\n  ${authUrl}`);
    }
    let refreshToken: string;
    try {
      const code = await loopback.waitForCode;
      ({ refreshToken } = await exchangeMicrosoftCode({
        clientId,
        code,
        redirectUri: loopback.redirectUri,
        codeVerifier: pkce.verifier,
      }));
    } finally {
      loopback.close();
    }

    io.out('Verifying access…');
    const provider = new MicrosoftAdsProvider(
      new MicrosoftAdsClient({ developerToken, clientId, refreshToken, sandbox }),
    );
    const accounts = await provider.listAccounts();
    await store.set({
      provider: 'microsoft',
      source: 'byo',
      data: {
        developer_token: developerToken,
        client_id: clientId,
        refresh_token: refreshToken,
        ...(sandbox ? { sandbox: 'true' } : {}),
      },
    });
    io.out('');
    io.out(`✓ Connected${sandbox ? ' (sandbox)' : ''}. ${accounts.length} ad account(s):`);
    for (const account of accounts) {
      io.out(`  ${account.id}  ${account.name}  ${account.currency ?? ''}  ${account.status ?? ''}`);
    }
    printLocalConnectionSaved(io);
    io.out('Note: public-client refresh tokens expire after ~90 days of disuse; adport');
    io.out('persists rotated tokens automatically on every use.');
    io.out('');
    io.out('Try:  adport accounts   ·   adport report --provider microsoft   ·   adport mcp');
  } finally {
    rl.close();
  }
}
