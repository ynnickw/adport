import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { listMcpOAuthGrants } from '@/lib/cloud/mcp-oauth-repository';
import { saveToolSelection } from '@/lib/cloud/tool-catalog';
import { toolSelectionSchema } from '@/lib/mcp-tool-selection';
import { apiError, HttpError, noStoreJson } from '@/lib/http';
import { db } from '@/lib/db';

const inputSchema = z.object({
  organization_id: z.string().uuid(), selection: toolSelectionSchema,
  connection: z.discriminatedUnion('type', [
    z.object({ type: z.literal('oauth'), client_id: z.string().min(1), user_id: z.string().uuid(), resource: z.string().url(), organization_group_id: z.string().uuid().nullable() }),
    z.object({ type: z.literal('key'), id: z.string().uuid() }),
  ]),
});

export async function PATCH(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    const principal = await sessionPrincipal(input.organization_id);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new HttpError('Owner or admin access is required.', 403);
    if (input.connection.type === 'key') {
      const keys = await db()`select id from public.api_keys where id = ${input.connection.id}
        and organization_id = ${principal.organizationId} and revoked_at is null`;
      if (!keys.length) throw new HttpError('This API key is not available in this project.', 404);
      await saveToolSelection({ organizationId: principal.organizationId, apiKeyId: input.connection.id, userId: principal.userId }, input.selection);
    } else {
      const connection = input.connection;
      if (connection.user_id !== principal.userId) throw new HttpError('Only the person who authorized this assistant can change its tool access.', 403);
      const grant = (await listMcpOAuthGrants(principal.organizationId)).find(grant => grant.status === 'active'
        && grant.clientId === connection.client_id && grant.userId === connection.user_id && grant.resource === connection.resource
        && (grant.organizationGroupId ?? null) === connection.organization_group_id);
      if (!grant) throw new HttpError('This assistant connection is no longer active.', 404);
      await saveToolSelection({ ...principal, clientId: grant.clientId, resource: grant.resource,
        oauthOrganizationGroupId: grant.organizationGroupId ?? undefined }, input.selection);
    }
    return noStoreJson({ selection: input.selection });
  } catch (error) { return apiError(error, error instanceof z.ZodError ? 400 : undefined); }
}
