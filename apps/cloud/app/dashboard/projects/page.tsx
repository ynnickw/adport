import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { WorkspaceForm } from '@/components/workspace-form';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationProjects } from '@/lib/cloud/workspaces';
import { selectProjectAction, createOrganizationAction, createProjectAction, updateProjectAction } from './actions';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage() {
  const tenant = await requireDashboardTenant();
  const canManage = ['owner', 'admin'].includes(tenant.organizationRole);
  const projects = canManage
    ? await listOrganizationProjects(tenant.userId, tenant.organizationGroupId)
    : tenant.projects.filter(project => project.organizationId === tenant.organizationGroupId);
  const defaultProjectId = tenant.projects.find(project => project.id === tenant.organizationId)!.defaultProjectId;
  return <main className="page">
    <PageHeader title="Projects" description={`Manage brands and clients in ${tenant.organizationGroupName}. Each project has its own connections, accounts, policies, approvals, and audit history.`} />
    <div className="stack" style={{ maxWidth: '52rem' }}>
      <p>Projects share your organization’s plan and member allowance. <Link href="/dashboard/organization">Organization and team settings</Link></p>
      {projects.map(project => <section className="card" key={project.id}>
        <div className="card-head"><h2>{project.name}</h2><span className="card-note">{project.archivedAt ? 'Archived' : project.id === tenant.organizationId ? 'Current project' : 'Active'}</span></div>
        <div className="card-body stack">
          {!project.archivedAt ? <form action={selectProjectAction}><input type="hidden" name="projectId" value={project.id} /><button className="button secondary small">Open project</button></form> : null}
          {canManage ? <WorkspaceForm action={updateProjectAction} label="Rename project">
            <input type="hidden" name="projectId" value={project.id} />
            <label>Project name<input name="name" defaultValue={project.name} required maxLength={120} /></label>
          </WorkspaceForm> : null}
          {canManage && project.id !== defaultProjectId ? <WorkspaceForm action={updateProjectAction} label={project.archivedAt ? 'Restore project' : 'Archive project'}>
            <input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="archived" value={String(!project.archivedAt)} />
          </WorkspaceForm> : null}
        </div>
      </section>)}
      {canManage ? <section className="card"><div className="card-head"><h2>Create a project</h2></div><div className="card-body">
        <WorkspaceForm action={createProjectAction} label="Create project">
          <input type="hidden" name="organizationId" value={tenant.organizationGroupId} />
          <label>Client or brand name<input name="name" required maxLength={120} placeholder="Client or brand" /></label>
        </WorkspaceForm>
      </div></section> : null}
      <section className="card"><div className="card-head"><h2>Create an organization</h2></div><div className="card-body">
        <p>A separate business with its own team, projects, and subscription.</p>
        <WorkspaceForm action={createOrganizationAction} label="Create organization"><label>Organization name<input name="name" required maxLength={120} placeholder="Your agency or company" /></label></WorkspaceForm>
      </div></section>
    </div>
  </main>;
}
