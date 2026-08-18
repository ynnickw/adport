import type { CredentialRepository, ProviderModule } from '@adport/core';
import { GoogleAdsRestClient, type GoogleCredentials } from './client.js';
import { GoogleAdsProvider } from './provider.js';
import { googleTools } from './tools.js';

export { GoogleAdsRestClient, DEFAULT_API_VERSION, normalizeCustomerId, formatGoogleAdsError, type GoogleCredentials } from './client.js';
export { GoogleAdsProvider } from './provider.js';
export { googleTools } from './tools.js';

/**
 * Resolve Google credentials: adport credential store first, then the
 * google-ads.yaml-style GOOGLE_ADS_* environment variables.
 */
export async function resolveGoogleCredentials(store: CredentialRepository): Promise<GoogleCredentials | undefined> {
  const record = await store.get('google');
  if (record) {
    const { developer_token, client_id, client_secret, refresh_token, login_customer_id } = record.data;
    if (developer_token && client_id && client_secret && refresh_token) {
      return {
        developerToken: developer_token,
        clientId: client_id,
        clientSecret: client_secret,
        refreshToken: refresh_token,
        loginCustomerId: login_customer_id || undefined,
      };
    }
  }
  const env = process.env;
  if (env.GOOGLE_ADS_DEVELOPER_TOKEN && env.GOOGLE_ADS_CLIENT_ID && env.GOOGLE_ADS_CLIENT_SECRET && env.GOOGLE_ADS_REFRESH_TOKEN) {
    return {
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
      clientId: env.GOOGLE_ADS_CLIENT_ID,
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
      loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || undefined,
    };
  }
  return undefined;
}

/** Provider module for createContext(); undefined when Google isn't connected. */
export async function createGoogleModule(store: CredentialRepository): Promise<ProviderModule | undefined> {
  const credentials = await resolveGoogleCredentials(store);
  if (!credentials) return undefined;
  const provider = new GoogleAdsProvider(new GoogleAdsRestClient(credentials));
  return { provider, tools: googleTools(provider) };
}
