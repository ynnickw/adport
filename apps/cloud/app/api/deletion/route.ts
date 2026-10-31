import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { revokeGoogleToken } from '@/lib/cloud/google-oauth';
import { loadGoogleCredential } from '@/lib/cloud/repository';
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
    await db().begin(async sql => {
      await sql`select company.id from public.organization_groups company
        join public.organizations project on project.organization_group_id = company.id
        where project.id = ${principal.organizationId} for update of company`;
      const membership = await sql`select role from private.project_memberships
        where organization_id = ${principal.organizationId} and user_id = ${principal.userId!} and role = 'owner'`;
      if (!membership.length) throw new Error('Project owner access is required.');
      const siblings = await sql`select sibling.id from public.organizations project
        join public.organization_groups company on company.default_project_id = project.id
        join public.organizations sibling on sibling.organization_group_id = company.id and sibling.id <> project.id
        where project.id = ${principal.organizationId} limit 1`;
      if (siblings.length) throw new Error('This is the organization’s default project. Remove its other projects before deleting it.');
      if (credential) await revokeGoogleToken(credential.refreshToken);
      await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
        values (${principal.organizationId}, ${principal.userId!}, 'deletion_requested', 'cloud', 'project_delete', '*', 'Project data deletion requested')`;
      await sql`delete from public.organizations where id = ${principal.organizationId}`;
    });
    const remaining = await db()<Array<{ count: number }>>`
      select count(*)::int as count from public.organization_group_memberships where user_id = ${principal.userId!}
    `;
    if (remaining[0]?.count === 0) await createAdminClient().auth.admin.deleteUser(principal.userId!);
    return noStoreJson({ deleted: true });
  } catch (error) {
    return apiError(error, 403);
  }
}
