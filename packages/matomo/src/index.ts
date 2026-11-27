import { matomoTools, normalizeMatomoUrl, type CredentialStore, type ProviderModule } from '@adport/core';
import { MatomoClient, type MatomoCredentials } from './client.js';
import { MatomoProvider } from './provider.js';
export { MatomoClient, MATOMO_READ_METHODS, type MatomoCredentials } from './client.js';
export { MatomoProvider, matomoSiteId, matomoPeriodStarts, type MatomoSite } from './provider.js';
export { matomoTools, matomoReportSchema, matomoReportMetadataSchema, matomoBaseUrl, normalizeMatomoUrl } from '@adport/core';

/** Stored data uses { url, token_auth }; both values are required. */
export function matomoCredentialsFromData(data: Record<string, string> | undefined): MatomoCredentials | undefined {
  const url = data?.url?.trim(), tokenAuth = data?.token_auth?.trim();
  return url && tokenAuth ? { url: normalizeMatomoUrl(url), tokenAuth } : undefined;
}
export function matomoEnvironmentData(): Record<string, string> {
  return { url: process.env.MATOMO_URL ?? '', token_auth: process.env.MATOMO_TOKEN_AUTH ?? '' };
}
/** Unusable values (e.g. a non-https URL) count as absent so one bad pair never stops other providers from loading. */
function usableCredentials(data: Record<string, string> | undefined): MatomoCredentials | undefined {
  try { return matomoCredentialsFromData(data); } catch { return undefined; }
}
export async function resolveMatomoCredentials(store: CredentialStore): Promise<MatomoCredentials | undefined> {
  return usableCredentials((await store.get('matomo'))?.data) ?? usableCredentials(matomoEnvironmentData());
}
export async function createMatomoModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveMatomoCredentials(store);
  if (!credentials) return undefined;
  let client: MatomoClient;
  try { client = new MatomoClient(credentials); } catch { return undefined; }
  const provider = new MatomoProvider(client);
  return { provider, tools: matomoTools(provider) };
}
