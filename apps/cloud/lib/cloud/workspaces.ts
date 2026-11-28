import 'server-only';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { db } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { safeProfileAvatarUrl } from '@/lib/member-profiles';
import type { TenantPrincipal } from './types';
import { lockProjectOrganization, requireEditingSeat } from './member-capacity';

export type OrganizationRole = NonNullable<TenantPrincipal['role']>;
export interface ProjectAccess {
  id: string;
  name: string;
  logoPath: string | null;
  organizationId: string;
  organizationName: string;
  organizationLogoPath: string | null;
  role: OrganizationRole;
  organizationRole: OrganizationRole;
  defaultProjectId: string;
  archivedAt: Date | null;
}

export async function listProjectAccess(userId: string): Promise<ProjectAccess[]> {
  return db()<ProjectAccess[]>`
    select project.id, project.name, project.logo_path, company.id as organization_id, company.name as organization_name, company.logo_path as organization_logo_path,
      access.role, member.role as organization_role, company.default_project_id, project.archived_at
    from private.project_memberships access
    join public.organizations project on project.id = access.organization_id
    join public.organization_groups company on company.id = project.organization_group_id
    join public.organization_group_memberships member on member.organization_group_id = company.id and member.user_id = access.user_id
    where access.user_id = ${userId}
    order by company.created_at, project.created_at, project.id
  `;
}

export async function requireOrganizationAdmin(userId: string, organizationId: string, sql: postgres.Sql | postgres.TransactionSql = db()) {
  const rows = await sql<Array<{ role: OrganizationRole; defaultProjectId: string; name: string }>>`
    select member.role, company.default_project_id, company.name
    from public.organization_groups company
    join public.organization_group_memberships member on member.organization_group_id = company.id
    where company.id = ${organizationId} and member.user_id = ${userId}
  `;
  const organization = rows[0];
  if (!organization || !['owner', 'admin'].includes(organization.role)) throw new HttpError('Organization owner or admin access is required.', 403);
  return organization;
}

function checkedName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 120) throw new HttpError('Name must be between 1 and 120 characters.', 400);
  return value;
}

export async function createOrganization(userId: string, name: string): Promise<string> {
  const organizationName = checkedName(name);
  const id = randomUUID();
  await db().begin(async sql => {
    await sql`insert into public.organizations (id, name, slug, created_by)
      values (${id}, 'General', ${`org-${id}`}, ${userId})`;
    await sql`update public.organization_groups set name = ${organizationName} where id = ${id}`;
    await sql`insert into public.organization_memberships (organization_id, user_id, role) values (${id}, ${userId}, 'owner')`;
    await sql`insert into public.organization_settings (organization_id) values (${id})`;
    await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${id}, ${userId}, 'settings_updated', 'cloud', 'organization_create', '*', 'Created organization and default project')`;
  });
  return id;
}

export async function createProject(userId: string, organizationId: string, name: string): Promise<string> {
  const projectName = checkedName(name);
  const id = randomUUID();
  await db().begin(async sql => {
    await sql`select id from public.organization_groups where id = ${organizationId} for update`;
    await requireOrganizationAdmin(userId, organizationId, sql);
    await sql`insert into public.organizations (id, name, slug, created_by, organization_group_id)
      values (${id}, ${projectName}, ${`project-${id}`}, ${userId}, ${organizationId})`;
    await sql`insert into public.organization_settings (organization_id) values (${id})`;
    await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${id}, ${userId}, 'settings_updated', 'cloud', 'project_create', '*', 'Created isolated project')`;
  });
  return id;
}

export async function updateProject(userId: string, projectId: string, input: { name?: string; archived?: boolean }): Promise<void> {
  await db().begin(async sql => {
    const organizationId = await lockProjectOrganization(projectId, sql);
    await requireOrganizationAdmin(userId, organizationId, sql);
    if (input.name !== undefined) await sql`update public.organizations set name = ${checkedName(input.name)} where id = ${projectId}`;
    if (input.archived !== undefined) {
      await sql`update public.organizations set archived_at = ${input.archived ? new Date() : null} where id = ${projectId}`;
      if (input.archived) await sql`update public.organization_ad_accounts set enabled = false where organization_id = ${projectId}`;
    }
    await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${projectId}, ${userId}, 'settings_updated', 'cloud', 'project_update', '*',
        ${input.archived === true ? 'Archived project and suspended agent access' : input.archived === false ? 'Restored project' : 'Renamed project'})`;
  });
}

export async function listOrganizationProjects(userId: string, organizationId: string) {
  await requireOrganizationAdmin(userId, organizationId);
  return db()<Array<{ id: string; name: string; logoPath: string | null; archivedAt: Date | null; enabledAccounts: number }>>`
    select project.id, project.name, project.logo_path, project.archived_at,
      (select count(*)::int from public.organization_ad_accounts account where account.organization_id = project.id and account.enabled
        and private.provider_uses_ad_account_slot(account.provider)) as enabled_accounts
    from public.organizations project where project.organization_group_id = ${organizationId} order by project.created_at, project.id
  `;
}

export async function organizationActiveAccounts(projectId: string): Promise<number> {
  const rows = await db()<Array<{ count: number }>>`select count(*)::int as count
    from public.organization_ad_accounts account
    join public.organizations project on project.id = account.organization_id
    where project.organization_group_id = (select organization_group_id from public.organizations where id = ${projectId})
      and project.archived_at is null and account.enabled
      and private.provider_uses_ad_account_slot(account.provider)`;
  return rows[0]?.count ?? 0;
}

export async function listOrganizationTeam(userId: string, organizationId: string) {
  await requireOrganizationAdmin(userId, organizationId);
  const [members, grants] = await Promise.all([
    db()<Array<{ userId: string; email: string; displayName: string; avatarUrl: string | null; role: OrganizationRole }>>`
      select directory.*, private.profile_avatar_url(directory.user_id) as avatar_url
      from private.organization_group_member_directory(${organizationId}) directory`,
    db()<Array<{ userId: string; projectId: string }>>`
      select member.user_id, project.id as project_id from public.organization_memberships member
      join public.organizations project on project.id = member.organization_id where project.organization_group_id = ${organizationId}`,
  ]);
  return members.map(member => ({
    ...member,
    avatarUrl: safeProfileAvatarUrl(member.avatarUrl),
    projectIds: grants.filter(grant => grant.userId === member.userId).map(grant => grant.projectId),
  }));
}

export async function renameCompany(userId: string, organizationId: string, name: string): Promise<void> {
  await db().begin(async sql => {
    await sql`select id from public.organization_groups where id = ${organizationId} for update`;
    const organization = await requireOrganizationAdmin(userId, organizationId, sql);
    await sql`update public.organization_groups set name = ${checkedName(name)} where id = ${organizationId}`;
    await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${organization.defaultProjectId}, ${userId}, 'settings_updated', 'cloud', 'organization_rename', '*', 'Renamed organization')`;
  });
}

export async function saveSetupWorkspaceNames(
  actorUserId: string,
  projectId: string,
  input: { organizationName: string; projectName: string; advance: boolean },
): Promise<void> {
  const organizationName = checkedName(input.organizationName);
  const projectName = checkedName(input.projectName);
  await db().begin(async sql => {
    const [company] = await sql<Array<{ id: string }>>`
      select id from public.organization_groups where default_project_id = ${projectId} for update`;
    if (!company) throw new HttpError('Only the first project can be named with its organization.', 404);
    await requireOrganizationAdmin(actorUserId, company.id, sql);
    const organizations = await sql`update public.organization_groups set name = ${organizationName}
      where id = ${company.id} and name is distinct from ${organizationName}`;
    const projects = await sql`update public.organizations set name = ${projectName}
      where id = ${projectId} and name is distinct from ${projectName}`;
    if (organizations.count || projects.count) await sql`
      insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${projectId}, ${actorUserId}, 'settings_updated', 'cloud', 'setup_workspace_names', '*', 'Updated workspace names during setup')`;
    if (input.advance) await sql`
      insert into public.organization_onboarding (organization_id, current_step) values (${projectId}, 'connect')
      on conflict (organization_id) do update set current_step = excluded.current_step
      where organization_onboarding.current_step = 'welcome'`;
  });
}

export async function validateMemberProjects(sql: postgres.Sql | postgres.TransactionSql, organizationId: string, role: OrganizationRole, projectIds: string[]) {
  if (['owner', 'admin'].includes(role)) return;
  if (!projectIds.length) throw new HttpError('Select at least one project for this member.', 400);
  const projects = await sql<Array<{ id: string }>>`select id from public.organizations
    where organization_group_id = ${organizationId} and archived_at is null`;
  if (projectIds.some(id => !projects.some(project => project.id === id))) throw new HttpError('A selected project is no longer available in this organization.', 403);
}

export async function saveOrganizationMember(input: {
  actorUserId: string; organizationId: string; userId: string;
  role: OrganizationRole; projectIds: string[]; existingOnly?: boolean; acceptedBy?: string;
}, transaction?: postgres.TransactionSql): Promise<void> {
  const target = input.userId;
  const write = async (sql: postgres.TransactionSql) => {
    await sql`select id from public.organization_groups where id = ${input.organizationId} for update`;
    const organization = await requireOrganizationAdmin(input.actorUserId, input.organizationId, sql);
    const existing = await sql<Array<{ role: OrganizationRole }>>`select role from public.organization_group_memberships
      where organization_group_id = ${input.organizationId} and user_id = ${target}`;
    if (input.existingOnly) {
      if (!existing.length) throw new HttpError('This person must accept an invitation before you can edit access.', 409);
      if (input.role === 'owner' && existing[0]?.role !== 'owner') throw new HttpError('The member must accept an ownership invitation.', 409);
    }
    if (organization.role !== 'owner' && (['owner', 'admin'].includes(input.role) || ['owner', 'admin'].includes(existing[0]?.role ?? ''))) {
      throw new HttpError('Only an owner can manage organization owners or admins.', 403);
    }
    if (existing[0]?.role === 'owner' && input.role !== 'owner') {
      const owners = await sql<Array<{ count: number }>>`select count(*)::int as count from public.organization_group_memberships
        where organization_group_id = ${input.organizationId} and role = 'owner'`;
      if (owners[0]!.count <= 1) throw new HttpError('The last organization owner cannot be demoted.', 409);
    }
    await requireEditingSeat(sql, organization.defaultProjectId, input.role, target);
    const projectIds = ['owner', 'admin'].includes(input.role) ? [] : [...new Set(input.projectIds)];
    await validateMemberProjects(sql, input.organizationId, input.role, projectIds);
    if (input.existingOnly && input.role !== existing[0]?.role) await sql`
      update private.member_invitations set canceled_at = now() where organization_group_id = ${input.organizationId}
        and recipient_user_id = ${target} and previous_role is not null and canceled_at is null and accepted_at is null`;
    await sql`insert into public.organization_group_memberships (organization_group_id, user_id, role)
      values (${input.organizationId}, ${target}, ${input.role}) on conflict (organization_group_id, user_id) do update set role = excluded.role`;
    await sql`delete from public.organization_memberships where user_id = ${target}
      and organization_id in (select id from public.organizations where organization_group_id = ${input.organizationId})`;
    if (!['owner', 'admin'].includes(input.role)) {
      for (const projectId of projectIds) await sql`insert into public.organization_memberships (organization_id, user_id, role)
        values (${projectId}, ${target}, ${input.role})`;
    }
    await sql`update private.mcp_oauth_access_tokens token set revoked_at = now() where token.user_id = ${target}
      and token.organization_group_id is null
      and token.organization_id in (select id from public.organizations where organization_group_id = ${input.organizationId})
      and not exists (select 1 from private.project_memberships access where access.organization_id = token.organization_id and access.user_id = ${target})`;
    await sql`update private.mcp_oauth_refresh_tokens token set revoked_at = now() where token.user_id = ${target}
      and token.organization_group_id is null
      and token.organization_id in (select id from public.organizations where organization_group_id = ${input.organizationId})
      and not exists (select 1 from private.project_memberships access where access.organization_id = token.organization_id and access.user_id = ${target})`;
    await sql`update private.mcp_oauth_authorization_codes code set consumed_at = coalesce(consumed_at, now()) where code.user_id = ${target}
      and code.organization_group_id is null
      and code.organization_id in (select id from public.organizations where organization_group_id = ${input.organizationId})
      and not exists (select 1 from private.project_memberships access where access.organization_id = code.organization_id and access.user_id = ${target})`;
    await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary, details)
      values (${organization.defaultProjectId}, ${input.acceptedBy ?? input.actorUserId}, 'member_role_updated', 'cloud',
        ${input.acceptedBy ? 'organization_invitation_accept' : 'organization_member_save'}, ${target},
        ${input.acceptedBy ? 'Accepted organization invitation' : 'Updated organization membership and project access'},
        ${sql.json({ role: input.role, projectIds } as never)})`;
  };
  if (transaction) await write(transaction);
  else await db().begin(write);
}

export async function removeCompanyMember(actorUserId: string, organizationId: string, targetUserId: string): Promise<void> {
  await db().begin(async sql => {
    await sql`select id from public.organization_groups where id = ${organizationId} for update`;
    const organization = await requireOrganizationAdmin(actorUserId, organizationId, sql);
    const members = await sql<Array<{ userId: string; role: OrganizationRole }>>`select user_id, role
      from public.organization_group_memberships where organization_group_id = ${organizationId}`;
    const target = members.find(member => member.userId === targetUserId);
    if (!target) throw new HttpError('Member not found.', 404);
    if (organization.role !== 'owner' && ['owner', 'admin'].includes(target.role)) throw new HttpError('Only an owner can remove owners or admins.', 403);
    if (target.role === 'owner' && members.filter(member => member.role === 'owner').length <= 1) throw new HttpError('The last organization owner cannot be removed.', 409);
    await sql`update private.member_invitations set canceled_at = now() where organization_group_id = ${organizationId}
      and recipient_user_id = ${targetUserId} and canceled_at is null and accepted_at is null`;
    await sql`delete from public.organization_memberships where user_id = ${targetUserId}
      and organization_id in (select id from public.organizations where organization_group_id = ${organizationId})`;
    await sql`delete from public.organization_group_memberships where organization_group_id = ${organizationId} and user_id = ${targetUserId}`;
    await sql`update private.mcp_oauth_access_tokens set revoked_at = now() where user_id = ${targetUserId}
      and organization_id in (select id from public.organizations where organization_group_id = ${organizationId})`;
    await sql`update private.mcp_oauth_refresh_tokens set revoked_at = now() where user_id = ${targetUserId}
      and organization_id in (select id from public.organizations where organization_group_id = ${organizationId})`;
    await sql`update private.mcp_oauth_authorization_codes set consumed_at = coalesce(consumed_at, now()) where user_id = ${targetUserId}
      and organization_id in (select id from public.organizations where organization_group_id = ${organizationId})`;
    await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${organization.defaultProjectId}, ${actorUserId}, 'member_removed', 'cloud', 'organization_member_remove', ${targetUserId}, 'Removed member and revoked project access')`;
  });
}
