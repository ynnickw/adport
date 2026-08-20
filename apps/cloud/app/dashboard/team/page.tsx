import { PageHeader } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationMembers } from '@/lib/cloud/tenant-admin';
import { DangerZone } from './danger-zone';
import { TeamMembers } from './team-members';

export const metadata = { title: 'Team' };

export default async function TeamPage() {
  const tenant = await requireDashboardTenant();
  const members = await listOrganizationMembers(tenant.organizationId);
  return (
    <main className="page">
      <PageHeader eyebrow="Organization" title="Team" description="Owners and admins manage connections, policy, keys, and members; members can read, preview, and apply; viewers read only." />
      <div className="stack" style={{ maxWidth: '46rem' }}>
        <section className="card">
          <div className="card-head"><h2>Members</h2><span className="card-note">{members.length} {members.length === 1 ? 'member' : 'members'}</span></div>
          <TeamMembers organizationId={tenant.organizationId} currentUserId={tenant.userId} currentRole={tenant.role} members={members} />
        </section>
        {tenant.role === 'owner' ? <DangerZone organizationId={tenant.organizationId} /> : null}
      </div>
    </main>
  );
}
