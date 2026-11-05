import Link from 'next/link';
import { Empty, PageHeader, Provider, StatusPill } from '@/components/ui';
import { providerLabel } from '@/components/logos';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listConnections, listPendingOperations, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { PendingAccountSelections } from '@/components/pending-account-selections';
import { LiveData } from './live-data';
import { isSyntheticReviewer } from '@/lib/cloud/synthetic-reviewer';
import { SyntheticReviewer } from '@/components/synthetic-reviewer';
import { getOnboardingState } from '@/lib/cloud/onboarding';
import { SetupChecklist } from '@/components/setup-checklist';
import { ConnectAssistantButton } from '@/components/assistant-connect';
import { getAssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import { getAssistantListings } from '@/lib/cloud/assistant-listings';
import { env } from '@/lib/env';
import { overviewRangeFromParams, type OverviewRange } from '@/lib/overview-range';

export const metadata = { title: 'Overview' };

export default async function OverviewPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const tenant = await requireDashboardTenant();
  const query = await searchParams ?? {};
  let initialRange: OverviewRange = 'last_7_days';
  try { initialRange = overviewRangeFromParams(new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))); } catch { /* Invalid shared links use the default reporting period. */ }
  if (isSyntheticReviewer(tenant.organizationId)) return <SyntheticReviewer tenant={tenant} />;
  const [connections, pending, accounts, onboarding] = await Promise.all([
    listConnections(tenant.organizationId, tenant.userId),
    listPendingOperations(tenant.organizationId, 5),
    listOrganizationAdAccounts(tenant.organizationId),
    getOnboardingState(tenant.organizationId),
  ]);
  const connected = connections.filter((connection) => connection.status === 'connected');
  const broken = connections.filter((connection) => connection.status === 'error');
  const usableAccounts = accounts.filter(account => account.enabled && connected.some(connection => connection.provider === account.provider && !connection.accountSelectionId));
  const selectionPending = connected.some(connection => connection.accountSelectionId);
  const canManage = ['owner', 'admin'].includes(tenant.role);
  const assistantStatus = canManage && onboarding.currentStep !== 'complete'
    ? await getAssistantConnectionStatus({ ...tenant, scopes: [] }) : undefined;
  return (
    <main className="page">
      <PageHeader
        title="Overview"
        description="Your ad accounts, campaign activity, and next steps."
        action={<ConnectAssistantButton key={tenant.organizationId} baseUrl={env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '')} projectName={tenant.organizationName} initialAgent={onboarding.selectedAgent ?? undefined} listings={getAssistantListings()} canManage={canManage} />}
      />
      {assistantStatus ? <SetupChecklist key={`${tenant.userId}:${tenant.organizationId}`} userId={tenant.userId} projectId={tenant.organizationId} projectName={tenant.organizationName} connected={Boolean(connected.length)} accountsEnabled={Boolean(usableAccounts.length)} assistantVerified={assistantStatus.verified} /> : null}
      {connections.length === 0 ? (
        <div className="card">
          <Empty
            title="Connect your first platform"
            copy={canManage ? 'Bring your ad accounts into this project to see campaign performance and use them with your AI assistant.' : 'A project owner or admin needs to connect the first ad platform.'}
            href={canManage ? '/dashboard/connections' : undefined}
            action={canManage ? 'Connect a platform' : undefined}
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
          <PendingAccountSelections connections={connections} canManage={canManage} />
          {!usableAccounts.length && !selectionPending ? <section className="setup-next-step">
            <div><strong>{accounts.length ? 'Enable account access to get started' : 'Choose your ad accounts'}</strong><p>{canManage ? accounts.length ? 'Your platforms are connected. Choose which accounts Adport can use.' : 'The connection is ready. Add the accounts you want to use in this project.' : 'Ask a project owner or admin to make accounts available.'}</p></div>
            <Link className="button secondary small" href={accounts.length ? '/dashboard/accounts' : '/dashboard/connections'}>{accounts.length ? 'Open accounts' : 'Choose accounts'}</Link>
          </section> : null}
          {usableAccounts.length ? <LiveData key={tenant.organizationId} organizationId={tenant.organizationId} connected initialRange={initialRange} /> : null}
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
