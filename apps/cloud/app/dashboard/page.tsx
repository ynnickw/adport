import Link from 'next/link';
import { Empty, PageHeader, Provider, StatusPill } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { countAuditEvents, listConnections, listPendingOperations } from '@/lib/cloud/repository';
import { LiveData } from './live-data';

export const metadata = { title: 'Overview' };

export default async function OverviewPage() {
  const tenant = await requireDashboardTenant();
  const [connections, pending, auditCount] = await Promise.all([
    listConnections(tenant.organizationId),
    listPendingOperations(tenant.organizationId, 5),
    countAuditEvents(tenant.organizationId),
  ]);
  const connected = connections.filter((connection) => connection.status === 'connected');
  return (
    <main className="page">
      <PageHeader
        eyebrow="Workspace pulse"
        title="Overview"
        description="A normalized read across the ad accounts this organization has connected."
        action={<Link className="button secondary" href="/dashboard/reports">Open full report</Link>}
      />
      {connections.length === 0 ? (
        <div className="card">
          <Empty
            title="Connect the first ad platform"
            copy="Authorize Google, Meta, TikTok, Microsoft, or Reddit through their official consent screens. Adport never asks for platform passwords or application secrets."
            href="/dashboard/connections"
            action="Open connections"
          />
        </div>
      ) : (
        <>
          <LiveData organizationId={tenant.organizationId} connected={connected.length > 0} />
          <div className="grid-2" style={{ marginTop: '0.9rem' }}>
            <section className="card">
              <div className="card-head"><h2>Connections</h2><Link className="card-note" href="/dashboard/connections">Manage</Link></div>
              <div className="card-body stack">
                {connections.map((connection) => (
                  <div key={connection.provider} className="connection-top">
                    <Provider name={connection.provider} />
                    <StatusPill status={connection.status} />
                  </div>
                ))}
              </div>
            </section>
            <section className="card">
              <div className="card-head"><h2>Governance</h2></div>
              <div className="card-body">
                <dl className="connection-meta" style={{ margin: 0 }}>
                  <div><dt>Awaiting approval</dt><dd><Link href="/dashboard/approvals">{pending.length}{pending.length === 5 ? '+' : ''} operation{pending.length === 1 ? '' : 's'}</Link></dd></div>
                  <div><dt>Audit events</dt><dd><Link href="/dashboard/audit">{auditCount}</Link></dd></div>
                </dl>
              </div>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
