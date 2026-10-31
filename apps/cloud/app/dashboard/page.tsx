import Link from 'next/link';
import { Empty, PageHeader, Provider, StatusPill } from '@/components/ui';
import { providerLabel } from '@/components/logos';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listConnections, listPendingOperations } from '@/lib/cloud/repository';
import { LiveData } from './live-data';
import { isSyntheticReviewer } from '@/lib/cloud/synthetic-reviewer';
import { SyntheticReviewer } from '@/components/synthetic-reviewer';

export const metadata = { title: 'Overview' };

export default async function OverviewPage() {
  const tenant = await requireDashboardTenant();
  if (isSyntheticReviewer(tenant.organizationId)) return <SyntheticReviewer tenant={tenant} />;
  const [connections, pending] = await Promise.all([
    listConnections(tenant.organizationId),
    listPendingOperations(tenant.organizationId, 5),
  ]);
  const connected = connections.filter((connection) => connection.status === 'connected');
  const broken = connections.filter((connection) => connection.status === 'error');
  return (
    <main className="page">
      <PageHeader
        title="Overview"
        description="Performance and activity across this project's ad accounts. Open Reports for the full campaign view."
        action={connections.length ? <Link className="button secondary" href="/dashboard/reports" prefetch={false}>View report</Link> : undefined}
      />
      {connections.length === 0 ? (
        <div className="card">
          <Empty
            title="Connect your first platform"
            copy="Bring your ad accounts into this project to see campaign performance and use them with your AI assistant."
            href="/dashboard/connections"
            action="Connect a platform"
          />
        </div>
      ) : (
        <>
          {pending.length || broken.length ? (
            <section className="attention" aria-label="Needs your attention">
              {pending.length ? (
                <div className="attention-item">
                  <span className="attention-dot" aria-hidden="true" />
                  <p><strong>{pending.length === 5 ? '5 or more changes' : `${pending.length} ${pending.length === 1 ? 'change' : 'changes'}`} waiting for approval.</strong></p>
                  <Link className="button small" href="/dashboard/approvals" prefetch={false}>Review approvals</Link>
                </div>
              ) : null}
              {broken.map((connection) => (
                <div className="attention-item critical" key={connection.provider}>
                  <span className="attention-dot" aria-hidden="true" />
                  <p><strong>{providerLabel(connection.provider)} needs reconnecting.</strong> {connection.lastError ?? 'Verification failed.'}</p>
                  <Link className="button small secondary" href="/dashboard/connections" prefetch={false}>Open connections</Link>
                </div>
              ))}
            </section>
          ) : null}
          <LiveData key={tenant.organizationId} organizationId={tenant.organizationId} connected={connected.length > 0} />
            <section className="card" style={{ marginTop: '1rem' }}>
              <div className="card-head"><h2>Platforms</h2><Link className="card-note" href="/dashboard/connections" prefetch={false}>Manage</Link></div>
              <div className="card-body stack">
                {connections.map((connection) => (
                  <div key={connection.provider} className="connection-top">
                    <Provider name={connection.provider} />
                    <StatusPill status={connection.status} />
                  </div>
                ))}
              </div>
            </section>
        </>
      )}
    </main>
  );
}
