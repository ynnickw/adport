import 'server-only';
import { createHash } from 'node:crypto';
import type { ToolSelection, ToolProvider } from '@adport/core';
import { db } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { mcpResourceUrl } from '@/lib/mcp-oauth';
import { LEGACY_TOOL_SELECTION, toolSelectionSchema } from '@/lib/mcp-tool-selection';
import type { TenantPrincipal } from './types';

export interface CatalogConnection {
  organizationId: string;
  userId?: string;
  clientId?: string;
  oauthOrganizationGroupId?: string;
  oauthOrganizationGrantId?: string;
  resource?: string;
  apiKeyId?: string;
}

export function catalogConnectionKey(connection: CatalogConnection): string {
  if (connection.apiKeyId) return `key:${connection.apiKeyId}`;
  if (!connection.userId || !connection.clientId) throw new Error('An assistant connection is required.');
  return createHash('sha256').update(JSON.stringify([
    connection.oauthOrganizationGroupId ? 'organization' : 'project',
    connection.oauthOrganizationGroupId ?? connection.organizationId,
    connection.userId, connection.clientId, connection.resource ?? mcpResourceUrl(),
  ])).digest('hex');
}

export async function loadToolSelection(connection: CatalogConnection): Promise<ToolSelection> {
  if (connection.oauthOrganizationGrantId) {
    const [selection] = await db()<Array<{ profile: string; providers: ToolProvider[] | null }>>`
      select profile, providers from private.mcp_oauth_organization_grants where id = ${connection.oauthOrganizationGrantId}
        and user_id = ${connection.userId ?? null} and client_id = ${connection.clientId ?? null}
        and resource = ${connection.resource ?? mcpResourceUrl()}`;
    if (!selection) throw new HttpError('This assistant connection is no longer available.', 403);
    return toolSelectionSchema.parse(selection);
  }
  const rows = await db()<Array<{ profile: string; providers: ToolProvider[] | null }>>`
    select profile, providers from private.mcp_tool_catalog_settings
    where connection_key = ${catalogConnectionKey(connection)}
  `;
  return rows[0] ? toolSelectionSchema.parse(rows[0]) : LEGACY_TOOL_SELECTION;
}

export async function saveToolSelection(connection: CatalogConnection, selection: ToolSelection): Promise<void> {
  const parsed = toolSelectionSchema.parse(selection);
  if (connection.oauthOrganizationGrantId) {
    const updated = await db()`update private.mcp_oauth_organization_grants set profile = ${parsed.profile}, providers = ${parsed.providers}
      where id = ${connection.oauthOrganizationGrantId} and user_id = ${connection.userId ?? null}
        and client_id = ${connection.clientId ?? null} and resource = ${connection.resource ?? mcpResourceUrl()}`;
    if (!updated.count) throw new HttpError('This assistant connection is no longer available.', 403);
    return;
  }
  await db()`
    insert into private.mcp_tool_catalog_settings
      (connection_key, organization_id, organization_group_id, user_id, client_id, api_key_id, profile, providers)
    values (${catalogConnectionKey(connection)}, ${connection.oauthOrganizationGroupId ? null : connection.organizationId}, ${connection.oauthOrganizationGroupId ?? null},
      ${connection.userId ?? null}, ${connection.clientId ?? null}, ${connection.apiKeyId ?? null}, ${parsed.profile}, ${parsed.providers})
    on conflict (connection_key) do update set profile = excluded.profile, providers = excluded.providers, updated_at = now()
  `;
}

export async function connectedCatalogProviders(projectIds: readonly string[]): Promise<Record<string, ToolProvider[]>> {
  if (!projectIds.length) return {};
  const rows = await db()<Array<{ organizationId: string; provider: ToolProvider }>>`
    select organization_id, provider from public.connections
    where organization_id in ${db()(Array.from(projectIds))} and status = 'connected'
  `;
  const result: Record<string, ToolProvider[]> = {};
  for (const row of rows) (result[row.organizationId] ??= []).push(row.provider);
  return result;
}

export async function principalToolSelection(principal: TenantPrincipal): Promise<ToolSelection> {
  return loadToolSelection(principal);
}
