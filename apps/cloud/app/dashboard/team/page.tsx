import { PageHeader } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationMembers } from '@/lib/cloud/tenant-admin';
import { TeamMembers } from './team-members';
import Link from 'next/link';

export const metadata = { title: 'Team' };

export default async function TeamPage() {
  const tenant = await requireDashboardTenant();
  const members = await listOrganizationMembers(tenant.organizationId);
  return (
    <main className="page">
      <PageHeader title="Project team"
        action={['owner', 'admin'].includes(tenant.organizationRole) ? <Link className="button secondary" href="/dashboard/organization">Organization access</Link> : undefined} />
      <div className="stack">
        <section className="card">
          <div className="card-head"><h2>People with access</h2><span className="card-note">{members.length} {members.length === 1 ? 'person' : 'people'}</span></div>
          <TeamMembers organizationId={tenant.organizationId} currentUserId={tenant.userId} currentRole={tenant.role} members={members} />
        </section>
      </div>
    </main>
  );
}
