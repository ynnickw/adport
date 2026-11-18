import { AdportError, CredentialStore } from '@adport/core';
import { OpenAIAdsClient, OpenAIAdsProvider, openaiCredentialsFromData, openaiEnvironmentData } from '@adport/provider-openai';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';

export async function connectOpenAI(input: { io: ProgramIO }): Promise<void> {
  printLocalConnectionIntro(input.io, 'OpenAI Ads');
  input.io.out('Create an Advertiser API key in Ads Manager settings (https://ads.openai.com/settings). Each key is bound to one ad account.');
  input.io.out('This local flow imports the key from your environment; it is never echoed or typed at a prompt.');
  const data = openaiEnvironmentData(), credentials = openaiCredentialsFromData(data);
  if (!credentials) throw new AdportError('INVALID_INPUT', 'Set OPENAI_ADS_API_KEY securely in your environment, then run `adport connect openai` again.');
  const accounts = await new OpenAIAdsProvider(new OpenAIAdsClient(credentials)).listAccounts();
  await new CredentialStore().set({ provider: 'openai', source: 'byo', data: { api_key: credentials.apiKey } });
  input.io.out(`Connected: ${accounts.length} OpenAI Ads account(s).`);
  for (const account of accounts) input.io.out(`  ${account.id}  ${account.name}`);
  printLocalConnectionSaved(input.io);
}
