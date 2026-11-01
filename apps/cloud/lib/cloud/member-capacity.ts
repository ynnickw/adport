import 'server-only';
import type postgres from 'postgres';
import { db } from '@/lib/db';

export async function editingMemberCapacity(projectId: string, userId?: string, sql: postgres.Sql | postgres.TransactionSql = db()) {
  const [capacity] = await sql<Array<{ count: number; existing: boolean }>>`
    select private.organization_editing_member_count(project.organization_group_id)::int as count,
      exists (select 1 from public.organization_group_memberships member
        where member.organization_group_id = project.organization_group_id
          and member.user_id = ${userId ?? null}::uuid and member.role <> 'viewer') as existing
    from public.organizations project where project.id = ${projectId}`;
  return capacity ?? { count: 0, existing: false };
}

export async function lockProjectOrganization(projectId: string, sql: postgres.Sql | postgres.TransactionSql): Promise<void> {
  await sql`select company.id from public.organization_groups company
    join public.organizations project on project.organization_group_id = company.id
    where project.id = ${projectId} for update of company`;
}
