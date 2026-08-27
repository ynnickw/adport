import Link from 'next/link';
import { Empty, PageHeader, Provider } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { readAccounts } from '@/lib/cloud/reads';
import { AccountAccessManager } from './account-access-manager';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage() {
  const tenant = await requireDashboardTenant();
  const [result, connections, inventory, entitlement] = await Promise.all([
    readAccounts({ organizationId: tenant.organizationId, userId: tenant.userId, role: tenant.role, scopes: ['tools:read'] }),
    listConnections(tenant.organizationId),
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
  ]);
  const accounts = result.ok ? result.data : [];
  const accountProviders = new Set(inventory.map((account) => account.provider));
  const emptyConnections = connections.filter((connection) => connection.status === 'connected' && !accountProviders.has(connection.provider));
  return (
    <main className="page">
      <PageHeader title="Accounts" description="Choose exactly which discovered ad accounts agents may query or change. Disabled accounts remain outside the tenant runtime." />
      {!result.ok ? <div className="error-callout">Provider read failed: {result.error}</div> : null}
      {result.warnings.map((warning) => <div className="error-callout" key={`${warning.provider}:${warning.message}`}>Partial provider read: {warning.message}</div>)}
      {inventory.length === 0 ? <section className="card">
        {accounts.length === 0 ? (
          <Empty
            title={result.connected ? 'No accessible accounts' : 'No accounts yet'}
            copy={result.connected ? 'Reconnect the provider to discover and activate its accessible accounts under the current Cloud plan.' : 'Connect a platform to discover the ad accounts its grant can access.'}
            href="/dashboard/connections"
            action="Open connections"
          />
        ) : null}
      </section> : (
        <AccountAccessManager
          organizationId={tenant.organizationId}
          accounts={inventory}
          canManage={['owner', 'admin'].includes(tenant.role)}
          maxActiveAccounts={entitlement.plan.maxActiveAccounts}
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
