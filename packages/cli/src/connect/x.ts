import { AdportError, CredentialStore } from '@adport/core';
import { XAdsClient, XAdsProvider, xCredentialsFromData, xEnvironmentData } from '@adport/provider-x';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';

export async function connectX(input: { openBrowser: boolean; io: ProgramIO }): Promise<void> {
  printLocalConnectionIntro(input.io, 'X Ads');
  input.io.out('Use your own Ads API-approved X developer app. General X API access is not Ads API approval. Regenerate user access tokens after approval.');
  input.io.out('This local flow imports OAuth 1.0a credentials from your environment; no shared Cloud OAuth or echoed secret prompts are used.');
  const data = xEnvironmentData(), credentials = xCredentialsFromData(data);
  if (!credentials) throw new AdportError('INVALID_INPUT', 'Set X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET securely in your environment. All four must belong to the same approved app/user grant.');
  const accounts = await new XAdsProvider(new XAdsClient(credentials)).listAccounts();
  await new CredentialStore().set({ provider: 'x', source: 'byo', data });
  input.io.out(`Connected: ${accounts.length} accessible X ad account(s).`);
  for (const account of accounts) input.io.out(`  ${account.id}  ${account.name}`);
  printLocalConnectionSaved(input.io);
}
