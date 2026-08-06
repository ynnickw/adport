import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import YAML from 'yaml';
import { CredentialStore } from '@adport/core';
import { GoogleAdsRestClient, type GoogleCredentials } from '@adport/provider-google';
import type { ProgramIO } from '../program.js';
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  openInBrowser,
  parseClientSecretJson,
  startLoopbackServer,
} from './oauth.js';

export interface ConnectGoogleOptions {
  openBrowser: boolean;
  io: ProgramIO;
}

/**
 * Guided Google Ads connection. Since Google's Explorer access tier (Oct 2025),
 * a fresh developer token works on production accounts the same day — the wizard's
 * job is navigation, not waiting.
 */
export async function connectGoogle({ openBrowser, io }: ConnectGoogleOptions): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const store = new CredentialStore();
  try {
    // Re-auth fast path: keep the stored developer token + OAuth client and
    // only redo the browser consent (covers expired/revoked refresh tokens).
    const existing = await store.get('google');
    if (existing?.data.developer_token && existing.data.client_id && existing.data.client_secret) {
      const answer = (
        await rl.question(
          'Existing Google connection found. Re-authorize with the same developer token and OAuth client? [Y/n] ',
        )
      )
        .trim()
        .toLowerCase();
      if (answer !== 'n' && answer !== 'no') {
        const refreshToken = await runOAuthFlow(
          existing.data.client_id,
          existing.data.client_secret,
          openBrowser,
          io,
        );
        await verifyAndSave(
          {
            developerToken: existing.data.developer_token,
            clientId: existing.data.client_id,
            clientSecret: existing.data.client_secret,
            refreshToken,
            loginCustomerId: existing.data.login_customer_id || undefined,
          },
          store,
          io,
        );
        return;
      }
    }

    io.out('');
    io.out('Connecting Google Ads. You need (the wizard guides each step):');
    io.out('  1. A manager account (MCC) — free, instant:  https://ads.google.com/home/tools/manager-accounts/');
    io.out('  2. A developer token from the MCC API Center (Explorer access is automatic): https://ads.google.com/aw/apicenter');
    io.out('  3. A Google Cloud OAuth "Desktop app" client:  https://console.cloud.google.com/apis/credentials');
    io.out('     (enable the "Google Ads API" for the project, consent screen: External, add yourself as test user)');
    io.out('');

    // Fast path: import an existing google-ads.yaml (the ecosystem convention).
    const imported = await tryImportGoogleAdsYaml(rl, io);
    let creds: GoogleCredentials;
    if (imported) {
      creds = imported;
    } else {
      const developerToken = (await rl.question('Developer token (from the MCC API Center): ')).trim();

      let clientId = '';
      let clientSecret = '';
      const secretPath = (
        await rl.question('Path to downloaded client_secret_*.json (or press Enter to type id/secret manually): ')
      ).trim();
      if (secretPath) {
        const parsed = parseClientSecretJson(await fs.readFile(expandHome(secretPath), 'utf8'));
        clientId = parsed.clientId;
        clientSecret = parsed.clientSecret;
      } else {
        clientId = (await rl.question('OAuth client id: ')).trim();
        clientSecret = (await rl.question('OAuth client secret: ')).trim();
      }

      const loginCustomerId =
        (await rl.question('Manager (MCC) customer id for login-customer-id (Enter to skip): ')).trim() || undefined;

      const refreshToken = await runOAuthFlow(clientId, clientSecret, openBrowser, io);
      creds = { developerToken, clientId, clientSecret, refreshToken, loginCustomerId };
    }

    await verifyAndSave(creds, store, io);
  } finally {
    rl.close();
  }
}

async function runOAuthFlow(
  clientId: string,
  clientSecret: string,
  openBrowser: boolean,
  io: ProgramIO,
): Promise<string> {
  io.out('');
  io.out('Starting the OAuth flow (scope: Google Ads). A browser window should open;');
  io.out('sign in with the Google account that can access your ad accounts.');
  const loopback = await startLoopbackServer();
  const authUrl = buildGoogleAuthUrl(clientId, loopback.redirectUri);
  if (openBrowser) {
    openInBrowser(authUrl);
    io.out(`If the browser did not open, visit:\n  ${authUrl}`);
  } else {
    io.out(`Open this URL in a browser on this machine (or SSH port-forward the shown port):\n  ${authUrl}`);
  }
  try {
    const code = await loopback.waitForCode;
    const tokens = await exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri: loopback.redirectUri });
    return tokens.refreshToken;
  } finally {
    loopback.close();
  }
}

async function verifyAndSave(creds: GoogleCredentials, store: CredentialStore, io: ProgramIO): Promise<void> {
  io.out('Verifying access…');
  const client = new GoogleAdsRestClient(creds);
  const customers = await client.listAccessibleCustomers();
  await store.set({
    provider: 'google',
    source: 'byo',
    data: {
      developer_token: creds.developerToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      ...(creds.loginCustomerId ? { login_customer_id: creds.loginCustomerId } : {}),
    },
  });
  io.out('');
  io.out(`✓ Connected. ${customers.length} accessible customer id(s): ${customers.join(', ')}`);
  io.out('');
  io.out('If this token expires again in ~7 days: your OAuth consent screen is in "Testing"');
  io.out('status — set it to "In production" at console.cloud.google.com/apis/credentials/consent');
  io.out('(no verification needed for your own use; refresh tokens then stop expiring weekly).');
  io.out('');
  io.out('Try:  adport accounts   ·   adport report --provider google   ·   adport mcp');
}

async function tryImportGoogleAdsYaml(
  rl: readline.Interface,
  io: ProgramIO,
): Promise<GoogleCredentials | undefined> {
  const candidates = [
    process.env.GOOGLE_ADS_CONFIGURATION_FILE_PATH,
    path.join(os.homedir(), 'google-ads.yaml'),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    const parsed = YAML.parse(raw) as Record<string, unknown> | null;
    const developerToken = str(parsed?.developer_token);
    const clientId = str(parsed?.client_id);
    const clientSecret = str(parsed?.client_secret);
    const refreshToken = str(parsed?.refresh_token);
    if (!developerToken || !clientId || !clientSecret || !refreshToken) continue;
    const answer = (await rl.question(`Found ${candidate} — import it? [Y/n] `)).trim().toLowerCase();
    if (answer === 'n' || answer === 'no') continue;
    io.out(`Importing credentials from ${candidate}.`);
    return {
      developerToken,
      clientId,
      clientSecret,
      refreshToken,
      loginCustomerId: str(parsed?.login_customer_id) || undefined,
    };
  }
  return undefined;
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}
