import { PageHeader } from '@/components/ui';
import { WorkspaceForm } from '@/components/workspace-form';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationProjects, listOrganizationTeam } from '@/lib/cloud/workspaces';
import { renameCompanyAction, saveMemberAction, removeMemberAction } from '../projects/actions';

export const metadata = { title: 'Organization' };

export default async function OrganizationPage() {
  const tenant = await requireDashboardTenant();
  const canManage = ['owner', 'admin'].includes(tenant.organizationRole);
  if (!canManage) return <main className="page"><PageHeader title={tenant.organizationGroupName} description="Ask an organization owner or admin to manage the team. Your project access is shown in the project selector." /></main>;
  const [members, projects] = await Promise.all([
    listOrganizationTeam(tenant.userId, tenant.organizationGroupId),
    listOrganizationProjects(tenant.userId, tenant.organizationGroupId),
  ]);
  const activeProjects = projects.filter(project => !project.archivedAt);
  const projectFields = (selected: string[]) => <fieldset className="project-access-fields"><legend>Project access for members and viewers</legend>
    <p className="cell-sub">Owners and admins can access every project. Other members can only access selected projects.</p>
    {activeProjects.map(project => <label className="project-checkbox" key={project.id}><input type="checkbox" name="projectIds" value={project.id} defaultChecked={selected.includes(project.id)} />{project.name}</label>)}
  </fieldset>;
  const roles = <><option value="member">Member</option><option value="viewer">Viewer</option>{tenant.organizationRole === 'owner' ? <><option value="admin">Admin</option><option value="owner">Owner</option></> : null}</>;
  return <main className="page">
    <PageHeader title="Organization" description="Manage your agency or company, shared billing, and access to client projects." />
    <div className="stack" style={{ maxWidth: '52rem' }}>
      <section className="card"><div className="card-head"><h2>Organization details</h2></div><div className="card-body">
        <WorkspaceForm action={renameCompanyAction}><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><label>Organization name<input name="name" defaultValue={tenant.organizationGroupName} required maxLength={120} /></label></WorkspaceForm>
      </div></section>
      {members.map(member => <section className="card" key={member.userId}>
        <div className="card-head"><h2>{member.displayName}</h2><span className="card-note">{member.role}{member.userId === tenant.userId ? ' · you' : ''}</span></div>
        <div className="card-body stack"><p>{member.email}</p>
          {tenant.organizationRole === 'owner' || !['owner', 'admin'].includes(member.role) ? <>
            <WorkspaceForm action={saveMemberAction} label="Save access"><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><input type="hidden" name="userId" value={member.userId} /><label>Organization role<select name="role" defaultValue={member.role}>{roles}</select></label>{projectFields(member.projectIds)}</WorkspaceForm>
            {member.userId !== tenant.userId ? <WorkspaceForm action={removeMemberAction} label="Remove from organization" danger><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><input type="hidden" name="userId" value={member.userId} /></WorkspaceForm> : null}
          </> : null}
        </div>
      </section>)}
      <section className="card"><div className="card-head"><h2>Invite a colleague or client</h2></div><div className="card-body">
        <WorkspaceForm action={saveMemberAction} label="Invite member"><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><label>Email address<input type="email" name="email" required maxLength={320} /></label><label>Organization role<select name="role" defaultValue="member">{roles}</select></label>{projectFields([])}</WorkspaceForm>
      </div></section>
    </div>
  </main>;
}
