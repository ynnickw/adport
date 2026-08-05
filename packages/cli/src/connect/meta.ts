import readline from 'node:readline/promises';
import { CredentialStore } from '@adport/core';
import { MetaAdsProvider, MetaGraphClient, type MetaCredentials } from '@adport/provider-meta';
import type { ProgramIO } from '../program.js';

export interface ConnectMetaOptions {
  io: ProgramIO;
}

/**
 * Guided Meta connection. For your own ad accounts no App Review is needed:
 * a dev-mode Business app + a system-user token (non-expiring) is the whole setup.
 */
export async function connectMeta({ io }: ConnectMetaOptions): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    io.out('');
    io.out('Connecting Meta Ads. One-time setup (~20-30 min, no review for your own accounts):');
    io.out('  1. Create a Business-type app (dev mode is fine): https://developers.facebook.com/apps/');
    io.out('     Add the "Marketing API" product to it.');
    io.out('  2. RECOMMENDED token — system user (never expires):');
    io.out('     Business Settings → Users → System users → Add → generate token');
    io.out('     with ads_read + ads_management, and assign your ad account(s) to it.');
    io.out('     https://business.facebook.com/settings/system-users');
    io.out('  3. Alternative — a user token from Graph API Explorer (expires after ~60 days');
    io.out('     when extended; adport will warn you, but system-user tokens avoid this).');
    io.out('');

    const accessToken = (await rl.question('Paste your access token: ')).trim();
    if (!accessToken) {
      io.err('No token provided — aborting.');
      process.exitCode = 1;
      return;
    }
    const appId = (await rl.question('App id (optional, enables token-expiry checks — Enter to skip): ')).trim();
    const appSecret = appId
      ? (await rl.question('App secret (optional, stored locally with mode 0600): ')).trim()
      : '';

    const credentials: MetaCredentials = {
      accessToken,
      appId: appId || undefined,
      appSecret: appSecret || undefined,
    };

    io.out('Verifying access…');
    const client = new MetaGraphClient(credentials);
    const provider = new MetaAdsProvider(client);
    const accounts = await provider.listAccounts();

    const debug = await client.debugToken();
    await store.set({
      provider: 'meta',
      source: 'byo',
      data: {
        access_token: accessToken,
        ...(appId ? { app_id: appId } : {}),
        ...(appSecret ? { app_secret: appSecret } : {}),
      },
    });

    io.out('');
    io.out(`✓ Connected. ${accounts.length} ad account(s):`);
    for (const account of accounts) {
      io.out(`  ${account.id}  ${account.name}  ${account.currency ?? ''}  ${account.status ?? ''}`);
    }
    if (debug?.expiresAt) {
      const days = Math.round((debug.expiresAt * 1000 - Date.now()) / 86_400_000);
      io.out(
        days > 0
          ? `⚠ This token expires in ~${days} days. Switch to a system-user token to avoid silent breakage.`
          : '⚠ This token is expired or expiring — generate a system-user token.',
      );
    } else if (debug) {
      io.out('Token has no expiry (system-user token) — ideal.');
    }
    io.out('');
    io.out('Try:  adport accounts   ·   adport report --provider meta   ·   adport mcp');
  } finally {
    rl.close();
  }
}
