import 'server-only';
import { AdportError } from '@adport/core';
import { catalogGrant, catalogScope, creationScope, type TikTokCatalogAccessMode, type TikTokCatalogAccessStore, type TikTokCatalogGrant, type TikTokCatalogScope } from '@adport/provider-tiktok';
import { db } from '@/lib/db';
import type { TenantPrincipal } from './types';

type Stored = { accountId: string; businessId: string; resourceKind: 'catalog' | 'catalog_creation'; resourceId: string; accessMode: TikTokCatalogAccessMode; revision: string | number };
const grant = (row: Stored) => catalogGrant({ accountId: row.accountId, businessId: row.businessId, resourceId: row.resourceId, kind: row.resourceKind }, row.accessMode, Number(row.revision));

export class PostgresTikTokCatalogAccessStore implements TikTokCatalogAccessStore {
  readonly canManage: boolean;
  readonly canWrite: boolean;
  constructor(private readonly principal: TenantPrincipal, private readonly enabledAccounts: ReadonlySet<string>, dashboardSession = false) {
    this.canWrite = principal.scopes.includes('tools:write') && principal.role !== 'viewer';
    this.canManage = dashboardSession && !!principal.userId && !principal.clientId && !principal.apiKeyId && !principal.oauthTokenId && ['owner', 'admin'].includes(principal.role ?? '') && principal.scopes.includes('connections:manage');
  }
  private check(account: string, manage = false) {
    if (!this.enabledAccounts.has(account) || !this.principal.scopes.some(value => ['tools:read', 'tools:write'].includes(value))) throw new AdportError('POLICY_VIOLATION', 'The advertiser is not enabled in this project.');
    if (manage && !this.canManage) throw new AdportError('POLICY_VIOLATION', 'Catalog access can only be changed by a signed-in project owner or admin in Accounts.');
  }
  private async available(account: string, active = true) {
    this.check(account);
    const rows = await db()<Array<{ enabled: boolean; status: string; accountSelectionId: string | null }>>`select account.enabled, connection.status, connection.account_selection_id from public.organization_ad_accounts account
      join public.connections connection on connection.id = account.connection_id
      where account.organization_id = ${this.principal.organizationId} and account.provider = 'tiktok' and account.account_id = ${account}
        and (${!active} or (account.enabled = true and connection.status = 'connected' and connection.account_selection_id is null))`;
    if (!rows[0] || active && (rows[0].enabled !== true || rows[0].status !== 'connected' || rows[0].accountSelectionId !== null)) throw new AdportError('POLICY_VIOLATION', 'The advertiser connection is disabled, disconnected or awaiting account selection.');
  }
  async get(value: TikTokCatalogScope): Promise<TikTokCatalogGrant> {
    const scope = catalogScope.parse(value);await this.available(scope.accountId, !this.canManage);
    const rows = await db()<Stored[]>`select account_id, business_id, resource_kind, resource_id, access_mode, revision from private.tiktok_catalog_access
      where organization_id = ${this.principal.organizationId} and provider = 'tiktok' and account_id = ${scope.accountId}
        and business_id = ${scope.businessId} and resource_kind = ${scope.kind} and resource_id = ${scope.resourceId}`;
    return rows[0] ? grant(rows[0]) : catalogGrant(scope);
  }
  async authorize(scope: TikTokCatalogScope, write: boolean) {
    if (write && !this.canWrite) throw new AdportError('POLICY_VIOLATION', 'This connection cannot modify TikTok catalogs.');
    if (this.canManage) await this.available(scope.accountId, true);
    return this.get(scope);
  }
  async list(accountId: string) {
    await this.available(accountId, !this.canManage);
    const rows = await db()<Stored[]>`select account_id, business_id, resource_kind, resource_id, access_mode, revision from private.tiktok_catalog_access
      where organization_id = ${this.principal.organizationId} and provider = 'tiktok' and account_id = ${accountId} and access_mode <> 'none'
      order by business_id, resource_kind, resource_id limit 5001`;
    if (rows.length > 5000) throw new AdportError('POLICY_VIOLATION', 'Catalog access inventory exceeds its verification bound.');
    return rows.map(grant);
  }
  async adoptCreated(value: TikTokCatalogScope, expectedCreationHash: string) {
    const scope = catalogScope.parse(value);if (scope.kind !== 'catalog' || !this.canWrite) throw new AdportError('POLICY_VIOLATION', 'Only a writable connection can adopt a verified new catalog.');
    await this.available(scope.accountId, true);const parent = creationScope(scope.accountId, scope.businessId);
    // Same lock order as owner grant changes. Native creation and exact readback precede this receipt.
    return db().begin(async sql => {
      const project = await sql`select id from public.organizations where id = ${this.principal.organizationId} for key share`;
      const connections = await sql`select connection.id from public.connections connection
        join public.organization_ad_accounts account on account.connection_id = connection.id
        where account.organization_id = ${this.principal.organizationId} and account.provider = 'tiktok' and account.account_id = ${scope.accountId}
          and connection.status = 'connected' and connection.account_selection_id is null for update of connection`;
      const accounts = await sql`select account_id from public.organization_ad_accounts
        where organization_id = ${this.principal.organizationId} and provider = 'tiktok' and account_id = ${scope.accountId} and enabled = true for update`;
      if (project.length !== 1 || connections.length !== 1 || accounts.length !== 1) throw new AdportError('POLICY_VIOLATION', 'The project or advertiser is no longer enabled and connected.');
      const delegated = await sql<Stored[]>`select account_id, business_id, resource_kind, resource_id, access_mode, revision from private.tiktok_catalog_access
        where organization_id = ${this.principal.organizationId} and provider = 'tiktok' and account_id = ${parent.accountId}
          and business_id = ${parent.businessId} and resource_kind = 'catalog_creation' and resource_id = ${parent.resourceId} for update`;
      const current = delegated[0] ? grant(delegated[0]) : catalogGrant(parent);
      if (current.mode !== 'create' || current.hash !== expectedCreationHash) throw new AdportError('POLICY_VIOLATION', 'Creation delegation changed. The known catalog was not adopted.');
      const existing = await sql<Stored[]>`select account_id, business_id, resource_kind, resource_id, access_mode, revision from private.tiktok_catalog_access
        where organization_id = ${this.principal.organizationId} and provider = 'tiktok' and account_id = ${scope.accountId}
          and business_id = ${scope.businessId} and resource_kind = 'catalog' and resource_id = ${scope.resourceId} for update`;
      if (existing.length) throw new AdportError('POLICY_VIOLATION', 'Catalog access already has an owner decision or creation receipt. It was not overwritten.');
      const rows = await sql<Stored[]>`insert into private.tiktok_catalog_access
        (organization_id, provider, account_id, business_id, resource_kind, resource_id, access_mode, revision)
        values (${this.principal.organizationId}, 'tiktok', ${scope.accountId}, ${scope.businessId}, 'catalog', ${scope.resourceId}, 'write', 1)
        on conflict (organization_id, provider, account_id, business_id, resource_kind, resource_id) do nothing
        returning account_id, business_id, resource_kind, resource_id, access_mode, revision`;
      if (rows.length !== 1) throw new AdportError('POLICY_VIOLATION', 'New catalog adoption could not be confirmed. Inspect the known catalog before another create.');return grant(rows[0]!);
    });
  }
  async compareAndSet(value: TikTokCatalogScope, expectedHash: string, mode: TikTokCatalogAccessMode) {
    const scope = catalogScope.parse(value);catalogGrant(scope, mode);this.check(scope.accountId, true);await this.available(scope.accountId, mode !== 'none');
    return db().begin(async sql => {
      const project = await sql`select id from public.organizations where id = ${this.principal.organizationId} for key share`;
      if (project.length !== 1) throw new AdportError('POLICY_VIOLATION', 'The project is no longer available.');
      const connections = await sql`select connection.id from public.connections connection
        join public.organization_ad_accounts account on account.connection_id = connection.id
        where account.organization_id = ${this.principal.organizationId} and account.provider = 'tiktok' and account.account_id = ${scope.accountId}
          and (${mode === 'none'} or (connection.status = 'connected' and connection.account_selection_id is null)) for update of connection`;
      const accounts = await sql`select account_id from public.organization_ad_accounts
        where organization_id = ${this.principal.organizationId} and provider = 'tiktok' and account_id = ${scope.accountId} and (${mode === 'none'} or enabled = true) for update`;
      if (connections.length !== 1 || accounts.length !== 1) throw new AdportError('POLICY_VIOLATION', 'The advertiser is no longer enabled and connected.');
      const previous = await sql<Stored[]>`select account_id, business_id, resource_kind, resource_id, access_mode, revision from private.tiktok_catalog_access
        where organization_id = ${this.principal.organizationId} and provider = 'tiktok' and account_id = ${scope.accountId}
          and business_id = ${scope.businessId} and resource_kind = ${scope.kind} and resource_id = ${scope.resourceId} for update`;
      const current = previous[0] ? grant(previous[0]) : catalogGrant(scope);
      if (current.hash !== expectedHash) throw new AdportError('POLICY_VIOLATION', 'Catalog access changed. Read and review it again.');
      const next = catalogGrant(scope, mode, current.revision + 1);
      const rows = await sql<Stored[]>`insert into private.tiktok_catalog_access
        (organization_id, provider, account_id, business_id, resource_kind, resource_id, access_mode, revision)
        values (${this.principal.organizationId}, 'tiktok', ${scope.accountId}, ${scope.businessId}, ${scope.kind}, ${scope.resourceId}, ${mode}, ${next.revision})
        on conflict (organization_id, provider, account_id, business_id, resource_kind, resource_id)
        do update set access_mode = excluded.access_mode, revision = private.tiktok_catalog_access.revision + 1, updated_at = now()
          where private.tiktok_catalog_access.revision = ${current.revision}
        returning account_id, business_id, resource_kind, resource_id, access_mode, revision`;
      if (rows.length !== 1) throw new AdportError('POLICY_VIOLATION', 'Catalog access changed. Read and review it again.');
      return grant(rows[0]!);
    });
  }
}
