import { PageHeader } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listOrganizationMembers } from '@/lib/cloud/tenant-admin';
import { DangerZone } from './danger-zone';
import { Disclosure } from '@/components/controls';
import { TeamMembers } from './team-members';
import Link from 'next/link';

export const metadata = { title: 'Team' };

export default async function TeamPage() {
  const tenant = await requireDashboardTenant();
  const members = await listOrganizationMembers(tenant.organizationId);
  return (
    <main className="page">
      <PageHeader title="Project team" description="Manage access to this project. Organization owners and admins inherit access; members can read and operate, and read-only client viewers are free."
        action={['owner', 'admin'].includes(tenant.organizationRole) ? <Link className="button secondary" href="/dashboard/organization">Organization access</Link> : undefined} />
      <div className="stack">
        <section className="card">
          <div className="card-head"><h2>Members</h2><span className="card-note">{members.length} {members.length === 1 ? 'member' : 'members'}</span></div>
          <TeamMembers organizationId={tenant.organizationId} currentUserId={tenant.userId} currentRole={tenant.role} members={members} />
        </section>
        {tenant.role === 'owner' ? <Disclosure label="Danger zone"><DangerZone organizationId={tenant.organizationId} isDefaultProject={tenant.organizationId === tenant.projects.find(project => project.id === tenant.organizationId)!.defaultProjectId} /></Disclosure> : null}
      </div>
    </main>
  );
}
