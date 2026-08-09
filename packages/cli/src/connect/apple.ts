import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { CredentialStore } from '@adport/core';
import { AppleAdsClient, AppleAdsProvider } from '@adport/provider-apple';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';

/**
 * Apple Ads is fully self-serve for your own org: create an API user, generate
 * an EC key pair locally, upload the public key — no Apple approval involved.
 */
export async function connectApple({ io }: { io: ProgramIO }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    printLocalConnectionIntro(io, 'Apple Ads');
    io.out('Connecting Apple Ads (Apple Search Ads). One-time setup (~10 min, no approval):');
    io.out('  1. In ads.apple.com: Account Settings → API → create an API user (API role).');
    io.out('  2. Generate an EC key pair locally:');
    io.out('       openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem');
    io.out('       openssl ec -in private-key.pem -pubout -out public-key.pem');
    io.out('  3. Upload public-key.pem in Account Settings → API; Apple shows your');
    io.out('     clientId, teamId, and keyId (all needed below).');
    io.out('  Note: access tokens last 1h and are re-minted automatically; no rotation chores.');
    io.out('  Your private key stays on this machine; upload only the public key to Apple.');
    io.out('');

    const clientId = (await rl.question('clientId (SEARCHADS.xxxx): ')).trim();
    const teamId = (await rl.question(`teamId [${clientId}]: `)).trim() || clientId;
    const keyId = (await rl.question('keyId: ')).trim();
    const keyPath = (await rl.question('Path to private-key.pem: ')).trim();
    if (!clientId || !keyId || !keyPath) {
      io.err('Missing values — aborting.');
      process.exitCode = 1;
      return;
    }
    const privateKeyPem = await fs.readFile(expandHome(keyPath), 'utf8');

    io.out('Verifying access…');
    const provider = new AppleAdsProvider(new AppleAdsClient({ clientId, teamId, keyId, privateKeyPem }));
    const accounts = await provider.listAccounts();
    await store.set({
      provider: 'apple',
      source: 'byo',
      data: { client_id: clientId, team_id: teamId, key_id: keyId, private_key: privateKeyPem },
    });
    io.out('');
    io.out(`✓ Connected. ${accounts.length} organization(s):`);
    for (const account of accounts) {
      io.out(`  ${account.id}  ${account.name}  ${account.currency ?? ''}  ${account.status ?? ''}`);
    }
    printLocalConnectionSaved(io);
    io.out('');
    io.out('Heads-up: the Campaign Management API v5 sunsets 2027-01-26; adport will migrate');
    io.out('to the new Ads Platform API when its docs go live — your credentials carry over.');
    io.out('');
    io.out('Try:  adport accounts   ·   adport report --provider apple   ·   adport mcp');
  } finally {
    rl.close();
  }
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}
