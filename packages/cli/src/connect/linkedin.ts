import { AdportError, CredentialStore } from '@adport/core';
import { LinkedInAdsClient, LinkedInAdsProvider, linkedInTokensData, type LinkedInCredentials, type LinkedInTokens } from '@adport/provider-linkedin';
import type { ProgramIO } from '../program.js';
import { printLocalConnectionIntro, printLocalConnectionSaved } from './local.js';

export async function connectLinkedIn(input: { openBrowser: boolean; io: ProgramIO }): Promise<void> {
  printLocalConnectionIntro(input.io, 'LinkedIn Ads');
  input.io.out('Use your own approved Advertising API app at https://www.linkedin.com/developers/apps. Obtain an authorized token with rw_ads and r_ads_reporting through its token generator or your own HTTPS OAuth callback.');
  input.io.out('This command imports the token from your environment; it does not open a shared Cloud OAuth flow or request secrets through echoed prompts.');
  const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
  const refreshToken = process.env.LINKEDIN_REFRESH_TOKEN;
  const clientId = process.env.LINKEDIN_CLIENT_ID, clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!accessToken && !(refreshToken && clientId && clientSecret)) throw new AdportError('INVALID_INPUT', 'Set LINKEDIN_ACCESS_TOKEN securely in your environment. Approved partners may instead provide LINKEDIN_REFRESH_TOKEN, LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET together.');
  if (refreshToken && (!clientId || !clientSecret)) throw new AdportError('INVALID_INPUT', 'LINKEDIN_REFRESH_TOKEN requires both LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET. Omit refresh credentials for access-token-only onboarding.');
  const expiry = (name: string) => {
    const raw = process.env[name];
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new AdportError('INVALID_INPUT', `${name} must contain an expiration timestamp in Unix milliseconds.`);
    return value;
  };
  let tokens: Partial<LinkedInTokens> = { accessToken, refreshToken, expiresAt: expiry('LINKEDIN_EXPIRES_AT'), refreshExpiresAt: expiry('LINKEDIN_REFRESH_EXPIRES_AT') };
  const credentials: LinkedInCredentials = { ...tokens, ...(refreshToken ? { clientId, clientSecret } : {}), onTokens: async updated => { tokens = updated; } };
  const accounts = await new LinkedInAdsProvider(new LinkedInAdsClient(credentials)).listAccounts();
  if (!tokens.accessToken) throw new AdportError('PROVIDER_ERROR', 'LinkedIn verification completed without a usable access token. Credentials were not replaced.');
  await new CredentialStore().set({ provider: 'linkedin', source: 'byo', data: { ...linkedInTokensData(tokens as LinkedInTokens), ...(refreshToken ? { client_id: clientId!, client_secret: clientSecret! } : {}) } });
  input.io.out(`Connected: ${accounts.length} accessible LinkedIn ad account(s).`);
  for (const account of accounts) input.io.out(`  ${account.id}  ${account.name}  ${account.currency ?? ''}`);
  if (!refreshToken) input.io.out('This access-token-only connection cannot refresh automatically. Reauthorize your own app and re-import when the token expires.');
  printLocalConnectionSaved(input.io);
}
