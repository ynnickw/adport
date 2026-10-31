import { Checkbox, Input } from '@/components/controls';
import { DialogTrigger } from '@/components/dialog';
import { InfoTooltip } from '@/components/info-tooltip';
import { Select } from '@/components/select';
import { PageHeader } from '@/components/ui';
import { WorkspaceForm } from '@/components/workspace-form';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationProjects, listOrganizationTeam } from '@/lib/cloud/workspaces';
import { renameCompanyAction, saveMemberAction, removeMemberAction } from '../projects/actions';

export const metadata = { title: 'Organization' };

export default async function OrganizationPage() {
  const tenant = await requireDashboardTenant();
  const canManage = ['owner', 'admin'].includes(tenant.organizationRole);
  if (!canManage) return <main className="page"><PageHeader title="Organization" description="An owner or admin manages organization settings." /><p className="inline-note">Ask an organization owner or admin to change these settings.</p></main>;
  const [members, projects] = await Promise.all([listOrganizationTeam(tenant.userId, tenant.organizationGroupId), listOrganizationProjects(tenant.userId, tenant.organizationGroupId)]);
  const activeProjects = projects.filter(project => !project.archivedAt);
  const projectFields = (selected: string[]) => <fieldset className="project-access-fields"><legend>Project access <InfoTooltip>Owners and admins access every project. Members and viewers access only the projects selected here.</InfoTooltip></legend>
    {activeProjects.map(project => <label className="project-checkbox" key={project.id}><Checkbox name="projectIds" value={project.id} defaultChecked={selected.includes(project.id)} />{project.name}</label>)}
  </fieldset>;
  const roles = [{ value: 'member', label: 'Member (editing)' }, { value: 'viewer', label: 'Viewer (read-only)' }, ...(tenant.organizationRole === 'owner' ? [{ value: 'admin', label: 'Admin' }, { value: 'owner', label: 'Owner' }] : [])];
  return <main className="page">
    <PageHeader title="Organization" description="Organization owners, admins, and editing members use a plan seat. Read-only client viewers are free. Access to individual client projects is managed here."
      action={<DialogTrigger label="Invite member" title="Invite a colleague or client" className="button"><WorkspaceForm action={saveMemberAction} label="Invite member"><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><label>Email address<Input type="email" name="email" required maxLength={320} placeholder="name@company.com" /></label><label>Role<Select name="role" defaultValue="member" aria-label="Organization role" options={roles} /></label>{projectFields([])}</WorkspaceForm></DialogTrigger>} />
    <div className="stack">
      <section className="card"><div className="card-head"><h2>General</h2></div><div className="card-body">
        <WorkspaceForm action={renameCompanyAction}><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><label>Organization name<Input name="name" defaultValue={tenant.organizationGroupName} required maxLength={120} /></label></WorkspaceForm>
      </div></section>
      <section className="card"><div className="card-head"><h2>Members</h2><span className="card-note">{members.length} {members.length === 1 ? 'person' : 'people'}</span></div><div className="row-list">
        {members.map(member => <div className="row-item" key={member.userId}>
          <div className="identity"><span className="avatar" aria-hidden="true">{member.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{member.displayName}{member.userId === tenant.userId ? ' · you' : ''}</strong><div className="cell-sub">{member.email}</div></div></div>
          <div className="row-actions"><span className="status neutral">{member.role}</span>{tenant.organizationRole === 'owner' || !['owner', 'admin'].includes(member.role) ? <DialogTrigger label="Edit access" title={`Access for ${member.displayName}`} className="button secondary small"><div className="stack">
            <WorkspaceForm action={saveMemberAction} label="Save access"><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><input type="hidden" name="userId" value={member.userId} /><label>Role<Select name="role" defaultValue={member.role} aria-label="Organization role" options={roles} /></label>{projectFields(member.projectIds)}</WorkspaceForm>
            {member.userId !== tenant.userId ? <WorkspaceForm action={removeMemberAction} label="Remove from organization" danger><input type="hidden" name="organizationId" value={tenant.organizationGroupId} /><input type="hidden" name="userId" value={member.userId} /></WorkspaceForm> : null}
          </div></DialogTrigger> : null}</div>
        </div>)}
      </div></section>
    </div>
  </main>;
}
