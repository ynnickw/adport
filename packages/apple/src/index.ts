import type { CredentialRepository, ProviderModule } from '@adport/core';
import { AppleAdsClient, type AppleCredentials } from './client.js';
import { AppleAdsProvider } from './provider.js';
import { appleTools } from './tools.js';

export { AppleAdsClient, APPLE_ADS_BASE, formatAppleError, type AppleCredentials, type AppleEnvelope } from './client.js';
export { createClientSecret, type ClientSecretInput } from './jwt.js';
export { AppleAdsProvider, UNITS_TO_MICROS } from './provider.js';
export { appleTools } from './tools.js';

export async function resolveAppleCredentials(store: CredentialRepository): Promise<AppleCredentials | undefined> {
  const record = await store.get('apple');
  if (record?.data.client_id && record.data.team_id && record.data.key_id && record.data.private_key) {
    return {
      clientId: record.data.client_id,
      teamId: record.data.team_id,
      keyId: record.data.key_id,
      privateKeyPem: record.data.private_key,
    };
  }
  const env = process.env;
  if (env.APPLE_ADS_CLIENT_ID && env.APPLE_ADS_TEAM_ID && env.APPLE_ADS_KEY_ID && env.APPLE_ADS_PRIVATE_KEY) {
    return {
      clientId: env.APPLE_ADS_CLIENT_ID,
      teamId: env.APPLE_ADS_TEAM_ID,
      keyId: env.APPLE_ADS_KEY_ID,
      privateKeyPem: env.APPLE_ADS_PRIVATE_KEY,
    };
  }
  return undefined;
}

export async function createAppleModule(store: CredentialRepository): Promise<ProviderModule | undefined> {
  const credentials = await resolveAppleCredentials(store);
  if (!credentials) return undefined;
  const provider = new AppleAdsProvider(new AppleAdsClient(credentials));
  return { provider, tools: appleTools(provider) };
}
