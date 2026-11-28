import 'server-only';
import type postgres from 'postgres';
import { db } from '@/lib/db';
import { getOrganizationEntitlement, recommendedUpgradePlan } from './plans';
import { PlanLimitError } from './plan-limit';

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

export async function requireEditingSeat(sql: postgres.TransactionSql, projectId: string, role: string, userId?: string): Promise<void> {
  if (role === 'viewer') return;
  const entitlement = await getOrganizationEntitlement(projectId, sql);
  if (entitlement.plan.maxMembers === null) return;
  const members = await editingMemberCapacity(projectId, userId, sql);
  if (!members.existing && members.count >= entitlement.plan.maxMembers) {
    throw new PlanLimitError({ kind: 'members', currentPlan: entitlement.plan.name,
      recommendedPlan: recommendedUpgradePlan(entitlement.plan.id, { members: members.count + 1 }),
      message: 'Your organization has reached its editing-member limit. Read-only viewers are free.' });
  }
}
