import Link from 'next/link';
import { z } from 'zod';
import { getAccountSelection } from '@/lib/cloud/account-selection';
import { ProviderAccountPicker, AccountConnectionProgress } from '@/app/account-selection/provider-account-picker';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { Empty, PageHeader } from '@/components/ui';
import { PendingAccountSelections } from '@/components/pending-account-selections';
import { SupportLauncher } from '@/components/support-widget';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { providerLabel } from '@/lib/cloud/providers';
import { isOAuthProvider } from '@/lib/cloud/types';
import { AccountAccessManager } from './account-access-manager';
import { isSyntheticReviewer } from '@/lib/cloud/synthetic-reviewer';
import { SyntheticReviewer } from '@/components/synthetic-reviewer';
import { CatalogAccessManager } from './catalog-access-manager';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ connected?: string; accounts_saved?: string; access_enabled?: string; error?: string; select_provider?: string; selection_id?: string; selection_unavailable?: string }> }) {
  const tenant = await requireDashboardTenant();
  if (isSyntheticReviewer(tenant.organizationId)) return <SyntheticReviewer tenant={tenant} />;
  const [connections, inventory, entitlement, params, usage] = await Promise.all([
    listConnections(tenant.organizationId, tenant.userId),
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    searchParams,
    getOrganizationUsage(tenant.organizationId),
  ]);
  const requestedProvider = params.select_provider ?? params.accounts_saved ?? params.connected;
  const providerFilter = requestedProvider && isOAuthProvider(requestedProvider) ? requestedProvider : undefined;
  const pendingConnections = connections.filter(connection => connection.accountSelectionId && connection.status === 'connected' && (!providerFilter || connection.provider === providerFilter));
  const canManage = ['owner', 'admin'].includes(tenant.role);
  const selectionId = z.string().uuid().safeParse(params.selection_id);
  const selection = canManage && selectionId.success ? await getAccountSelection({ ...tenant, scopes: [] }, selectionId.data) : undefined;
  if (selection) return <main className="page">
    <div className="selection-back-row"><Link className="selection-back" href="/dashboard/accounts">← Accounts</Link><SupportLauncher className="support-inline" /></div>
    <PageHeader title={`Add ${providerLabel(selection.provider)} accounts`} showDescription description={`Choose the accounts to add to ${tenant.organizationName}. Add and enable them in one step, or import without enabling.`} />
    <ProviderAccountPicker organizationId={tenant.organizationId} selectionId={selection.id} provider={selection.provider}
      accounts={selection.accounts} pages={selection.pages} nextPath={'/dashboard/accounts?select_provider=' + selection.provider}
      initialSelectedIds={inventory.filter(account => account.provider === selection.provider).map(account => account.accountId)} initialEnabledIds={inventory.filter(account => account.provider === selection.provider && account.enabled).map(account => account.accountId)} maxActiveAccounts={entitlement.plan.maxActiveAccounts} organizationActiveCount={usage.enabledAccounts} />
  </main>;
  return (
    <main className="page">
      <PageHeader title={providerFilter ? `${providerLabel(providerFilter)} accounts` : 'Accounts'} description="Choose which accounts Adport and your connected assistants can use. This does not change campaign status at the advertising platform." action={['owner', 'admin'].includes(tenant.role) ? <Link className="button" href={providerFilter ? '/dashboard/connections#platform-' + providerFilter : '/dashboard/connections'}>Add or change accounts</Link> : undefined} />
      {providerFilter ? <Link className="button secondary small" href="/dashboard/accounts" style={{ marginBottom: '1rem' }}>View all providers’ accounts</Link> : null}
      {params.connected ? <div className="callout success" role="status" style={{ marginBottom: '1rem' }}>{providerLabel(params.connected)} is connected. Select the specific accounts agents may access below.</div> : null}
      {params.selection_id || params.selection_unavailable ? <div className="error-callout" role="alert">This account selection is no longer available. It may have expired, been saved, or belong to another admin. {canManage ? <Link href="/dashboard/connections">Reconnect the platform to choose accounts again.</Link> : 'Ask a project owner or admin to restart the connection.'}</div> : null}
      {params.accounts_saved ? <AccountConnectionProgress stage={params.access_enabled === '1' ? 'ready' : 'enable'} /> : null}
      {params.accounts_saved ? <div className="callout success" role="status" style={{ marginBottom: '1rem' }}>{params.access_enabled === '1' ? 'Accounts added and enabled for your assistant.' : 'Accounts imported. New accounts remain disabled until you enable access below.'}</div> : null}
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
      {(['tiktok', 'reddit'] as const).map(provider => canManage && (!providerFilter || providerFilter === provider) ? <CatalogAccessManager key={tenant.organizationId + ':' + provider} provider={provider} organizationId={tenant.organizationId} projectName={tenant.organizationName}
        accounts={inventory.filter(account => account.provider === provider).map(account => ({ accountId: account.accountId, name: account.name, ready: account.enabled && connections.some(connection => connection.provider === provider && connection.status === 'connected' && !connection.accountSelectionId) }))} /> : null)}
    </main>
  );
}
