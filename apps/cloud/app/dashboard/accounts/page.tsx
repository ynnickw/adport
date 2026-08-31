import Link from 'next/link';
import { Empty, PageHeader, Provider } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { providerLabel } from '@/lib/cloud/providers';
import { isOAuthProvider } from '@/lib/cloud/types';
import { AccountAccessManager } from './account-access-manager';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string; select_provider?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [connections, inventory, entitlement, params] = await Promise.all([
    listConnections(tenant.organizationId),
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    searchParams,
  ]);
  const requestedProvider = params.select_provider ?? params.connected;
  const providerFilter = requestedProvider && isOAuthProvider(requestedProvider) ? requestedProvider : undefined;
  const accountProviders = new Set(inventory.map((account) => account.provider));
  const emptyConnections = connections.filter((connection) => connection.status === 'connected' && !accountProviders.has(connection.provider) && (!providerFilter || connection.provider === providerFilter));
  return (
    <main className="page">
      <PageHeader title={providerFilter ? `Choose ${providerLabel(providerFilter)} accounts` : 'Accounts'} description="Choose exactly which discovered ad accounts agents may query or change. Disabled accounts remain outside the tenant runtime." />
      {providerFilter ? <Link className="button secondary small" href="/dashboard/accounts" style={{ marginBottom: '1rem' }}>View all providers’ accounts</Link> : null}
      {params.connected ? <div className="callout success" style={{ marginBottom: '1rem' }}>{providerLabel(params.connected)} is connected. Select the specific accounts agents may access below.</div> : null}
      {params.error ? <div className="error-callout" role="alert">{params.error}</div> : null}
      {inventory.length === 0 && !providerFilter ? <section className="card">
        <Empty
          title={connections.length > 0 ? 'No accessible accounts' : 'No accounts yet'}
          copy={connections.length > 0 ? 'Reconnect the provider to refresh the ad accounts available under the current Cloud plan.' : 'Connect a platform to discover the ad accounts its grant can access.'}
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
      {emptyConnections.length > 0 ? (
        <section className="card" style={{ marginTop: '0.9rem' }}>
          <div className="card-head"><h2>Connected without account access</h2><span className="card-note">authorization needs attention</span></div>
          <div className="row-list">
            {emptyConnections.map((connection) => (
              <div className="row-item" key={connection.provider}>
                <div>
                  <Provider name={connection.provider} />
                  <div className="cell-sub">{connection.externalLabel ?? 'OAuth connected'} · no advertiser account was returned. Re-authorize and explicitly select an ad account.</div>
                </div>
                <Link className="button secondary small" href="/dashboard/connections">Review connection</Link>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
