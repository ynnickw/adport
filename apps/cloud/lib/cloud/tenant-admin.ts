import 'server-only';
import type { Policy } from '@adport/core';
import { createAdminClient } from '@/lib/supabase/admin';
import { db } from '@/lib/db';
import type { TenantPrincipal } from './types';
import { getOrganizationEntitlement } from './plans';

export type AssignableRole = 'admin' | 'member' | 'viewer';

function requireMemberAdmin(principal: TenantPrincipal): void {
  if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
}

function requireAssignableRole(principal: TenantPrincipal, role: AssignableRole): void {
  requireMemberAdmin(principal);
  if (role === 'admin' && principal.role !== 'owner') throw new Error('Only an owner can grant admin access.');
}

export async function listOrganizationMembers(organizationId: string) {
  return db()<Array<{ userId: string; email: string; displayName: string; role: string; createdAt: Date }>>`
    select * from private.organization_member_directory(${organizationId})
  `;
}

export async function inviteOrganizationMember(
  principal: TenantPrincipal,
  email: string,
  role: AssignableRole,
): Promise<{ added: boolean; invitationSent: boolean; targetUserId: string }> {
  requireAssignableRole(principal, role);
  const entitlement = await getOrganizationEntitlement(principal.organizationId);
  if (entitlement.plan.maxMembers !== null) {
    const totals = await db()<Array<{ count: number }>>`
      select count(*)::int as count from public.organization_memberships
      where organization_id = ${principal.organizationId}
    `;
    if ((totals[0]?.count ?? 0) >= entitlement.plan.maxMembers) {
      throw new Error(`${entitlement.plan.name} supports ${entitlement.plan.maxMembers} workspace member${entitlement.plan.maxMembers === 1 ? '' : 's'}.`);
    }
  }
  const normalizedEmail = email.trim().toLowerCase();
  const users = await db()<Array<{ id: string | null }>>`
    select private.find_auth_user_id(${normalizedEmail}) as id
  `;
  let targetUserId = users[0]?.id;
  let invitationSent = false;
  if (!targetUserId) {
    const result = await createAdminClient().auth.admin.inviteUserByEmail(normalizedEmail, {
      data: { full_name: normalizedEmail.split('@')[0] },
    });
    if (result.error || !result.data.user) throw result.error ?? new Error('Invitation failed.');
    targetUserId = result.data.user.id;
    invitationSent = true;
  }

  const added = await db().begin(async (sql) => {
    const inserted = await sql<Array<{ userId: string }>>`
      insert into public.organization_memberships (organization_id, user_id, role)
      values (${principal.organizationId}, ${targetUserId}, ${role})
      on conflict (organization_id, user_id) do nothing
      returning user_id
    `;
    await sql`
      insert into public.audit_events
        (organization_id, actor_user_id, api_key_id, event, provider, tool, account_id, summary, details)
      values
        (${principal.organizationId}, ${principal.userId ?? null}, ${principal.apiKeyId ?? null}, 'member_invited',
         'cloud', 'member_invite', ${targetUserId},
         ${inserted.length ? `Added ${normalizedEmail} as ${role}` : `${normalizedEmail} is already a member`},
         ${sql.json({ role, invitationSent } as never)})
    `;
    return inserted.length === 1;
  });
  return { added, invitationSent, targetUserId };
}

export async function changeOrganizationMemberRole(
  principal: TenantPrincipal,
  targetUserId: string,
  role: AssignableRole,
): Promise<void> {
  requireAssignableRole(principal, role);
  await db().begin(async (sql) => {
    const rows = await sql<Array<{ role: string }>>`
      select role from public.organization_memberships
      where organization_id = ${principal.organizationId} and user_id = ${targetUserId}
      for update
    `;
    const target = rows[0];
    if (!target) throw new Error('Member not found.');
    if (principal.role === 'admin' && ['owner', 'admin'].includes(target.role)) throw new Error('Admins cannot change owners or other admins.');
    if (target.role === 'owner') {
      const owners = await sql<Array<{ count: number }>>`
        select count(*)::int as count from public.organization_memberships
        where organization_id = ${principal.organizationId} and role = 'owner'
      `;
      if ((owners[0]?.count ?? 0) <= 1) throw new Error('Transfer ownership before changing the last owner.');
    }
    await sql`
      update public.organization_memberships set role = ${role}
      where organization_id = ${principal.organizationId} and user_id = ${targetUserId}
    `;
    await sql`
      insert into public.audit_events
        (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${principal.organizationId}, ${principal.userId ?? null}, 'member_role_updated', 'cloud',
        'member_role_update', ${targetUserId}, ${`Changed member role to ${role}`})
    `;
  });
}

export async function removeOrganizationMember(principal: TenantPrincipal, targetUserId: string): Promise<void> {
  requireMemberAdmin(principal);
  await db().begin(async (sql) => {
    const rows = await sql<Array<{ role: string }>>`
      select role from public.organization_memberships
      where organization_id = ${principal.organizationId} and user_id = ${targetUserId}
      for update
    `;
    const target = rows[0];
    if (!target) throw new Error('Member not found.');
    if (principal.role === 'admin' && ['owner', 'admin'].includes(target.role)) throw new Error('Admins cannot remove owners or other admins.');
    if (target.role === 'owner') {
      const owners = await sql<Array<{ count: number }>>`
        select count(*)::int as count from public.organization_memberships
        where organization_id = ${principal.organizationId} and role = 'owner'
      `;
      if ((owners[0]?.count ?? 0) <= 1) throw new Error('The last owner cannot be removed.');
    }
    await sql`
      delete from public.organization_memberships
      where organization_id = ${principal.organizationId} and user_id = ${targetUserId}
    `;
    await sql`
      insert into public.audit_events
        (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${principal.organizationId}, ${principal.userId ?? null}, 'member_removed', 'cloud',
        'member_remove', ${targetUserId}, 'Removed organization member')
    `;
  });
}

export async function renameOrganization(principal: TenantPrincipal, name: string): Promise<void> {
  requireMemberAdmin(principal);
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) throw new Error('Organization name must be between 1 and 120 characters.');
  await db().begin(async (sql) => {
    await sql`
      update public.organizations
      set name = ${trimmed}, updated_at = now()
      where id = ${principal.organizationId}
    `;
    await sql`
      insert into public.audit_events
        (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${principal.organizationId}, ${principal.userId ?? null}, 'settings_updated', 'cloud',
        'organization_rename', '*', ${`Renamed organization to ${trimmed}`})
    `;
  });
}

export async function updateOrganizationSettings(
  principal: TenantPrincipal,
  policy: Policy,
  dataRetentionDays: number,
): Promise<void> {
  requireMemberAdmin(principal);
  const entitlement = await getOrganizationEntitlement(principal.organizationId);
  if (dataRetentionDays > entitlement.plan.maxRetentionDays) {
    throw new Error(`${entitlement.plan.name} supports up to ${entitlement.plan.maxRetentionDays} days of retention.`);
  }
  await db().begin(async (sql) => {
    await sql`
      update public.organization_settings
      set policy = ${sql.json(policy as never)}, data_retention_days = ${dataRetentionDays}
      where organization_id = ${principal.organizationId}
    `;
    await sql`
      insert into public.audit_events
        (organization_id, actor_user_id, event, provider, tool, account_id, summary, details)
      values (${principal.organizationId}, ${principal.userId ?? null}, 'settings_updated', 'cloud',
        'organization_settings_update', '*', 'Updated organization safety policy and retention',
        ${sql.json({ dataRetentionDays } as never)})
    `;
  });
}
