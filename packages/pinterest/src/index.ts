import type { CredentialStore, ProviderModule } from '@adport/core';
import { PinterestAdsClient, type PinterestCredentials } from './client.js';
import { PinterestAdsProvider } from './provider.js';
import { pinterestTools } from './tools.js';
export { PinterestAdsClient, PINTEREST_API_BASE, PINTEREST_TOKEN_URL, buildPinterestAuthUrl, exchangePinterestCode, type PinterestCredentials } from './client.js';
export { PinterestAdsProvider } from './provider.js';
export { pinterestTools } from './tools.js';
export { accountSchema, campaignSchema } from './schemas.js';

export async function resolvePinterestCredentials(store: CredentialStore): Promise<PinterestCredentials | undefined> {
  const data = (await store.get('pinterest'))?.data;
  if (data?.client_id && data.client_secret && data.refresh_token) return {
    clientId: data.client_id, clientSecret: data.client_secret, refreshToken: data.refresh_token,
    onRefreshToken: async refreshToken => {
      const latest = await store.get('pinterest');
      if (latest) await store.set({ provider: 'pinterest', source: latest.source, data: { ...latest.data, refresh_token: refreshToken } });
    },
  };
  if (process.env.PINTEREST_CLIENT_ID && process.env.PINTEREST_CLIENT_SECRET && process.env.PINTEREST_REFRESH_TOKEN) return {
    clientId: process.env.PINTEREST_CLIENT_ID, clientSecret: process.env.PINTEREST_CLIENT_SECRET, refreshToken: process.env.PINTEREST_REFRESH_TOKEN,
  };
  return undefined;
}
export async function createPinterestModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolvePinterestCredentials(store);
  if (!credentials) return undefined;
  const provider = new PinterestAdsProvider(new PinterestAdsClient(credentials));
  return { provider, tools: pinterestTools(provider) };
}
