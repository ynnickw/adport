import { Button, Input } from '@/components/controls';
import { DialogTrigger } from '@/components/dialog';
import { PageHeader } from '@/components/ui';
import { WorkspaceForm } from '@/components/workspace-form';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationProjects } from '@/lib/cloud/workspaces';
import { selectProjectAction, createOrganizationAction, updateProjectAction } from './actions';
import { NewProjectButton } from '@/components/new-project-dialog';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage() {
  const tenant = await requireDashboardTenant();
  const canManage = ['owner', 'admin'].includes(tenant.organizationRole);
  const projects = canManage ? await listOrganizationProjects(tenant.userId, tenant.organizationGroupId)
    : tenant.projects.filter(project => project.organizationId === tenant.organizationGroupId);
  const defaultProjectId = tenant.projects.find(project => project.id === tenant.organizationId)!.defaultProjectId;
  return <main className="page">
    <PageHeader title="Projects" description={`Clients and brands in ${tenant.organizationGroupName}. Each project keeps its accounts, connections, approvals, and history separate. The organization shares one plan.`}
      action={canManage ? <NewProjectButton organizationId={tenant.organizationGroupId} organizationName={tenant.organizationGroupName} /> : undefined} />
    <section className="card"><div className="card-head"><h2>{tenant.organizationGroupName}</h2><span className="card-note">{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span></div>
      <div className="row-list">{projects.map(project => <div className="row-item project-row" key={project.id}>
        <div className="identity"><span className="project-monogram" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span><div><strong>{project.name}</strong><div className="cell-sub">{project.archivedAt ? 'Archived' : project.id === defaultProjectId ? 'Default project' : 'Client project'}{'enabledAccounts' in project ? ' · ' + project.enabledAccounts + ' enabled accounts' : ''}</div></div></div>
        <div className="row-actions">
          {project.id === tenant.organizationId ? <span className="status neutral">Current</span> : !project.archivedAt ? <form action={selectProjectAction}><input type="hidden" name="projectId" value={project.id} /><Button className="button secondary small" type="submit">Open</Button></form> : null}
          {canManage ? <DialogTrigger label="Edit" title={`Edit ${project.name}`} className="button secondary small"><div className="stack">
            <WorkspaceForm action={updateProjectAction} label="Save name"><input type="hidden" name="projectId" value={project.id} /><label>Project name<Input name="name" defaultValue={project.name} required maxLength={120} /></label></WorkspaceForm>
            {project.id !== defaultProjectId ? <WorkspaceForm action={updateProjectAction} label={project.archivedAt ? 'Restore project' : 'Archive project'} danger={!project.archivedAt} confirmation={!project.archivedAt ? { title: 'Archive ' + project.name + '?', description: 'Adport will disable this project’s account access. Connected assistants cannot use it while archived. Campaigns keep running. You can restore the project later, then enable the accounts you need.', confirmLabel: 'Archive project' } : undefined}><input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="archived" value={String(!project.archivedAt)} /></WorkspaceForm> : null}
          </div></DialogTrigger> : null}
        </div>
      </div>)}</div>
    </section>
    <div className="settings-footer"><DialogTrigger label="Create another organization" title="Create an organization" className="link-button"><p>A separate business with its own team, projects, and subscription.</p><WorkspaceForm action={createOrganizationAction} label="Create organization"><label>Organization name<Input name="name" required maxLength={120} placeholder="Agency or company" /></label></WorkspaceForm></DialogTrigger></div>
  </main>;
}
