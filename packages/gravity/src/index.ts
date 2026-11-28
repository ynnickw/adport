import type { CredentialStore, ProviderModule } from '@adport/core';
import { GravityClient, type GravityCredentials } from './client.js';
import { GravityProvider } from './provider.js';
import { gravityTools } from './tools.js';
export { GravityClient, GRAVITY_API_BASE, type GravityCredentials } from './client.js';
export { GravityProvider } from './provider.js';
export { gravityTools } from './tools.js';
export { advertiserSchema, campaignSchema, adGroupSchema, type GravityCampaign } from './schemas.js';

export function gravityCredentialsFromData(data: Record<string, string> | undefined): GravityCredentials | undefined {
  const apiKey = data?.api_key?.trim();
  return apiKey ? { apiKey } : undefined;
}
export function gravityEnvironmentData(): Record<string, string> {
  return { api_key: process.env.GRAVITY_API_KEY ?? '' };
}
export async function resolveGravityCredentials(store: CredentialStore): Promise<GravityCredentials | undefined> {
  return gravityCredentialsFromData((await store.get('gravity'))?.data) ?? gravityCredentialsFromData(gravityEnvironmentData());
}
export async function createGravityModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveGravityCredentials(store);
  if (!credentials) return undefined;
  const provider = new GravityProvider(new GravityClient(credentials));
  return { provider, tools: gravityTools(provider) };
}
