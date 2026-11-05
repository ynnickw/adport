import 'server-only';
import { AdportError, createContext, PolicyEngine, type AdProvider } from '@adport/core';
import { RedditCatalogService, RedditAdsClient, redditCatalogTools } from '@adport/provider-reddit';
import { PostgresRedditCatalogAccessStore } from './reddit-catalog-access';
import { createAccountScopeAuthorizer } from './account-scope';
import { hydrateReddit } from './provider-oauth';
import { getOrganizationPolicy, listOrganizationAdAccounts, loadEnabledAccountIds, loadProviderCredentials, updateProviderCredential, PostgresAuditStore, PostgresPendingStore } from './repository';
import type { TenantPrincipal } from './types';

export async function createRedditCatalogAccessRuntime(principal: TenantPrincipal, accountId: string) {
  if (!principal.userId || principal.clientId || principal.apiKeyId || principal.oauthTokenId || !['owner', 'admin'].includes(principal.role ?? '') || !principal.scopes.includes('connections:manage')) throw new AdportError('POLICY_VIOLATION', 'A signed-in project owner/admin is required.');
  const [policy, inventory] = await Promise.all([getOrganizationPolicy(principal.organizationId), listOrganizationAdAccounts(principal.organizationId)]), known = new Set(inventory.filter(row => row.provider === 'reddit').map(row => row.accountId)), store = new PostgresRedditCatalogAccessStore(principal, known, true);
  if (!store.canManage || !known.has(accountId)) throw new AdportError('POLICY_VIOLATION', 'An imported Reddit advertiser and signed-in owner/admin are required.');
  const denied = async (): Promise<never> => { throw new AdportError('POLICY_VIOLATION', 'Catalog access administration cannot mutate native Reddit resources or enumerate unrelated assets.'); };
  const catalogs = new RedditCatalogService({
    async get<T>(path: string, params?: Record<string, unknown>) {
      const enabled = await loadEnabledAccountIds(principal.organizationId);if (!enabled.reddit?.has(accountId)) throw new AdportError('POLICY_VIOLATION', 'Enable the advertiser and finish Reddit connection setup before granting catalog access.');
      const credentials = await loadProviderCredentials(principal.organizationId), stored = credentials.reddit;if (!stored) throw new AdportError('NOT_CONNECTED', 'Reconnect Reddit before granting access. Revocation remains available.');
      return new RedditAdsClient({ ...hydrateReddit(stored), onRefreshToken: async refreshToken => { await updateProviderCredential(principal.organizationId, 'reddit', { ...stored, refreshToken }); } }).get<T>(path, params);
    }, post: denied, patch: denied, delete: denied, getPaged: denied,
  }, store);
  const provider: AdProvider = { id: 'reddit', capabilities: () => ({ serverDryRun: false }), listAccounts: async () => [], report: denied,
    async previewWrite(op) { if (op.tool !== 'reddit_set_catalog_access' || op.accountId !== accountId) throw new AdportError('POLICY_VIOLATION', 'Only this advertiser’s catalog access can change.');const { execute: _execute, ...preview } = await catalogs.plan(op);return { ...preview, serverValidated: false }; },
    async applyWrite(op) { if (op.tool !== 'reddit_set_catalog_access' || op.accountId !== accountId) throw new AdportError('POLICY_VIOLATION', 'Only this advertiser’s catalog access can change.');return { applied: true, resourceIds: await (await catalogs.plan(op)).execute() }; },
  };
  const names = new Set(['reddit_catalog_access', 'reddit_catalog_access_snapshot', 'reddit_set_catalog_access']);return createContext({ providerModules: [{ provider, tools: redditCatalogTools({ catalogs }, true).filter(t => names.has(t.name)) }], engine: new PolicyEngine(policy, new PostgresPendingStore(principal), new PostgresAuditStore(principal)), authorizeToolCall: createAccountScopeAuthorizer({ reddit: known }) });
}
