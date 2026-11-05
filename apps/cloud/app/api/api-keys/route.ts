import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { createApiKey, revokeApiKey } from '@/lib/cloud/repository';
import { listMcpOAuthGrants } from '@/lib/cloud/mcp-oauth-repository';
import { db } from '@/lib/db';
import { apiError, noStoreJson } from '@/lib/http';
import { loadToolSelection, saveToolSelection } from '@/lib/cloud/tool-catalog';
import { toolSelectionSchema } from '@/lib/mcp-tool-selection';

const inputSchema = z.object({
  organization_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(['tools:read', 'tools:write'])).min(1),
  selection: toolSelectionSchema.default({ profile: 'standard', providers: null }),
});

export async function GET(request: Request) {
  try {
    const organizationId = new URL(request.url).searchParams.get('organization_id') ?? undefined;
    const principal = await sessionPrincipal(organizationId);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const [keys, oauthGrants] = await Promise.all([
      db()<Array<{ id: string; name: string; keyPrefix: string; createdAt: Date; lastUsedAt: Date | null }>>`
        select id, name, key_prefix, created_at, last_used_at
        from public.api_keys
        where organization_id = ${principal.organizationId} and revoked_at is null
        order by created_at desc
      `,
      listMcpOAuthGrants(principal.organizationId),
    ]);
    const selectedKeys = await Promise.all(keys.map(async key => ({ ...key,
      toolSelection: await loadToolSelection({ organizationId: principal.organizationId, apiKeyId: key.id }),
    })));
    return noStoreJson({ keys: selectedKeys, oauthGrants });
  } catch (error) {
    return apiError(error, 403);
  }
}

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    const principal = await sessionPrincipal(input.organization_id);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const scopes = input.scopes.filter((scope) => principal.scopes.includes(scope));
    if (!scopes.length) throw new Error('Your current plan does not grant any of the requested API-key scopes.');
    const created = await createApiKey({
      organizationId: principal.organizationId,
      userId: principal.userId!,
      name: input.name,
      scopes,
    });
    try {
      await saveToolSelection({ ...principal, apiKeyId: created.id }, input.selection);
    } catch (error) {
      await revokeApiKey(principal, created.id);
      throw error;
    }
    return noStoreJson(created, 201);
  } catch (error) {
    return apiError(error, 403);
  }
}
