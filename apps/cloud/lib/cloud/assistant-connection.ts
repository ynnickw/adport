import 'server-only';
import { db } from '@/lib/db';
import type { TenantPrincipal } from './types';
import { matchesAssistant } from '@/lib/assistant-client';
import { mcpResourceUrl } from '@/lib/mcp-oauth';

export interface AssistantConnectionStatus {
  authorized: boolean;
  verified: boolean;
  hasAccounts: boolean;
  clientName: string | null;
}

/** A successful hosted read, never an OAuth login, initialize, or tools/list. */
export async function recordAssistantRead(principal: TenantPrincipal): Promise<void> {
  if (principal.oauthTokenId && principal.userId) {
    await db()`
      update private.mcp_oauth_refresh_tokens refresh set verified_at = now()
      from private.mcp_oauth_access_tokens access
      where access.token_id = ${principal.oauthTokenId}
        and (access.organization_id = ${principal.organizationId}
          or access.organization_group_id = (select organization_group_id from public.organizations where id = ${principal.organizationId}))
        and access.user_id = ${principal.userId} and access.revoked_at is null and access.expires_at > now()
        and refresh.organization_id = access.organization_id and refresh.user_id = access.user_id
        and refresh.client_id = access.client_id and refresh.resource = access.resource
        and refresh.organization_group_id is not distinct from access.organization_group_id
        and refresh.revoked_at is null and refresh.expires_at > now() and refresh.verified_at is null
    `;
  } else if (principal.apiKeyId) {
    await db()`update public.api_keys set verified_at = now()
      where id = ${principal.apiKeyId} and organization_id = ${principal.organizationId}
        and revoked_at is null and (expires_at is null or expires_at > now()) and verified_at is null`;
  }
}

/** Scope the check to this signed-in user and project, including credential revocation. */
export async function getAssistantConnectionStatus(principal: TenantPrincipal, agent?: string): Promise<AssistantConnectionStatus> {
  if (!principal.userId) throw new Error('A user session is required.');
  const [connections, accounts] = await Promise.all([
    db()<Array<{ clientName: string; clientUri: string | null; kind: string; verifiedAt: Date | null }>>`
      select client.client_name, client.client_uri, 'oauth' as kind, refresh.verified_at
      from private.mcp_oauth_refresh_tokens refresh
      join private.mcp_oauth_clients client on client.client_id = refresh.client_id
      where (refresh.organization_id = ${principal.organizationId}
          or refresh.organization_group_id = (select organization_group_id from public.organizations where id = ${principal.organizationId}))
        and refresh.user_id = ${principal.userId}
        and refresh.resource = ${mcpResourceUrl()}
        and refresh.revoked_at is null and refresh.consumed_at is null and refresh.expires_at > now()
        and 'tools:read' = any(refresh.scopes)
      union all
      select 'Custom assistant' as client_name, null as client_uri, 'key' as kind, key.verified_at from public.api_keys key
      where key.organization_id = ${principal.organizationId} and key.created_by = ${principal.userId}
        and key.revoked_at is null and (key.expires_at is null or key.expires_at > now())
        and 'tools:read' = any(key.scopes)
      order by verified_at desc nulls last
    `,
    db()<Array<{ available: boolean }>>`
      select exists (
        select 1 from public.organization_ad_accounts account
        join public.connections connection on connection.id = account.connection_id
          and connection.organization_id = account.organization_id and connection.provider = account.provider
        where account.organization_id = ${principal.organizationId} and account.enabled
          and connection.status = 'connected' and connection.account_selection_id is null
      ) as available
    `,
  ]);
  const connection = connections.find(client => matchesAssistant(agent, client));
  return { authorized: Boolean(connection), verified: Boolean(connection?.verifiedAt), hasAccounts: accounts[0]?.available ?? false, clientName: connection?.clientName ?? null };
}
