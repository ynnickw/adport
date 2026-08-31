import Link from 'next/link';
import { Empty, PageHeader, Provider } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { providerLabel } from '@/lib/cloud/providers';
import { isOAuthProvider } from '@/lib/cloud/types';
import { AccountAccessManager } from './account-access-manager';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ connected?: string; accounts_saved?: string; error?: string; select_provider?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [connections, inventory, entitlement, params] = await Promise.all([
    listConnections(tenant.organizationId),
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    searchParams,
  ]);
  const requestedProvider = params.select_provider ?? params.connected;
  const providerFilter = requestedProvider && isOAuthProvider(requestedProvider) ? requestedProvider : undefined;
  const pendingConnections = connections.filter(connection => connection.accountSelectionId && connection.status === 'connected' && (!providerFilter || connection.provider === providerFilter));
  return (
    <main className="page">
      <PageHeader title={providerFilter ? `${providerLabel(providerFilter)} accounts` : 'Accounts'} description="Only accounts you added appear here. Enable agent access when ready. To add other accounts, re-authorize their provider in Connections." />
      {providerFilter ? <Link className="button secondary small" href="/dashboard/accounts" style={{ marginBottom: '1rem' }}>View all providers’ accounts</Link> : null}
      {params.connected ? <div className="callout success" style={{ marginBottom: '1rem' }}>{providerLabel(params.connected)} is connected. Select the specific accounts agents may access below.</div> : null}
      {params.accounts_saved ? <div className="callout success" role="status" style={{ marginBottom: '1rem' }}>Account selection saved. Unselected accounts are no longer listed or available to Adport. Enable newly added accounts below when ready.</div> : null}
      {params.error ? <div className="error-callout" role="alert">{params.error}</div> : null}
      {inventory.length === 0 && !providerFilter ? <section className="card">
        <Empty
          title="No accounts added yet"
          copy="Connect or re-authorize a provider, then save the accounts you want to add."
          href="/dashboard/connections"
          action="Open connections"
        />
      </section> : (
        <AccountAccessManager
          organizationId={tenant.organizationId}
          accounts={inventory}
          canManage={['owner', 'admin'].includes(tenant.role)}
          maxActiveAccounts={entitlement.plan.maxActiveAccounts}
          providerFilter={providerFilter}
        />
      )}
      {pendingConnections.length > 0 ? (
        <section className="card" style={{ marginTop: '0.9rem' }}>
          <div className="card-head"><h2>Finish account selection</h2><span className="card-note">agent access paused</span></div>
          <div className="row-list">
            {pendingConnections.map((connection) => (
              <div className="row-item" key={connection.provider}>
                <div>
                  <Provider name={connection.provider} />
                  <div className="cell-sub">Save your account selection to finish this authorization.</div>
                </div>
                <Link className="button secondary small" href={`/account-selection?selection_id=${connection.accountSelectionId}`}>Choose accounts</Link>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
