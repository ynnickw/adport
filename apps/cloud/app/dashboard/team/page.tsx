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
      <PageHeader eyebrow="Organization" title="Team" description="Who can see this organization and who can connect platforms, change policy, and manage agent access." />
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h2>Members</h2><span className="card-note">{members.length} {members.length === 1 ? 'member' : 'members'}</span></div>
          <TeamMembers organizationId={tenant.organizationId} currentUserId={tenant.userId} currentRole={tenant.role} members={members} />
        </section>
        <aside className="stack">
          <section className="card">
            <div className="card-head"><h2>Roles</h2></div>
            <div className="card-body policy-list">
              <div className="policy-row"><span className="policy-key">Owner</span><span className="policy-value">everything · delete org</span></div>
              <div className="policy-row"><span className="policy-key">Admin</span><span className="policy-value">connections · policy · keys · members</span></div>
              <div className="policy-row"><span className="policy-key">Member</span><span className="policy-value">read · preview · apply</span></div>
              <div className="policy-row"><span className="policy-key">Viewer</span><span className="policy-value">read only</span></div>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Signed in as</h2></div>
            <div className="card-body">
              <strong style={{ display: 'block', fontSize: '0.84rem', letterSpacing: '-0.015em' }}>{tenant.userName}</strong>
              <div className="cell-sub">{tenant.email} · {tenant.role}</div>
            </div>
          </section>
        </aside>
      </div>
      {tenant.role === 'owner' ? <div style={{ marginTop: '0.9rem' }}><DangerZone organizationId={tenant.organizationId} /></div> : null}
    </main>
  );
}
