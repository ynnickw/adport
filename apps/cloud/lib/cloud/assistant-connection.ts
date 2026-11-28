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
  existingConnection?: { clientName: string; coversProject: boolean };
}

/** A successful hosted read, never an OAuth login, initialize, or tools/list. */
export async function recordAssistantRead(principal: TenantPrincipal): Promise<void> {
  if (principal.oauthTokenId && principal.userId) {
    await db()`
      update private.mcp_oauth_refresh_tokens refresh set verified_at = now()
      from private.mcp_oauth_access_tokens access
      where access.token_id = ${principal.oauthTokenId}
        and (access.organization_id = ${principal.organizationId}
          or access.organization_group_id = (select organization_group_id from public.organizations where id = ${principal.organizationId})
          or exists (select 1 from private.mcp_oauth_organization_grants grant_row
            join public.organizations project on project.id = ${principal.organizationId}
            where grant_row.id = access.organization_grant_id and project.organization_group_id = any(grant_row.organization_group_ids)))
        and access.user_id = ${principal.userId} and access.revoked_at is null and access.expires_at > now()
        and refresh.organization_id is not distinct from access.organization_id and refresh.user_id = access.user_id
        and refresh.client_id = access.client_id and refresh.resource = access.resource
        and refresh.organization_group_id is not distinct from access.organization_group_id
        and refresh.organization_grant_id is not distinct from access.organization_grant_id
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
    db()<Array<{ clientName: string; clientUri: string | null; kind: string; verifiedAt: Date | null; coversProject: boolean }>>`
      with reachable_projects as (
        select project.id, project.organization_group_id from private.project_memberships access
        join public.organizations project on project.id = access.organization_id where access.user_id = ${principal.userId}
      )
      select client.client_name, client.client_uri, 'oauth' as kind, refresh.verified_at, workspace.covers_project
      from private.mcp_oauth_refresh_tokens refresh
      join private.mcp_oauth_clients client on client.client_id = refresh.client_id
      left join private.mcp_oauth_organization_grants grant_row on grant_row.id = refresh.organization_grant_id
        and grant_row.user_id = refresh.user_id and grant_row.client_id = refresh.client_id and grant_row.resource = refresh.resource
      join lateral (
        select bool_or(project.id = ${principal.organizationId}) as covers_project from reachable_projects project
        where (refresh.organization_group_id is null and refresh.organization_id = project.id)
          or refresh.organization_group_id = project.organization_group_id
          or project.organization_group_id = any(grant_row.organization_group_ids)
      ) workspace on workspace.covers_project is not null
      where refresh.user_id = ${principal.userId}
        and refresh.resource = ${mcpResourceUrl()}
        and refresh.revoked_at is null and refresh.consumed_at is null and refresh.expires_at > now()
        and 'tools:read' = any(refresh.scopes)
      union all
      select 'Custom assistant' as client_name, null as client_uri, 'key' as kind, key.verified_at, project.id = ${principal.organizationId}
      from public.api_keys key join reachable_projects project on project.id = key.organization_id
      where key.created_by = ${principal.userId}
        and key.revoked_at is null and (key.expires_at is null or key.expires_at > now())
        and 'tools:read' = any(key.scopes)
      order by covers_project desc, verified_at desc nulls last, client_name
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
  const connection = connections.find(client => client.coversProject && matchesAssistant(agent, client));
  const connected = connections.filter(client => client.kind === 'oauth' || client.verifiedAt);
  const existing = connection ? undefined : connected.find(client => client.coversProject)
    ?? connected.find(client => matchesAssistant(agent, client)) ?? connected[0];
  return { authorized: Boolean(connection), verified: Boolean(connection?.verifiedAt), hasAccounts: accounts[0]?.available ?? false, clientName: connection?.clientName ?? null,
    ...(existing ? { existingConnection: { clientName: existing.clientName, coversProject: existing.coversProject } } : {}) };
}
