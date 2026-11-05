import type { CredentialStore, ProviderModule } from '@adport/core';
import { TikTokClient, type TikTokCredentials } from './client.js';
import { TikTokAdsProvider } from './provider.js';
import { tiktokTools } from './tools.js';
import { FileTikTokCatalogAccessStore } from './catalog-access.js';
import { LocalMediaResolver } from '@adport/core';

export { TikTokClient, TIKTOK_API_VERSION, type TikTokCredentials } from './client.js';
export { TikTokAdsProvider, UNITS_TO_MICROS } from './provider.js';
export { tiktokTools } from './tools.js';
export { TikTokCatalogService } from './catalogs.js';
export { tiktokCatalogTools } from './catalog-tools.js';
export { FileTikTokCatalogAccessStore, catalogGrant, catalogScope, catalogScopeKey, requireCatalogAccess, type TikTokCatalogAccessMode, type TikTokCatalogAccessStore, type TikTokCatalogGrant, type TikTokCatalogScope } from './catalog-access.js';

export async function resolveTikTokCredentials(
  store: CredentialStore,
): Promise<(TikTokCredentials & { appId: string; secret: string }) | undefined> {
  const record = await store.get('tiktok');
  if (record?.data.access_token && record.data.app_id && record.data.secret) {
    return {
      accessToken: record.data.access_token,
      appId: record.data.app_id,
      secret: record.data.secret,
      sandbox: record.data.sandbox === 'true',
    };
  }
  const env = process.env;
  if (env.TIKTOK_ACCESS_TOKEN && env.TIKTOK_APP_ID && env.TIKTOK_APP_SECRET) {
    return {
      accessToken: env.TIKTOK_ACCESS_TOKEN,
      appId: env.TIKTOK_APP_ID,
      secret: env.TIKTOK_APP_SECRET,
      sandbox: env.TIKTOK_SANDBOX === 'true',
    };
  }
  return undefined;
}

export async function createTikTokModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveTikTokCredentials(store);
  if (!credentials) return undefined;
  const provider = new TikTokAdsProvider(new TikTokClient(credentials), {
    appId: credentials.appId,
    secret: credentials.secret,
  }, new LocalMediaResolver(), new FileTikTokCatalogAccessStore());
  return { provider, tools: tiktokTools(provider, { catalogAccessManagement: true }) };
}
