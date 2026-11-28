import 'server-only';
import { randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { digestState } from '@/lib/crypto';
import { db } from '@/lib/db';
import { HttpError } from '@/lib/http';
import type { InviteProfileScope } from '@/lib/member-profiles';
import { requireEditingSeat, lockProjectOrganization } from './member-capacity';
import { sendMemberInvitationEmail } from './invitation-email';
import { requireOrganizationAdmin, saveOrganizationMember, validateMemberProjects, type OrganizationRole } from './workspaces';

type Sql = postgres.Sql | postgres.TransactionSql;
type Recipient = { userId: string; email: string };
type Target = { scope: InviteProfileScope; targetId: string };
type InvitationRequest = Target & { actorUserId: string } & (
  { email: string; role: OrganizationRole; projectIds?: string[] } | { promoteUserId: string; role: 'owner' }
);
interface ManagedScope {
  organizationGroupId: string;
  projectId: string | null;
  auditProjectId: string;
  role: OrganizationRole;
}
interface Invitation {
  id: string;
  organizationGroupId: string;
  projectId: string | null;
  projectIds: string[];
  invitedBy: string;
  recipientUserId: string;
  role: OrganizationRole;
  previousRole: OrganizationRole | null;
}
export interface PendingInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  previousRole: OrganizationRole | null;
}

async function managedScope(sql: Sql, actor: string, target: Target): Promise<ManagedScope> {
  if (target.scope === 'organization') {
    const group = await requireOrganizationAdmin(actor, target.targetId, sql);
    return { organizationGroupId: target.targetId, projectId: null, auditProjectId: group.defaultProjectId, role: group.role };
  }
  const [project] = await sql<ManagedScope[]>`
    select project.organization_group_id, project.id as project_id, project.id as audit_project_id, access.role
    from public.organizations project join private.project_memberships access on access.organization_id = project.id
    where project.id = ${target.targetId} and access.user_id = ${actor} and access.role in ('owner', 'admin')`;
  if (!project) throw new HttpError('Project owner or admin access is required.', 403);
  return project;
}

function requireInviteRole(scope: ManagedScope, role: OrganizationRole) {
  if ((scope.projectId && role === 'owner') || (['owner', 'admin'].includes(role) && scope.role !== 'owner')) {
    throw new HttpError('Only an organization owner can invite owners or admins.', 403);
  }
}

async function memberRole(sql: Sql, scope: ManagedScope, userId: string) {
  const rows = scope.projectId
    ? await sql<Array<{ role: OrganizationRole }>>`select role from private.project_memberships
        where organization_id = ${scope.projectId} and user_id = ${userId}`
    : await sql<Array<{ role: OrganizationRole }>>`select role from public.organization_group_memberships
        where organization_group_id = ${scope.organizationGroupId} and user_id = ${userId}`;
  return rows[0]?.role;
}

export async function sendMemberInvitation(input: InvitationRequest): Promise<boolean> {
  const token = randomBytes(32).toString('base64url');
  const staged = await db().begin(async sql => {
    if (input.scope === 'project') await lockProjectOrganization(input.targetId, sql);
    else await sql`select id from public.organization_groups where id = ${input.targetId} for update`;
    const scope = await managedScope(sql, input.actorUserId, input);
    requireInviteRole(scope, input.role);
    let email: string;
    let recipientUserId: string | null;
    let previousRole: OrganizationRole | null = null;
    const projectIds = input.scope === 'organization' && !['owner', 'admin'].includes(input.role) && 'projectIds' in input
      ? [...new Set(input.projectIds)] : [];
    if ('promoteUserId' in input) {
      const [member] = await sql<Array<{ email: string | null; role: OrganizationRole }>>`
        select email, role from private.organization_group_member_directory(${scope.organizationGroupId})
        where user_id = ${input.promoteUserId}`;
      if (!member?.email) throw new HttpError('An organization member with an email address is required.', 404);
      if (member.role === 'owner') return null;
      email = member.email.trim().toLowerCase();
      recipientUserId = input.promoteUserId;
      previousRole = member.role;
    } else {
      email = input.email.trim().toLowerCase();
      const [account] = await sql<Array<{ id: string | null }>>`select private.find_auth_user_id(${email}) as id`;
      recipientUserId = account?.id ?? null;
      if (recipientUserId && await memberRole(sql, scope, recipientUserId)) {
        throw new HttpError('This person already has access. Use the team list to change their role.', 409);
      }
    }
    if (input.scope === 'organization') await validateMemberProjects(sql, scope.organizationGroupId, input.role, projectIds);
    await requireEditingSeat(sql, scope.auditProjectId, input.role, recipientUserId ?? undefined);

    const pending = await sql<Array<{ id: string; sentAt: Date | null }>>`
      select id, sent_at from private.member_invitations where organization_group_id = ${scope.organizationGroupId}
        and project_id is not distinct from ${scope.projectId}::uuid and email = ${email}
        and canceled_at is null and accepted_at is null and expires_at > now()
        and (sent_at is not null or created_at > now() - interval '2 minutes')`;
    if (pending.length) throw new HttpError(pending[0]?.sentAt
      ? 'An invitation is already pending for this address. Cancel it to send a new one.'
      : 'An invitation is being sent. Try again in a minute.', 409);
    await sql`update private.member_invitations set canceled_at = now() where organization_group_id = ${scope.organizationGroupId}
      and project_id is not distinct from ${scope.projectId}::uuid and email = ${email} and canceled_at is null and accepted_at is null`;
    const [record] = await sql<Array<{ id: string }>>`
      insert into private.member_invitations (token_hash, organization_group_id, project_id, project_ids, email, role, invited_by, recipient_user_id, previous_role)
      values (${digestState(token)}, ${scope.organizationGroupId}, ${scope.projectId}, ${projectIds}, ${email}, ${input.role},
        ${input.actorUserId}, ${recipientUserId}, ${previousRole}) returning id`;
    return { id: record!.id, email, recipientUserId, auditProjectId: scope.auditProjectId };
  });
  if (!staged) return false;

  try {
    const recipient = await sendMemberInvitationEmail(staged.email, token, staged.recipientUserId);
    await db().begin(async sql => {
      const sent = await sql`update private.member_invitations set sent_at = now(), recipient_user_id = ${recipient}
        where id = ${staged.id} and canceled_at is null returning id`;
      if (!sent.length) throw new HttpError('The invitation was canceled.', 409);
      await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
        values (${staged.auditProjectId}, ${input.actorUserId}, 'member_invited', 'cloud', 'member_invite',
          ${staged.id}, ${`Sent ${input.role} invitation awaiting acceptance`})`;
    });
  } catch (error) {
    await db()`update private.member_invitations set canceled_at = now() where id = ${staged.id} and sent_at is null and canceled_at is null`;
    if (error instanceof HttpError) throw error;
    throw new HttpError('The invitation email could not be sent. Try again in a minute.', 502);
  }
  return true;
}

function pendingForRecipient(sql: Sql, token: string, recipient: Recipient) {
  return sql`token_hash = ${digestState(token)} and recipient_user_id = ${recipient.userId}
    and email = ${recipient.email.trim().toLowerCase()} and sent_at is not null
    and canceled_at is null and accepted_at is null and expires_at > now()`;
}

export interface InvitationPreview {
  organizationName: string;
  projectName: string | null;
  projectNames: string[];
  role: OrganizationRole;
}

export async function previewMemberInvitation(token: string, recipient: Recipient): Promise<InvitationPreview | undefined> {
  const sql = db();
  const [invite] = await sql<InvitationPreview[]>`
    select company.name as organization_name, project.name as project_name, invitation.role,
      array(select assigned.name from public.organizations assigned
        where assigned.id = any(invitation.project_ids) and assigned.archived_at is null order by assigned.name) as project_names
    from private.member_invitations invitation
    join public.organization_groups company on company.id = invitation.organization_group_id
    left join public.organizations project on project.id = invitation.project_id
    where ${pendingForRecipient(sql, token, recipient)} and (project.id is null or project.archived_at is null)`;
  return invite;
}

export async function acceptMemberInvitation(token: string, recipient: Recipient): Promise<string> {
  return db().begin(async sql => {
    const pending = pendingForRecipient(sql, token, recipient);
    const [target] = await sql<Array<{ organizationGroupId: string }>>`
      select organization_group_id from private.member_invitations where ${pending}`;
    if (!target) throw new HttpError('This invitation is unavailable. Sign in with the invited email or ask the sender for a new link.', 404);
    await sql`select id from public.organization_groups where id = ${target.organizationGroupId} for update`;
    const [invite] = await sql<Invitation[]>`select * from private.member_invitations where ${pending} for update`;
    if (!invite) throw new HttpError('This invitation is no longer available.', 409);
    const scope = await managedScope(sql, invite.invitedBy, { scope: invite.projectId ? 'project' : 'organization', targetId: invite.projectId ?? invite.organizationGroupId });
    requireInviteRole(scope, invite.role);
    const role = await memberRole(sql, scope, recipient.userId);
    if ((role ?? null) !== invite.previousRole) throw new HttpError('Your access changed after this invitation was sent. Ask the sender for a new invitation.', 409);

    if (invite.projectId) {
      await requireEditingSeat(sql, invite.projectId, invite.role, recipient.userId);
      await sql`insert into public.organization_memberships (organization_id, user_id, role)
        values (${invite.projectId}, ${recipient.userId}, ${invite.role})`;
      await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
        values (${invite.projectId}, ${recipient.userId}, 'member_role_updated', 'cloud', 'project_invitation_accept',
          ${invite.id}, 'Accepted project invitation')`;
    } else {
      await saveOrganizationMember({ actorUserId: invite.invitedBy, organizationId: invite.organizationGroupId,
        userId: recipient.userId, role: invite.role, projectIds: invite.projectIds, acceptedBy: recipient.userId }, sql);
    }
    await sql`update private.member_invitations set accepted_at = now() where id = ${invite.id}`;
    return invite.projectId ?? invite.projectIds[0] ?? scope.auditProjectId;
  });
}

export async function listPendingInvitations(actor: string, target: Target): Promise<PendingInvitation[]> {
  const sql = db();
  const scope = await managedScope(sql, actor, target);
  return sql<PendingInvitation[]>`select id, email, role, previous_role from private.member_invitations
    where organization_group_id = ${scope.organizationGroupId} and project_id is not distinct from ${scope.projectId}::uuid
      and sent_at is not null and canceled_at is null and accepted_at is null and expires_at > now()
      and (${scope.role === 'owner'} or role in ('member', 'viewer')) order by created_at desc`;
}

export async function cancelMemberInvitation(actor: string, id: string): Promise<void> {
  await db().begin(async sql => {
    const [target] = await sql<Invitation[]>`select organization_group_id, project_id, role from private.member_invitations where id = ${id}`;
    if (!target) throw new HttpError('Invitation not found.', 404);
    await sql`select id from public.organization_groups where id = ${target.organizationGroupId} for update`;
    const scope = await managedScope(sql, actor, { scope: target.projectId ? 'project' : 'organization', targetId: target.projectId ?? target.organizationGroupId });
    requireInviteRole(scope, target.role);
    const canceled = await sql`update private.member_invitations set canceled_at = now()
      where id = ${id} and accepted_at is null and canceled_at is null returning id`;
    if (!canceled.length) throw new HttpError('This invitation is no longer pending.', 409);
    await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${scope.auditProjectId}, ${actor}, 'settings_updated', 'cloud', 'member_invitation_cancel', ${id}, 'Canceled member invitation')`;
  });
}
