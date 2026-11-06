import { gtmTools, type CredentialStore, type ProviderModule } from '@adport/core';
import { GtmClient, type GtmCredentials } from './client.js';
import { GtmProvider } from './provider.js';
export { GtmClient, GTM_API_BASE, type GtmCredentials } from './client.js';
export { GtmProvider } from './provider.js';
export { gtmTools, GTM_SCOPES } from '@adport/core';

export async function resolveGtmCredentials(store: CredentialStore): Promise<GtmCredentials | undefined> {
  const data = (await store.get('gtm'))?.data;
  if (data?.client_id && data.client_secret && data.refresh_token) return {
    clientId: data.client_id, clientSecret: data.client_secret, refreshToken: data.refresh_token,
  };
  if (process.env.GTM_CLIENT_ID && process.env.GTM_CLIENT_SECRET && process.env.GTM_REFRESH_TOKEN) return {
    clientId: process.env.GTM_CLIENT_ID, clientSecret: process.env.GTM_CLIENT_SECRET, refreshToken: process.env.GTM_REFRESH_TOKEN,
  };
  return undefined;
}
export async function createGtmModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveGtmCredentials(store);
  if (!credentials) return undefined;
  const provider = new GtmProvider(new GtmClient(credentials));
  return { provider, tools: gtmTools(provider) };
}
