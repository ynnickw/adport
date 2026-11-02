import { PageHeader } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationProjects } from '@/lib/cloud/workspaces';
import { NewProjectButton } from '@/components/new-project-dialog';
import { ProjectManager } from '@/components/project-manager';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage() {
  const tenant = await requireDashboardTenant();
  const canManage = ['owner', 'admin'].includes(tenant.organizationRole);
  const projects = canManage ? await listOrganizationProjects(tenant.userId, tenant.organizationGroupId)
    : tenant.projects.filter(project => project.organizationId === tenant.organizationGroupId);
  const defaultProjectId = tenant.projects.find(project => project.id === tenant.organizationId)!.defaultProjectId;
  return <main className="page">
    <p className="workspace-context-label">{tenant.organizationGroupName}</p>
    <PageHeader title="Projects" description={`Your workspaces in ${tenant.organizationGroupName}. Keep ad accounts, connections, and history separate for each brand, department, or client.`}
      action={canManage ? <NewProjectButton organizationId={tenant.organizationGroupId} organizationName={tenant.organizationGroupName} /> : undefined} />
    <p className="project-plan-note">Projects are unlimited. Your organization shares one plan and account allowance.</p>
    <ProjectManager key={tenant.organizationGroupId} projects={projects} currentProjectId={tenant.organizationId} defaultProjectId={defaultProjectId} organizationName={tenant.organizationGroupName} canManage={canManage} />
  </main>;
}
