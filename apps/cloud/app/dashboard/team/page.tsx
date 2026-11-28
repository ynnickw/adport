import { PageHeader } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationMembers } from '@/lib/cloud/tenant-admin';
import { TeamMembers } from './team-members';
import { DashboardLink as Link } from '@/components/dashboard-navigation';

export const metadata = { title: 'Team' };

export default async function TeamPage() {
  const tenant = await requireDashboardTenant();
  const members = await listOrganizationMembers(tenant.organizationId);
  return (
    <main className="page">
      <PageHeader title="Project team"
        action={['owner', 'admin'].includes(tenant.organizationRole) ? <Link className="button secondary" href="/dashboard/organization">Organization access</Link> : undefined} />
      <TeamMembers key={tenant.organizationId} organizationId={tenant.organizationId} currentUserId={tenant.userId} currentRole={tenant.role} members={members} />
    </main>
  );
}
