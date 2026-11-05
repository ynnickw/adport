import 'server-only';
import { AdportError, createContext, PolicyEngine, type AdProvider } from '@adport/core';
import { TikTokCatalogService, TikTokClient, tiktokCatalogTools } from '@adport/provider-tiktok';
import { PostgresTikTokCatalogAccessStore } from './tiktok-catalog-access';
import { createAccountScopeAuthorizer } from './account-scope';
import { hydrateTikTok } from './provider-oauth';
import { getOrganizationPolicy, listOrganizationAdAccounts, loadEnabledAccountIds, loadProviderCredentials, PostgresAuditStore, PostgresPendingStore } from './repository';
import type { TenantPrincipal } from './types';

/** Permission administration stays available for revocation without native credentials. */
export async function createCatalogAccessRuntime(principal: TenantPrincipal, accountId: string) {
  if (!principal.userId || principal.clientId || principal.apiKeyId || principal.oauthTokenId || !['owner', 'admin'].includes(principal.role ?? '') || !principal.scopes.includes('connections:manage')) throw new AdportError('POLICY_VIOLATION', 'A signed-in project owner or admin is required to manage catalog access.');
  const [policy, inventory] = await Promise.all([getOrganizationPolicy(principal.organizationId), listOrganizationAdAccounts(principal.organizationId)]);
  const known = new Set(inventory.filter(value => value.provider === 'tiktok').map(value => value.accountId));
  const store = new PostgresTikTokCatalogAccessStore(principal, known, true);
  if (!store.canManage || !known.has(accountId)) throw new AdportError('POLICY_VIOLATION', 'A signed-in project owner/admin and an imported TikTok advertiser are required.');
  const catalogs = new TikTokCatalogService({
    async get<T>(path: string, params?: Record<string, unknown>) {
      const enabled = await loadEnabledAccountIds(principal.organizationId);
      if (!enabled.tiktok?.has(accountId)) throw new AdportError('POLICY_VIOLATION', 'Enable the advertiser and finish TikTok connection setup before granting catalog access.');
      const credentials = await loadProviderCredentials(principal.organizationId);
      if (!credentials.tiktok) throw new AdportError('NOT_CONNECTED', 'Reconnect TikTok before granting catalog access. Revocation remains available.');
      return new TikTokClient(hydrateTikTok(credentials.tiktok)).get<T>(path, params);
    },
    async post() { throw new AdportError('POLICY_VIOLATION', 'Catalog access administration cannot mutate native TikTok resources.'); },
  }, store);
  const provider: AdProvider = {
    id: 'tiktok', capabilities: () => ({ serverDryRun: false }), listAccounts: async () => [],
    async report() { throw new AdportError('INVALID_INPUT', 'This runtime only manages catalog access.'); },
    async previewWrite(operation) {
      if (operation.tool !== 'tiktok_set_catalog_access' || operation.accountId !== accountId) throw new AdportError('POLICY_VIOLATION', 'Only this advertiser’s catalog access can be changed.');
      const { execute: _execute, ...preview } = await catalogs.plan(operation);return { ...preview, serverValidated: false };
    },
    async applyWrite(operation) {
      if (operation.tool !== 'tiktok_set_catalog_access' || operation.accountId !== accountId) throw new AdportError('POLICY_VIOLATION', 'Only this advertiser’s catalog access can be changed.');
      return { applied: true, resourceIds: await (await catalogs.plan(operation)).execute() };
    },
  };
  const names = new Set(['tiktok_catalog_access', 'tiktok_catalog_access_snapshot', 'tiktok_set_catalog_access']);
  return createContext({ providerModules: [{ provider, tools: tiktokCatalogTools({ catalogs }, true).filter(value => names.has(value.name)) }],
    engine: new PolicyEngine(policy, new PostgresPendingStore(principal), new PostgresAuditStore(principal)),
    authorizeToolCall: createAccountScopeAuthorizer({ tiktok: known }) });
}
