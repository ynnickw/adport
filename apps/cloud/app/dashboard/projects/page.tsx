import { PageHeader } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationProjects } from '@/lib/cloud/workspaces';
import { NewProjectButton } from '@/components/new-project-dialog';
import { ProjectManager } from '@/components/project-manager';
import { SuccessToast } from '@/components/toast';
import { DangerZone } from '../team/danger-zone';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ transferred?: string }> }) {
  const [tenant, params] = await Promise.all([requireDashboardTenant(), searchParams]);
  const canManage = ['owner', 'admin'].includes(tenant.organizationRole);
  const projects = canManage ? await listOrganizationProjects(tenant.userId, tenant.organizationGroupId)
    : tenant.projects.filter(project => project.organizationId === tenant.organizationGroupId);
  const defaultProjectId = tenant.projects.find(project => project.id === tenant.organizationId)!.defaultProjectId;
  const destinations = tenant.organizationRole === 'owner' ? [...new Map(tenant.projects
    .filter(project => project.organizationRole === 'owner' && project.organizationId !== tenant.organizationGroupId)
    .map(project => [project.organizationId, { id: project.organizationId, name: project.organizationName }])).values()]
    .sort((left, right) => left.name.localeCompare(right.name)) : undefined;
  const transferred = projects.find(project => project.id === params.transferred);
  return <main className="page">
    <SuccessToast message={transferred ? `${transferred.name} moved to ${tenant.organizationGroupName}.` : undefined} />
    <PageHeader title="Projects"
      action={canManage ? <NewProjectButton organizationId={tenant.organizationGroupId} organizationName={tenant.organizationGroupName} /> : undefined} />
    <ProjectManager key={tenant.organizationGroupId} projects={projects} currentProjectId={tenant.organizationId} defaultProjectId={defaultProjectId} organizationName={tenant.organizationGroupName} canManage={canManage}
      initialStatus={transferred?.archivedAt ? 'archived' : 'active'}
      transfer={destinations ? { sourceId: tenant.organizationGroupId, destinations } : undefined}
      dangerZone={tenant.role === 'owner' ? <DangerZone organizationId={tenant.organizationId} isDefaultProject={tenant.organizationId === defaultProjectId} /> : undefined} />
  </main>;
}
