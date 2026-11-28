import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationMembers } from '@/lib/cloud/tenant-admin';
import { TeamMembers } from './team-members';
import { DashboardLink as Link } from '@/components/dashboard-navigation';
import { PendingMemberInvitations } from '@/components/pending-member-invitations';
import { listPendingInvitations } from '@/lib/cloud/member-invitations';

export const metadata = { title: 'Team' };

export default async function TeamPage() {
  const tenant = await requireDashboardTenant();
  const [members, invitations] = await Promise.all([
    listOrganizationMembers(tenant.organizationId),
    canAdminister(tenant) ? listPendingInvitations(tenant.userId, { scope: 'project', targetId: tenant.organizationId }) : [],
  ]);
  return (
    <main className="page settings-page">
      <PageHeader title="Project team"
        action={['owner', 'admin'].includes(tenant.organizationRole) ? <Link className="button secondary" href="/dashboard/organization">Organization access</Link> : undefined} />
      <TeamMembers key={tenant.organizationId} organizationId={tenant.organizationId} currentUserId={tenant.userId} currentRole={tenant.role} members={members} />
      <PendingMemberInvitations invitations={invitations} />
    </main>
  );
}
