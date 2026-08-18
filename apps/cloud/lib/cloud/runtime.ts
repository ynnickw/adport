import 'server-only';
import { createContext, PolicyEngine, type AdportRuntime, type ProviderModule } from '@adport/core';
import { AppleAdsClient, AppleAdsProvider, appleTools } from '@adport/provider-apple';
import { GoogleAdsProvider, GoogleAdsRestClient, googleTools } from '@adport/provider-google';
import { MetaAdsProvider, MetaGraphClient, metaTools } from '@adport/provider-meta';
import { MicrosoftAdsClient, MicrosoftAdsProvider, microsoftTools } from '@adport/provider-microsoft';
import { RedditAdsClient, RedditAdsProvider, redditTools } from '@adport/provider-reddit';
import { TikTokAdsProvider, TikTokClient, tiktokTools } from '@adport/provider-tiktok';
import { googleEnv } from '@/lib/env';
import { hydrateMeta, hydrateMicrosoft, hydrateReddit, hydrateTikTok } from './provider-oauth';
import {
  getOrganizationPolicy,
  loadProviderCredentials,
  PostgresAuditStore,
  PostgresPendingStore,
  updateProviderCredential,
} from './repository';
import type { ProviderCredentialMap, TenantPrincipal } from './types';

/**
 * Build the tenant runtime. Tenant grants come from the encrypted vault; the
 * Adport-owned application identity for each OAuth provider is injected from
 * server secrets, so no tenant ever holds an application secret.
 */
export async function createTenantRuntime(principal: TenantPrincipal): Promise<AdportRuntime> {
  const [policy, credentials] = await Promise.all([
    getOrganizationPolicy(principal.organizationId),
    loadProviderCredentials(principal.organizationId),
  ]);
  const modules: ProviderModule[] = [];
  if (credentials.google) {
    const config = googleEnv();
    const client = new GoogleAdsRestClient({
      developerToken: config.GOOGLE_ADS_DEVELOPER_TOKEN,
      clientId: config.GOOGLE_ADS_CLIENT_ID,
      clientSecret: config.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: credentials.google.refreshToken,
      loginCustomerId: credentials.google.loginCustomerId ?? config.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    });
    const provider = new GoogleAdsProvider(client);
    modules.push({ provider, tools: googleTools(provider) });
  }
  if (credentials.meta) {
    const provider = new MetaAdsProvider(new MetaGraphClient(hydrateMeta(credentials.meta)));
    modules.push({ provider, tools: metaTools(provider) });
  }
  if (credentials.tiktok) {
    const resolved = hydrateTikTok(credentials.tiktok);
    const provider = new TikTokAdsProvider(new TikTokClient(resolved), { appId: resolved.appId, secret: resolved.secret });
    modules.push({ provider, tools: tiktokTools(provider) });
  }
  if (credentials.apple) {
    const provider = new AppleAdsProvider(new AppleAdsClient(credentials.apple));
    modules.push({ provider, tools: appleTools(provider) });
  }
  if (credentials.microsoft) {
    const stored = credentials.microsoft;
    const client = new MicrosoftAdsClient(hydrateMicrosoft(stored), async (refreshToken) => {
      const rotated: ProviderCredentialMap['microsoft'] = { ...stored, refreshToken };
      await updateProviderCredential(principal.organizationId, 'microsoft', rotated);
    });
    const provider = new MicrosoftAdsProvider(client);
    modules.push({ provider, tools: microsoftTools(provider) });
  }
  if (credentials.reddit) {
    const stored = credentials.reddit;
    const client = new RedditAdsClient({
      ...hydrateReddit(stored),
      onRefreshToken: async (refreshToken) => {
        const rotated: ProviderCredentialMap['reddit'] = { ...stored, refreshToken };
        await updateProviderCredential(principal.organizationId, 'reddit', rotated);
      },
    });
    const provider = new RedditAdsProvider(client);
    modules.push({ provider, tools: redditTools(provider) });
  }
  const engine = new PolicyEngine(policy, new PostgresPendingStore(principal), new PostgresAuditStore(principal));
  return createContext({ providerModules: modules, engine });
}
