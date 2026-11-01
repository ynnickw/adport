import Link from 'next/link';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { Empty, PageHeader } from '@/components/ui';
import { PendingAccountSelections } from '@/components/pending-account-selections';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { providerLabel } from '@/lib/cloud/providers';
import { isOAuthProvider } from '@/lib/cloud/types';
import { AccountAccessManager } from './account-access-manager';
import { isSyntheticReviewer } from '@/lib/cloud/synthetic-reviewer';
import { SyntheticReviewer } from '@/components/synthetic-reviewer';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ connected?: string; accounts_saved?: string; error?: string; select_provider?: string }> }) {
  const tenant = await requireDashboardTenant();
  if (isSyntheticReviewer(tenant.organizationId)) return <SyntheticReviewer tenant={tenant} />;
  const [connections, inventory, entitlement, params, usage] = await Promise.all([
    listConnections(tenant.organizationId, tenant.userId),
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    searchParams,
    getOrganizationUsage(tenant.organizationId),
  ]);
  const requestedProvider = params.select_provider ?? params.connected;
  const providerFilter = requestedProvider && isOAuthProvider(requestedProvider) ? requestedProvider : undefined;
  const pendingConnections = connections.filter(connection => connection.accountSelectionId && connection.status === 'connected' && (!providerFilter || connection.provider === providerFilter));
  const canManage = ['owner', 'admin'].includes(tenant.role);
  return (
    <main className="page">
      <PageHeader title={providerFilter ? `${providerLabel(providerFilter)} accounts` : 'Accounts'} description="Choose which accounts Adport and your connected assistants can use. This does not change campaign status at the advertising platform." action={['owner', 'admin'].includes(tenant.role) ? <Link className="button" href={providerFilter ? '/dashboard/connections#platform-' + providerFilter : '/dashboard/connections'}>Add or change accounts</Link> : undefined} />
      {providerFilter ? <Link className="button secondary small" href="/dashboard/accounts" style={{ marginBottom: '1rem' }}>View all providers’ accounts</Link> : null}
      {params.connected ? <div className="callout success" role="status" style={{ marginBottom: '1rem' }}>{providerLabel(params.connected)} is connected. Select the specific accounts agents may access below.</div> : null}
      {params.accounts_saved ? <div className="callout success" role="status" style={{ marginBottom: '1rem' }}>Account selection saved. Unselected accounts are no longer listed or available to Adport. Enable newly added accounts below when ready.</div> : null}
      {params.error ? <div className="error-callout" role="alert">{params.error}</div> : null}
      <PendingAccountSelections connections={pendingConnections} canManage={['owner', 'admin'].includes(tenant.role)} />
      {inventory.length === 0 && pendingConnections.length ? null : inventory.length === 0 && !providerFilter ? <section className="card">
        <Empty
          title="No accounts added yet"
          copy={canManage ? 'Connect a platform, choose the accounts for this project, then enable Adport access.' : 'Ask a project owner or admin to add accounts.'}
          href={canManage ? '/dashboard/connections' : undefined}
          action={canManage ? 'Connect a platform' : undefined}
        />
      </section> : (
        <AccountAccessManager key={tenant.organizationId}
          organizationId={tenant.organizationId}
          accounts={inventory.map(account => ({ ...account, connectionStatus: connections.find(connection => connection.provider === account.provider)?.status ?? 'revoked', accountSelectionId: connections.find(connection => connection.provider === account.provider)?.accountSelectionId, accountSelectionUnavailable: connections.find(connection => connection.provider === account.provider)?.accountSelectionUnavailable }))}
          canManage={['owner', 'admin'].includes(tenant.role)}
          maxActiveAccounts={entitlement.plan.maxActiveAccounts}
          organizationActiveCount={usage.enabledAccounts}
          providerFilter={providerFilter}
        />
      )}
    </main>
  );
}
