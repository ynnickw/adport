import 'server-only';
import { cache } from 'react';
import { db } from '@/lib/db';

export interface OrganizationUsage {
  enabledAccounts: number;
  editingMembers: number;
  projects: number;
  viewers: number;
}

/** Aggregate allowances only; never exposes another project's accounts or people. */
export const getOrganizationUsage = cache(async (projectId: string): Promise<OrganizationUsage> => {
  const [usage] = await db()<OrganizationUsage[]>`
    select
      (select count(*)::int from public.organization_ad_accounts account
        join public.organizations project on project.id = account.organization_id
        where project.organization_group_id = company.id
          and project.archived_at is null and account.enabled) as enabled_accounts,
      private.organization_editing_member_count(company.id)::int as editing_members,
      (select count(*)::int from public.organizations project
        where project.organization_group_id = company.id and project.archived_at is null) as projects,
      (select count(*)::int from public.organization_group_memberships member
        where member.organization_group_id = company.id and member.role = 'viewer') as viewers
    from public.organization_groups company
    join public.organizations current_project on current_project.organization_group_id = company.id
    where current_project.id = ${projectId} and current_project.archived_at is null
  `;
  return usage ?? { enabledAccounts: 0, editingMembers: 0, projects: 0, viewers: 0 };
});
