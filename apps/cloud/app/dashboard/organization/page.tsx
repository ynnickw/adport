import { Input } from '@/components/controls';
import { DialogTrigger } from '@/components/dialog';
import { MemberAccessFields } from '@/components/member-access-fields';
import { TeamAccessGuide } from '@/components/team-access-guide';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { PageHeader } from '@/components/ui';
import { WorkspaceForm } from '@/components/workspace-form';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationProjects, listOrganizationTeam } from '@/lib/cloud/workspaces';
import { renameCompanyAction, saveMemberAction, removeMemberAction } from '../projects/actions';
import { WorkspaceLogoEditor } from '@/components/workspace-logo-editor';
import { workspaceLogoUrl } from '@/lib/workspace-logos';

export const metadata = { title: 'Organization' };

export default async function OrganizationPage() {
  const tenant = await requireDashboardTenant();
  const canManage = ['owner', 'admin'].includes(tenant.organizationRole);
  if (!canManage) return <main className="page"><PageHeader title="Organization" description="An owner or admin manages organization settings." /><p className="inline-note">Ask an organization owner or admin to change these settings.</p></main>;
  const [members, projects, usage, entitlement] = await Promise.all([listOrganizationTeam(tenant.userId, tenant.organizationGroupId), listOrganizationProjects(tenant.userId, tenant.organizationGroupId), getOrganizationUsage(tenant.organizationId), getOrganizationEntitlement(tenant.organizationId)]);
  const activeProjects = projects.filter(project => !project.archivedAt);
  const seatAvailable = entitlement.plan.maxMembers === null || usage.editingMembers < entitlement.plan.maxMembers;
  const roles = [{ value: 'member', label: 'Member (uses a team seat)' }, { value: 'viewer', label: 'Viewer (free, read-only)' }, ...(tenant.organizationRole === 'owner' ? [{ value: 'admin', label: 'Admin' }, { value: 'owner', label: 'Owner' }] : [])];
  return <main className="page">
    <p className="workspace-context-label">{tenant.organizationGroupName}</p>
    <PageHeader title="Organization" description="Manage your team and choose which projects each person can access. Owners, admins, and editing members use a plan seat. Read-only viewers are free."
      action={<DialogTrigger label="Invite member" title="Invite a teammate" className="button"><WorkspaceForm action={saveMemberAction} label="Invite member" successMessage="Access saved. New users receive an email invitation; existing users can open the project from their project menu."><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><label>Email address<Input type="email" name="email" required maxLength={320} placeholder="name@company.com" /></label><MemberAccessFields key={String(seatAvailable)} roles={roles} projects={activeProjects} initialRole={seatAvailable ? 'member' : 'viewer'} initialProjectIds={[tenant.organizationId]} seatAvailable={seatAvailable} requiredSeats={usage.editingMembers + 1} /></WorkspaceForm></DialogTrigger>} />
    <div className="stack">
      <TeamAccessGuide />
      <section className="card"><div className="card-head"><h2>Organization details</h2></div><div className="card-body stack">
        <WorkspaceLogoEditor key={tenant.organizationGroupId} kind="organization" id={tenant.organizationGroupId} name={tenant.organizationGroupName} logoUrl={workspaceLogoUrl('organization', tenant.organizationGroupId, tenant.organizationGroupLogoPath)} />
        <WorkspaceForm action={renameCompanyAction}><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><label>Organization name<Input name="name" defaultValue={tenant.organizationGroupName} required maxLength={120} /></label></WorkspaceForm>
      </div></section>
      <section className="card"><div className="card-head"><h2>Members</h2><span className="card-note">{usage.editingMembers} team seats · {usage.viewers} free viewers</span></div><div className="row-list">
        {members.map(member => <div className="row-item" key={member.userId}>
          <div className="identity"><span className="avatar" aria-hidden="true">{member.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{member.displayName}{member.userId === tenant.userId ? ' · you' : ''}</strong><div className="cell-sub">{member.email}</div><div className="cell-sub">{['owner', 'admin'].includes(member.role) ? 'All current and future projects' : projects.filter(project => member.projectIds.includes(project.id)).map(project => project.name + (project.archivedAt ? ' (archived)' : '')).join(', ') || 'No assigned projects'}</div></div></div>
          <div className="row-actions"><span className="status neutral">{member.role}</span>{tenant.organizationRole === 'owner' || !['owner', 'admin'].includes(member.role) ? <DialogTrigger label="Edit access" title={`Access for ${member.displayName}`} className="button secondary small"><div className="stack">
            <WorkspaceForm action={saveMemberAction} label="Save access"><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><input type="hidden" name="userId" value={member.userId} /><MemberAccessFields roles={roles} projects={activeProjects} initialRole={member.role} initialProjectIds={member.projectIds} seatAvailable={seatAvailable || member.role !== 'viewer'} requiredSeats={usage.editingMembers + 1} /></WorkspaceForm>
            {member.userId !== tenant.userId ? <WorkspaceForm action={removeMemberAction} label="Remove from organization" danger confirmation={{ title: 'Remove ' + member.displayName + '?', description: 'They will lose access to every project in this organization. Their connected agents will also lose access.', confirmLabel: 'Remove member' }}><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><input type="hidden" name="userId" value={member.userId} /></WorkspaceForm> : null}
          </div></DialogTrigger> : null}</div>
        </div>)}
      </div></section>
    </div>
  </main>;
}
