import { AdportError, CredentialStore } from '@adport/core';
import { MatomoClient, MatomoProvider, matomoCredentialsFromData, matomoEnvironmentData } from '@adport/provider-matomo';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';

export async function connectMatomo(input: { io: ProgramIO; fetchImpl?: typeof fetch; store?: CredentialStore }): Promise<void> {
  printLocalConnectionIntro(input.io, 'Matomo');
  input.io.out('Create an auth token in Matomo under Administration → Personal → Security → Auth tokens. A user with view access to the sites is enough.');
  input.io.out('This local flow imports MATOMO_URL and MATOMO_TOKEN_AUTH from your environment; the token is never echoed or typed at a prompt.');
  const credentials = matomoCredentialsFromData(matomoEnvironmentData());
  if (!credentials) throw new AdportError('INVALID_INPUT', 'Set MATOMO_URL and MATOMO_TOKEN_AUTH securely in your environment, then run `adport connect matomo` again.');
  const accounts = await new MatomoProvider(new MatomoClient(credentials, input.fetchImpl)).listAccounts();
  await (input.store ?? new CredentialStore()).set({ provider: 'matomo', source: 'byo', data: { url: credentials.url, token_auth: credentials.tokenAuth } });
  input.io.out(`Connected to ${credentials.url}: ${accounts.length} Matomo site(s) with view access.`);
  for (const account of accounts) input.io.out(`  ${account.id}  ${account.name}`);
  printLocalConnectionSaved(input.io);
}
