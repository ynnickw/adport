import readline from 'node:readline/promises';
import { CredentialStore } from '@adport/core';
import { TikTokAdsProvider, TikTokClient } from '@adport/provider-tiktok';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';

/**
 * TikTok requires app review before production access (2 days–2 weeks) — but
 * the sandbox works the same day. The wizard supports both.
 */
export async function connectTikTok({ io }: { io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    printLocalConnectionIntro(io, 'TikTok Ads');
    io.out('Connecting TikTok Ads (Marketing API). Setup:');
    io.out('  1. Register at https://business-api.tiktok.com/portal and create an app.');
    io.out('     Production needs human review (2 days–2 weeks). SANDBOX works today:');
    io.out('     My Apps → your app → "Create a Sandbox Ad Account" → generate token there.');
    io.out('  2. For production: authorize your advertiser account via the app\'s auth URL,');
    io.out('     then exchange the auth_code (the portal shows the flow). Tokens never expire.');
    io.out('');

    const sandboxAnswer = (await rl.question('Use the SANDBOX environment? [y/N] ')).trim().toLowerCase();
    const sandbox = sandboxAnswer === 'y' || sandboxAnswer === 'yes';
    const appId = (await rl.question('App id: ')).trim();
    const secret = (await rl.question('App secret: ')).trim();
    const accessToken = (await rl.question('Access token: ')).trim();
    if (!appId || !secret || !accessToken) {
      io.err('Missing values — aborting.');
      process.exitCode = 1;
      return;
    }

    io.out('Verifying access…');
    const provider = new TikTokAdsProvider(new TikTokClient({ accessToken, appId, secret, sandbox }), {
      appId,
      secret,
    });
    const accounts = await provider.listAccounts();
    await store.set({
      provider: 'tiktok',
      source: 'byo',
      data: { access_token: accessToken, app_id: appId, secret, ...(sandbox ? { sandbox: 'true' } : {}) },
    });
    io.out('');
    io.out(`✓ Connected${sandbox ? ' (sandbox)' : ''}. ${accounts.length} advertiser account(s):`);
    for (const account of accounts) {
      io.out(`  ${account.id}  ${account.name}  ${account.currency ?? ''}  ${account.status ?? ''}`);
    }
    printLocalConnectionSaved(io);
    io.out('');
    io.out('Try:  adport accounts   ·   adport report --provider tiktok   ·   adport mcp');
  } finally {
    rl.close();
  }
}
