import type { CredentialStore, ProviderModule } from '@adport/core';
import { OpenAIAdsClient, type OpenAIAdsCredentials } from './client.js';
import { OpenAIAdsProvider } from './provider.js';
import { openaiTools } from './tools.js';
export { OpenAIAdsClient, OPENAI_ADS_API_BASE, type OpenAIAdsCredentials } from './client.js';
export { OpenAIAdsProvider } from './provider.js';
export { openaiTools } from './tools.js';
export { accountSchema, campaignSchema, insightRowSchema, type OpenAICampaign } from './schemas.js';

export function openaiCredentialsFromData(data: Record<string, string> | undefined): OpenAIAdsCredentials | undefined {
  const apiKey = data?.api_key?.trim();
  return apiKey ? { apiKey } : undefined;
}
export function openaiEnvironmentData(): Record<string, string> {
  return { api_key: process.env.OPENAI_ADS_API_KEY ?? '' };
}
export async function resolveOpenAICredentials(store: CredentialStore): Promise<OpenAIAdsCredentials | undefined> {
  return openaiCredentialsFromData((await store.get('openai'))?.data) ?? openaiCredentialsFromData(openaiEnvironmentData());
}
export async function createOpenAIModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveOpenAICredentials(store);
  if (!credentials) return undefined;
  const provider = new OpenAIAdsProvider(new OpenAIAdsClient(credentials));
  return { provider, tools: openaiTools(provider) };
}
