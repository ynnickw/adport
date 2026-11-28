import { Input } from '@/components/controls';
import { DialogTrigger } from '@/components/dialog';
import { MemberAccessFields } from '@/components/member-access-fields';
import { TeamRolesTooltip } from '@/components/team-access-guide';
import { InviteProfileField } from '@/components/invite-profile-field';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { PageHeader } from '@/components/ui';
import { WorkspaceForm } from '@/components/workspace-form';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationProjects, listOrganizationTeam } from '@/lib/cloud/workspaces';
import { renameCompanyAction, saveMemberAction, removeMemberAction } from '../projects/actions';
import { WorkspaceLogoEditor } from '@/components/workspace-logo-editor';
import { workspaceLogoUrl } from '@/lib/workspace-logos';
import { PeopleTable } from '@/components/people-table';
import { PendingMemberInvitations } from '@/components/pending-member-invitations';
import { listPendingInvitations } from '@/lib/cloud/member-invitations';

export const metadata = { title: 'Organization' };

export default async function OrganizationPage() {
  const tenant = await requireDashboardTenant();
  const canManage = ['owner', 'admin'].includes(tenant.organizationRole);
  if (!canManage) return <main className="page"><PageHeader title="Organization" /><p>Only organization owners and admins can manage people and settings.</p></main>;
  const [members, projects, usage, entitlement, invitations] = await Promise.all([
    listOrganizationTeam(tenant.userId, tenant.organizationGroupId),
    listOrganizationProjects(tenant.userId, tenant.organizationGroupId),
    getOrganizationUsage(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    listPendingInvitations(tenant.userId, { scope: 'organization', targetId: tenant.organizationGroupId }),
  ]);
  const activeProjects = projects.filter(project => !project.archivedAt);
  const seatAvailable = entitlement.plan.maxMembers === null || usage.editingMembers < entitlement.plan.maxMembers;
  const isOwner = tenant.organizationRole === 'owner';
  const roles = [
    { value: 'member', label: 'Member' },
    { value: 'viewer', label: 'Viewer' },
    ...(isOwner ? [{ value: 'admin', label: 'Admin' }, { value: 'owner', label: 'Owner' }] : []),
  ];
  return <main className="page settings-page">
    <PageHeader title="Organization" action={<>
      <DialogTrigger label="Edit organization" title={`Edit ${tenant.organizationGroupName}`}>
        <div className="stack">
          <WorkspaceLogoEditor key={tenant.organizationGroupId} kind="organization" id={tenant.organizationGroupId} name={tenant.organizationGroupName} logoUrl={workspaceLogoUrl('organization', tenant.organizationGroupId, tenant.organizationGroupLogoPath)} />
          <WorkspaceForm action={renameCompanyAction}>
            <input type="hidden" name="organizationId" value={tenant.organizationGroupId} />
            <label>Organization name<Input name="name" defaultValue={tenant.organizationGroupName} required maxLength={120} /></label>
          </WorkspaceForm>
        </div>
      </DialogTrigger>
      <DialogTrigger label="Invite member" title="Invite a teammate" className="button">
        <WorkspaceForm action={saveMemberAction} label="Send invitation" resetOnSuccess>
          <p className="field-hint">Access starts when the recipient accepts the email invitation.</p>
          <input type="hidden" name="organizationId" value={tenant.organizationGroupId} />
          <InviteProfileField key={tenant.organizationGroupId} scope="organization" targetId={tenant.organizationGroupId} />
          <MemberAccessFields key={String(seatAvailable)} roles={roles} projects={activeProjects} initialRole={seatAvailable ? 'member' : 'viewer'} initialProjectIds={[tenant.organizationId]} seatAvailable={seatAvailable} requiredSeats={usage.editingMembers + 1} />
        </WorkspaceForm>
      </DialogTrigger>
    </>} />
    <section className="settings-section people-settings" aria-labelledby="organization-people">
      <div className="settings-section-head">
        <h2 id="organization-people">People <TeamRolesTooltip scope="organization" /></h2>
        <p className="card-note people-counts">
          <span>{usage.editingMembers}{entitlement.plan.maxMembers === null ? '' : ` / ${entitlement.plan.maxMembers}`} team seats</span>
          <span>{usage.viewers} free {usage.viewers === 1 ? 'viewer' : 'viewers'}</span>
        </p>
      </div>
      <PeopleTable rows={members.map(member => {
        const allProjects = member.role === 'owner' || member.role === 'admin';
        const isSelf = member.userId === tenant.userId;
        const access = allProjects ? 'All current and future projects' : projects
          .filter(project => member.projectIds.includes(project.id))
          .map(project => project.name + (project.archivedAt ? ' (archived)' : ''))
          .join(', ') || 'No assigned projects';
        return {
          id: member.userId, name: member.displayName, email: member.email, avatarUrl: member.avatarUrl, isSelf,
          role: <span className="status neutral">{member.role}</span>,
          access,
          action: isOwner || !allProjects ? <DialogTrigger label="Edit access" title={`Access for ${member.displayName}`} className="button secondary small">
            <div className="stack">
              <WorkspaceForm action={saveMemberAction} label="Save access">
                <input type="hidden" name="organizationId" value={tenant.organizationGroupId} />
                <input type="hidden" name="userId" value={member.userId} />
                <MemberAccessFields roles={roles} projects={activeProjects} initialRole={member.role} initialProjectIds={member.projectIds} editing
                  seatAvailable={seatAvailable || member.role !== 'viewer'} requiredSeats={usage.editingMembers + 1} />
              </WorkspaceForm>
              {!isSelf ? <WorkspaceForm action={removeMemberAction} label="Remove from organization" danger confirmation={{
                title: 'Remove ' + member.displayName + '?',
                description: 'They will lose access to every project in this organization. Their connected agents will also lose access.',
                confirmLabel: 'Remove member',
              }}>
                <input type="hidden" name="organizationId" value={tenant.organizationGroupId} />
                <input type="hidden" name="userId" value={member.userId} />
              </WorkspaceForm> : null}
            </div>
          </DialogTrigger> : null,
        };
      })} />
    </section>
    <PendingMemberInvitations invitations={invitations} />
  </main>;
}
