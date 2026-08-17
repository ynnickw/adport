import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { createApiKey } from '@/lib/cloud/repository';
import { db } from '@/lib/db';
import { apiError, noStoreJson } from '@/lib/http';

const inputSchema = z.object({
  organization_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(['tools:read', 'tools:write'])).min(1),
});

export async function GET(request: Request) {
  try {
    const organizationId = new URL(request.url).searchParams.get('organization_id') ?? undefined;
    const principal = await sessionPrincipal(organizationId);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const keys = await db()<Array<{ id: string; name: string; keyPrefix: string; createdAt: Date; lastUsedAt: Date | null }>>`
      select id, name, key_prefix, created_at, last_used_at
      from public.api_keys
      where organization_id = ${principal.organizationId} and revoked_at is null
      order by created_at desc
    `;
    return noStoreJson({ keys });
  } catch (error) {
    return apiError(error, 403);
  }
}

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    const principal = await sessionPrincipal(input.organization_id);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const created = await createApiKey({
      organizationId: principal.organizationId,
      userId: principal.userId!,
      name: input.name,
      scopes: input.scopes,
    });
    return noStoreJson(created, 201);
  } catch (error) {
    return apiError(error, 403);
  }
}
