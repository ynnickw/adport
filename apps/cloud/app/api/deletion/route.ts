import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { revokeGoogleToken } from '@/lib/cloud/google-oauth';
import { loadGoogleCredential, recordAudit } from '@/lib/cloud/repository';
import { createAdminClient } from '@/lib/supabase/admin';
import { db } from '@/lib/db';
import { apiError, noStoreJson } from '@/lib/http';

const schema = z.object({ organization_id: z.string().uuid(), confirmation: z.literal('DELETE') });

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const principal = await sessionPrincipal(input.organization_id);
    if (principal.role !== 'owner') throw new Error('Only an organization owner can delete cloud data.');
    const credential = await loadGoogleCredential(principal.organizationId);
    if (credential) await revokeGoogleToken(credential.refreshToken);
    await recordAudit(principal, {
      event: 'deletion_requested', provider: 'cloud', tool: 'organization_delete', accountId: '*', summary: 'Organization data deletion requested',
    });
    await db()`delete from public.organizations where id = ${principal.organizationId}`;
    const remaining = await db()<Array<{ count: number }>>`
      select count(*)::int as count from public.organization_memberships where user_id = ${principal.userId!}
    `;
    if (remaining[0]?.count === 0) await createAdminClient().auth.admin.deleteUser(principal.userId!);
    return noStoreJson({ deleted: true });
  } catch (error) {
    return apiError(error, 403);
  }
}
