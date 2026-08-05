import type { CredentialStore, ProviderModule } from '@adport/core';
import { MetaGraphClient, type MetaCredentials } from './client.js';
import { MetaAdsProvider } from './provider.js';
import { metaTools } from './tools.js';

export {
  MetaGraphClient,
  DEFAULT_GRAPH_VERSION,
  normalizeAccountId,
  formatMetaError,
  ACCOUNT_STATUS,
  type MetaCredentials,
} from './client.js';
export { MetaAdsProvider, CENTS_TO_MICROS } from './provider.js';
export { metaTools } from './tools.js';

/** Credential store record first, then META_ACCESS_TOKEN env fallback. */
export async function resolveMetaCredentials(store: CredentialStore): Promise<MetaCredentials | undefined> {
  const record = await store.get('meta');
  if (record?.data.access_token) {
    return {
      accessToken: record.data.access_token,
      appId: record.data.app_id || undefined,
      appSecret: record.data.app_secret || undefined,
    };
  }
  if (process.env.META_ACCESS_TOKEN) {
    return {
      accessToken: process.env.META_ACCESS_TOKEN,
      appId: process.env.META_APP_ID || undefined,
      appSecret: process.env.META_APP_SECRET || undefined,
    };
  }
  return undefined;
}

/** Provider module for createContext(); undefined when Meta isn't connected. */
export async function createMetaModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveMetaCredentials(store);
  if (!credentials) return undefined;
  const provider = new MetaAdsProvider(new MetaGraphClient(credentials));
  return { provider, tools: metaTools(provider) };
}
