import 'server-only';
import { createContext, PolicyEngine, type AdportRuntime, type ProviderModule } from '@adport/core';
import { AppleAdsClient, AppleAdsProvider, appleTools } from '@adport/provider-apple';
import { GoogleAdsProvider, GoogleAdsRestClient, googleTools } from '@adport/provider-google';
import { MetaAdsProvider, MetaGraphClient, metaTools } from '@adport/provider-meta';
import { MicrosoftAdsClient, MicrosoftAdsProvider, microsoftTools } from '@adport/provider-microsoft';
import { RedditAdsClient, RedditAdsProvider, redditTools } from '@adport/provider-reddit';
import { TikTokAdsProvider, TikTokClient, tiktokTools } from '@adport/provider-tiktok';
import { SnapchatAdsClient, SnapchatAdsProvider, snapchatTools } from '@adport/provider-snapchat';
import { SpotifyAdsClient, SpotifyAdsProvider, spotifyTools } from '@adport/provider-spotify';
import { PinterestAdsClient, PinterestAdsProvider, pinterestTools } from '@adport/provider-pinterest';
import { LinkedInAdsClient, LinkedInAdsProvider, linkedinTools } from '@adport/provider-linkedin';
import { XAdsClient, XAdsProvider, xTools } from '@adport/provider-x';
import { env, googleEnv } from '@/lib/env';
import { cloudProviderApp } from './provider-oauth-extra';
import { rotateProviderTokens } from './credential-rotation';
import { providerAllowedForOrganization } from './provider-rollout';
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
  const persistTokens = (provider: keyof ProviderCredentialMap) => {
    let expected = credentials[provider]!;
    return async (tokens: Parameters<typeof rotateProviderTokens>[0]['tokens']) => {
      await rotateProviderTokens({ organizationId: principal.organizationId, provider, connectionId: expected.connectionId, expected, tokens });
      expected = { ...expected, ...tokens } as typeof expected;
    };
  };
  if (credentials.snapchat && providerAllowedForOrganization('snapchat', principal.organizationId)) {
    const persist = persistTokens('snapchat');
    const provider = new SnapchatAdsProvider(new SnapchatAdsClient({ ...cloudProviderApp('snapchat'), refreshToken: credentials.snapchat.refreshToken, onRefreshToken: refreshToken => persist({ refreshToken }) }));
    modules.push({ provider: scopeProvider(provider), tools: snapchatTools(provider) });
  }
  if (credentials.spotify && providerAllowedForOrganization('spotify', principal.organizationId)) {
    const persist = persistTokens('spotify');
    const provider = new SpotifyAdsProvider(new SpotifyAdsClient({ ...cloudProviderApp('spotify'), refreshToken: credentials.spotify.refreshToken, onRefreshToken: refreshToken => persist({ refreshToken }) }));
    modules.push({ provider: scopeProvider(provider), tools: spotifyTools(provider) });
  }
  if (credentials.pinterest && providerAllowedForOrganization('pinterest', principal.organizationId)) {
    const persist = persistTokens('pinterest');
    const provider = new PinterestAdsProvider(new PinterestAdsClient({ ...cloudProviderApp('pinterest'), refreshToken: credentials.pinterest.refreshToken, onRefreshToken: refreshToken => persist({ refreshToken }) }));
    modules.push({ provider: scopeProvider(provider), tools: pinterestTools(provider) });
  }
  if (credentials.linkedin && providerAllowedForOrganization('linkedin', principal.organizationId)) {
    const provider = new LinkedInAdsProvider(new LinkedInAdsClient({ ...cloudProviderApp('linkedin'), ...credentials.linkedin, onTokens: persistTokens('linkedin') }));
    modules.push({ provider: scopeProvider(provider), tools: linkedinTools(provider) });
  }
  if (credentials.x && providerAllowedForOrganization('x', principal.organizationId)) {
    const { X_CONSUMER_KEY: consumerKey, X_CONSUMER_SECRET: consumerSecret } = env();
    if (!consumerKey || !consumerSecret) throw new Error('X Ads application credentials are not configured.');
    const provider = new XAdsProvider(new XAdsClient({ consumerKey, consumerSecret, ...credentials.x }));
    modules.push({ provider: scopeProvider(provider), tools: xTools(provider) });
  }
  if (credentials.google) {
    const config = googleEnv();
    const client = new GoogleAdsRestClient({
      developerToken: config.GOOGLE_ADS_DEVELOPER_TOKEN,
      clientId: config.GOOGLE_ADS_CLIENT_ID,
      clientSecret: config.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: credentials.google.refreshToken,
      loginCustomerIds: credentials.google.loginCustomerIds,
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
