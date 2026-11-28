import { AdportError, CredentialStore } from '@adport/core';
import { GravityClient, GravityProvider, gravityCredentialsFromData, gravityEnvironmentData } from '@adport/provider-gravity';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';

export async function connectGravity(input: { io: ProgramIO }): Promise<void> {
  printLocalConnectionIntro(input.io, 'Gravity');
  input.io.out('Copy the advertiser API key from the Gravity dashboard (https://app.trygravity.com), Settings → Organization. Only owners and admins can see it; it has full account access.');
  input.io.out('This local flow imports the key from your environment; it is never echoed or typed at a prompt.');
  const data = gravityEnvironmentData(), credentials = gravityCredentialsFromData(data);
  if (!credentials) throw new AdportError('INVALID_INPUT', 'Set GRAVITY_API_KEY securely in your environment, then run `adport connect gravity` again.');
  const accounts = await new GravityProvider(new GravityClient(credentials)).listAccounts();
  await new CredentialStore().set({ provider: 'gravity', source: 'byo', data: { api_key: credentials.apiKey } });
  input.io.out(`Connected: ${accounts.length} Gravity advertiser account(s).`);
  for (const account of accounts) input.io.out(`  ${account.id}  ${account.name}`);
  printLocalConnectionSaved(input.io);
}
