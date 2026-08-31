import type { CredentialStore, ProviderModule } from '@adport/core';
import { SnapchatAdsClient, type SnapchatCredentials } from './client.js';
import { SnapchatAdsProvider } from './provider.js';
import { snapchatTools } from './tools.js';
export { SnapchatAdsClient, SNAPCHAT_API_BASE, SNAPCHAT_TOKEN_URL, SNAPCHAT_SCOPE, buildSnapchatAuthUrl, exchangeSnapchatCode, type SnapchatCredentials } from './client.js';
export { SnapchatAdsProvider, accountMidnight } from './provider.js';
export { snapchatTools } from './tools.js';
export { accountSchema, campaignSchema, organizationSchema, statSchema, type SnapchatCampaign } from './schemas.js';

export async function resolveSnapchatCredentials(store: CredentialStore): Promise<SnapchatCredentials | undefined> {
  const record = await store.get('snapchat');
  const data = record?.data;
  if (data?.client_id && data.client_secret && data.refresh_token) return {
    clientId: data.client_id, clientSecret: data.client_secret, refreshToken: data.refresh_token,
    onRefreshToken: async refreshToken => {
      const latest = await store.get('snapchat');
      if (latest) await store.set({ provider: 'snapchat', source: latest.source, data: { ...latest.data, refresh_token: refreshToken } });
    },
  };
  if (process.env.SNAPCHAT_CLIENT_ID && process.env.SNAPCHAT_CLIENT_SECRET && process.env.SNAPCHAT_REFRESH_TOKEN) return {
    clientId: process.env.SNAPCHAT_CLIENT_ID, clientSecret: process.env.SNAPCHAT_CLIENT_SECRET, refreshToken: process.env.SNAPCHAT_REFRESH_TOKEN,
  };
  return undefined;
}

export async function createSnapchatModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveSnapchatCredentials(store);
  if (!credentials) return undefined;
  const provider = new SnapchatAdsProvider(new SnapchatAdsClient(credentials));
  return { provider, tools: snapchatTools(provider) };
}
