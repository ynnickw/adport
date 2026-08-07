import type { CredentialStore, ProviderModule } from '@adport/core';
import { MicrosoftAdsClient, type MicrosoftCredentials } from './client.js';
import { MicrosoftAdsProvider } from './provider.js';
import { microsoftTools } from './tools.js';

export {
  MicrosoftAdsClient,
  MSADS_SCOPE,
  SANDBOX_DEVELOPER_TOKEN,
  formatMicrosoftError,
  formatPartialErrors,
  type MicrosoftCredentials,
} from './client.js';
export { MicrosoftAdsProvider, UNITS_TO_MICROS } from './provider.js';
export { microsoftTools } from './tools.js';
export { parseCsv } from './csv.js';

export async function resolveMicrosoftCredentials(store: CredentialStore): Promise<MicrosoftCredentials | undefined> {
  const record = await store.get('microsoft');
  if (record?.data.developer_token && record.data.client_id && record.data.refresh_token) {
    return {
      developerToken: record.data.developer_token,
      clientId: record.data.client_id,
      refreshToken: record.data.refresh_token,
      clientSecret: record.data.client_secret || undefined,
      sandbox: record.data.sandbox === 'true',
    };
  }
  const env = process.env;
  if (env.MICROSOFT_ADS_DEVELOPER_TOKEN && env.MICROSOFT_ADS_CLIENT_ID && env.MICROSOFT_ADS_REFRESH_TOKEN) {
    return {
      developerToken: env.MICROSOFT_ADS_DEVELOPER_TOKEN,
      clientId: env.MICROSOFT_ADS_CLIENT_ID,
      refreshToken: env.MICROSOFT_ADS_REFRESH_TOKEN,
      clientSecret: env.MICROSOFT_ADS_CLIENT_SECRET || undefined,
      sandbox: env.MICROSOFT_ADS_SANDBOX === 'true',
    };
  }
  return undefined;
}

export async function createMicrosoftModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveMicrosoftCredentials(store);
  if (!credentials) return undefined;
  const client = new MicrosoftAdsClient(credentials, async (rotated) => {
    // Public-client refresh tokens rotate; persist the replacement immediately.
    const record = await store.get('microsoft');
    if (record) {
      await store.set({ ...record, data: { ...record.data, refresh_token: rotated } });
    }
  });
  const provider = new MicrosoftAdsProvider(client);
  return { provider, tools: microsoftTools(provider) };
}
