export { XAdsClient, X_ADS_API_BASE, type XAdsCredentials, type XParams } from './client.js';
export { XAdsEntities } from './entities.js';
export { XAdsProvider } from './provider.js';
export { XAdsAnalytics } from './analytics.js';
export { xTools } from './tools.js';
export { requestXToken, buildXAuthorizationUrl, exchangeXToken, revokeXToken, type XRequestTokens, type XUserTokens } from './oauth.js';

import { type CredentialStore, type ProviderModule } from '@adport/core';
import { XAdsClient, type XAdsCredentials } from './client.js';
import { XAdsProvider } from './provider.js';
import { xTools } from './tools.js';

export function xCredentialsFromData(data: Record<string, string> | undefined): XAdsCredentials | undefined {
  if (!data?.consumer_key?.trim() || !data.consumer_secret?.trim() || !data.access_token?.trim() || !data.access_token_secret?.trim()) return undefined;
  return { consumerKey: data.consumer_key, consumerSecret: data.consumer_secret, accessToken: data.access_token, accessTokenSecret: data.access_token_secret };
}
export function xEnvironmentData(): Record<string, string> {
  return { consumer_key: process.env.X_CONSUMER_KEY ?? '', consumer_secret: process.env.X_CONSUMER_SECRET ?? '', access_token: process.env.X_ACCESS_TOKEN ?? '', access_token_secret: process.env.X_ACCESS_TOKEN_SECRET ?? '' };
}
export async function resolveXCredentials(store: CredentialStore): Promise<XAdsCredentials | undefined> {
  return xCredentialsFromData((await store.get('x'))?.data) ?? xCredentialsFromData(xEnvironmentData());
}
export async function createXModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveXCredentials(store);
  if (!credentials) return undefined;
  const provider = new XAdsProvider(new XAdsClient(credentials));
  return { provider, tools: xTools(provider) };
}
