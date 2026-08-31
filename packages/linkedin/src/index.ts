import { AdportError, type CredentialStore, type ProviderModule } from '@adport/core';
import { LinkedInAdsClient, type LinkedInCredentials, type LinkedInTokens } from './client.js';
import { LinkedInAdsProvider } from './provider.js';
import { linkedinTools } from './tools.js';
export { LinkedInAdsClient, LINKEDIN_API_BASE, LINKEDIN_API_VERSION, LINKEDIN_TOKEN_URL, buildLinkedInAuthUrl, exchangeLinkedInCode, restli, type LinkedInCredentials, type LinkedInTokens } from './client.js';
export { LinkedInAdsProvider } from './provider.js';
export { linkedinTools } from './tools.js';

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AdportError('INVALID_INPUT', 'linkedin: token expiration must be Unix milliseconds');
  return parsed;
}
export function linkedInTokensData(tokens: LinkedInTokens): Record<string, string> {
  return { access_token: tokens.accessToken, ...(tokens.expiresAt !== undefined ? { expires_at: String(tokens.expiresAt) } : {}), ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}), ...(tokens.refreshExpiresAt !== undefined ? { refresh_expires_at: String(tokens.refreshExpiresAt) } : {}) };
}
export async function resolveLinkedInCredentials(store: CredentialStore): Promise<LinkedInCredentials | undefined> {
  const saved = await store.get('linkedin'), data = saved?.data;
  const complete = (d: Record<string, string> | undefined) => Boolean(d?.access_token || (d?.refresh_token && d.client_id && d.client_secret));
  const source = complete(data) ? data : { access_token: process.env.LINKEDIN_ACCESS_TOKEN ?? '', refresh_token: process.env.LINKEDIN_REFRESH_TOKEN ?? '', client_id: process.env.LINKEDIN_CLIENT_ID ?? '', client_secret: process.env.LINKEDIN_CLIENT_SECRET ?? '', ...(process.env.LINKEDIN_EXPIRES_AT ? { expires_at: process.env.LINKEDIN_EXPIRES_AT } : {}), ...(process.env.LINKEDIN_REFRESH_EXPIRES_AT ? { refresh_expires_at: process.env.LINKEDIN_REFRESH_EXPIRES_AT } : {}) };
  if (!complete(source)) return undefined;
  const credentials: LinkedInCredentials = { accessToken: source?.access_token || undefined, expiresAt: timestamp(source?.expires_at), refreshToken: source?.refresh_token || undefined, refreshExpiresAt: timestamp(source?.refresh_expires_at), clientId: source?.client_id || undefined, clientSecret: source?.client_secret || undefined };
  if (source === data) credentials.onTokens = async tokens => { const latest = await store.get('linkedin'); if (latest) await store.set({ provider: 'linkedin', source: latest.source, data: { ...latest.data, ...linkedInTokensData(tokens) } }); };
  return credentials;
}
export async function createLinkedInModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveLinkedInCredentials(store);
  if (!credentials) return undefined;
  const provider = new LinkedInAdsProvider(new LinkedInAdsClient(credentials));
  return { provider, tools: linkedinTools(provider) };
}
