import 'server-only';
import { createContext, PolicyEngine, type AdportRuntime, type ProviderModule } from '@adport/core';
import { AppleAdsClient, AppleAdsProvider, appleTools } from '@adport/provider-apple';
import { GoogleAdsProvider, GoogleAdsRestClient, googleTools } from '@adport/provider-google';
import { MetaAdsProvider, MetaGraphClient, metaTools } from '@adport/provider-meta';
import { MicrosoftAdsClient, MicrosoftAdsProvider, microsoftTools } from '@adport/provider-microsoft';
import { RedditAdsClient, RedditAdsProvider, redditTools } from '@adport/provider-reddit';
import { TikTokAdsProvider, TikTokClient, tiktokTools } from '@adport/provider-tiktok';
import { googleEnv } from '@/lib/env';
import { AccountScopedProvider, createAccountScopeAuthorizer } from './account-scope';
import { hydrateApple, hydrateMeta, hydrateMicrosoft, hydrateReddit, hydrateTikTok } from './provider-oauth';
import {
  getOrganizationPolicy,
  loadEnabledAccountIds,
  loadProviderCredentials,
  PostgresAuditStore,
  PostgresFindingsStore,
  PostgresPendingStore,
  updateProviderCredential,
} from './repository';
import type { ProviderCredentialMap, TenantPrincipal } from './types';

export interface TenantRuntimeOptions {
  /** Used only immediately after OAuth exchange to discover provider accounts. */
  enforceAccountScope?: boolean;
}

/**
 * Build the tenant runtime. Tenant grants come from the encrypted vault; the
 * Adport-owned application identity for each OAuth provider is injected from
 * server secrets, so no tenant ever holds an application secret.
 */
export async function createTenantRuntime(principal: TenantPrincipal, options: TenantRuntimeOptions = {}): Promise<AdportRuntime> {
  const enforceAccountScope = options.enforceAccountScope ?? true;
  const [policy, credentials, enabledAccountIds] = await Promise.all([
    getOrganizationPolicy(principal.organizationId),
    loadProviderCredentials(principal.organizationId),
    enforceAccountScope ? loadEnabledAccountIds(principal.organizationId) : Promise.resolve({}),
  ]);
  const modules: ProviderModule[] = [];
  const scopeProvider = <T extends ProviderModule['provider']>(provider: T): ProviderModule['provider'] =>
    enforceAccountScope ? new AccountScopedProvider(provider, enabledAccountIds[provider.id as keyof typeof enabledAccountIds] ?? new Set()) : provider;
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
    modules.push({ provider: scopeProvider(provider), tools: googleTools(provider) });
  }
  if (credentials.meta) {
    const provider = new MetaAdsProvider(new MetaGraphClient(hydrateMeta(credentials.meta)));
    modules.push({ provider: scopeProvider(provider), tools: metaTools(provider) });
  }
  if (credentials.tiktok) {
    const resolved = hydrateTikTok(credentials.tiktok);
    const provider = new TikTokAdsProvider(new TikTokClient(resolved), { appId: resolved.appId, secret: resolved.secret });
    modules.push({ provider: scopeProvider(provider), tools: tiktokTools(provider) });
  }
  if (credentials.apple) {
    const provider = new AppleAdsProvider(new AppleAdsClient(hydrateApple(credentials.apple)));
    modules.push({ provider: scopeProvider(provider), tools: appleTools(provider) });
  }
  if (credentials.microsoft) {
    const stored = credentials.microsoft;
    const client = new MicrosoftAdsClient(hydrateMicrosoft(stored), async (refreshToken) => {
      const rotated: ProviderCredentialMap['microsoft'] = { ...stored, refreshToken };
      await updateProviderCredential(principal.organizationId, 'microsoft', rotated);
    });
    const provider = new MicrosoftAdsProvider(client);
    modules.push({ provider: scopeProvider(provider), tools: microsoftTools(provider) });
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
    modules.push({ provider: scopeProvider(provider), tools: redditTools(provider) });
  }
  const engine = new PolicyEngine(policy, new PostgresPendingStore(principal), new PostgresAuditStore(principal));
  return createContext({
    providerModules: modules,
    engine,
    authorizeToolCall: enforceAccountScope ? createAccountScopeAuthorizer(enabledAccountIds) : undefined,
    findings: new PostgresFindingsStore(principal.organizationId),
  });
}
