import { ga4Tools, gscTools, type CredentialStore, type ProviderModule } from '@adport/core';
import { AnalyticsClient, type AnalyticsCredentials } from './client.js';
import { Ga4Provider, SearchConsoleProvider } from './provider.js';
export { AnalyticsClient, type AnalyticsCredentials } from './client.js';
export { Ga4Provider, SearchConsoleProvider } from './provider.js';
export { ga4Tools, gscTools, GA4_SCOPES, GSC_SCOPES } from '@adport/core';

async function credentials(provider: 'ga4' | 'gsc', store: CredentialStore): Promise<AnalyticsCredentials | undefined> {
  const data = (await store.get(provider))?.data;
  if (data?.client_id && data.client_secret && data.refresh_token) return {
    clientId: data.client_id, clientSecret: data.client_secret, refreshToken: data.refresh_token,
  };
  const prefix = provider.toUpperCase();
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  const refreshToken = process.env[`${prefix}_REFRESH_TOKEN`];
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : undefined;
}
export async function createGa4Module(store: CredentialStore): Promise<ProviderModule | undefined> {
  const value = await credentials('ga4', store); if (!value) return undefined;
  const provider = new Ga4Provider(new AnalyticsClient(value)); return { provider, tools: ga4Tools(provider) };
}
export async function createGscModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const value = await credentials('gsc', store); if (!value) return undefined;
  const provider = new SearchConsoleProvider(new AnalyticsClient(value)); return { provider, tools: gscTools(provider) };
}
