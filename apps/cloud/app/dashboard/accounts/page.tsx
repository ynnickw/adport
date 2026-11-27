import { DashboardLink as Link } from '@/components/dashboard-navigation';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getAccountSelection } from '@/lib/cloud/account-selection';
import { ProviderAccountPicker } from '@/app/account-selection/provider-account-picker';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { PageHeader } from '@/components/ui';
import { SuccessToast } from '@/components/toast';
import { Disclosure } from '@/components/controls';
import { PendingAccountSelections } from '@/components/pending-account-selections';
import { SupportLauncher } from '@/components/support-widget';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { providerLabel, usesAdAccountSlot } from '@/lib/cloud/providers';
import { isCloudProvider } from '@/lib/cloud/types';
import { AddProviderDialog } from '../connections/add-provider-dialog';
import { connectionView, platformOptions } from '../connections/connection-view';
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
  const providerFilter = requestedProvider && isCloudProvider(requestedProvider) ? requestedProvider : undefined;
  if (providerFilter && !usesAdAccountSlot(providerFilter)) {
    redirect('/dashboard/analytics?' + new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
  }
  const adAccounts = inventory.filter(account => usesAdAccountSlot(account.provider));
  const pendingConnections = connections.filter(connection => usesAdAccountSlot(connection.provider) && connection.accountSelectionId && connection.status === 'connected' && (!providerFilter || connection.provider === providerFilter));
  const canManage = ['owner', 'admin'].includes(tenant.role);
  const selectionId = z.string().uuid().safeParse(params.selection_id);
  const selection = canManage && selectionId.success ? await getAccountSelection({ ...tenant, scopes: [] }, selectionId.data) : undefined;
  if (selection && !usesAdAccountSlot(selection.provider)) redirect('/dashboard/analytics?selection_id=' + selection.id);
  if (selection) return <main className="page">
    <div className="selection-back-row"><Link className="selection-back" href="/dashboard/accounts">← Accounts</Link><SupportLauncher className="support-inline" /></div>
    <PageHeader title={`Add ${providerLabel(selection.provider)} accounts`} showDescription description={`Project: ${tenant.organizationName}`} />
    <ProviderAccountPicker organizationId={tenant.organizationId} selectionId={selection.id} provider={selection.provider}
      accounts={selection.accounts} pages={selection.pages} backHref="/dashboard/accounts" nextPath={'/dashboard/accounts?select_provider=' + selection.provider}
      initialSelectedIds={inventory.filter(account => account.provider === selection.provider).map(account => account.accountId)} initialEnabledIds={inventory.filter(account => account.provider === selection.provider && account.enabled).map(account => account.accountId)} maxActiveAccounts={entitlement.plan.maxActiveAccounts} organizationActiveCount={usage.enabledAccounts} />
  </main>;
  const hasAccounts = adAccounts.some(account => !providerFilter || account.provider === providerFilter);
  const addAccounts = canManage ? <AddProviderDialog projectId={tenant.organizationId} projectName={tenant.organizationName}
    providers={platformOptions(tenant.organizationId, 'advertising')} connections={connections.filter(connection => usesAdAccountSlot(connection.provider)).map(connectionView)} category="advertising" /> : undefined;
  return (
    <main className="page">
      <PageHeader title={providerFilter ? `${providerLabel(providerFilter)} accounts` : 'Ad accounts'} action={hasAccounts || pendingConnections.length ? addAccounts : undefined} />
      {providerFilter ? <Link className="button secondary small" href="/dashboard/accounts" style={{ marginBottom: '1rem' }}>View all providers’ accounts</Link> : null}
      <SuccessToast message={params.connected ? `${providerLabel(params.connected)} connected.` : undefined} />
      {params.selection_id || params.selection_unavailable ? <div className="error-callout" role="alert">This account selection is no longer available. It may have expired, been saved, or belong to another admin. {canManage ? <Link href="/dashboard/connections">Reconnect the platform to choose accounts again.</Link> : 'Ask a project owner or admin to restart the connection.'}</div> : null}
      <SuccessToast message={params.accounts_saved ? params.access_enabled === '1' ? 'Accounts enabled for assistants.' : 'Selection saved without enabling new accounts.' : undefined} />
      {params.error ? <div className="error-callout" role="alert">{params.error}</div> : null}
      <PendingAccountSelections connections={pendingConnections} canManage={['owner', 'admin'].includes(tenant.role)} />
      {!hasAccounts && pendingConnections.length ? null : !hasAccounts ? <section className="card">
        <div className="empty"><h2>{providerFilter ? `No ${providerLabel(providerFilter)} accounts added` : 'No ad accounts yet'}</h2>
          <p>{canManage ? 'Choose a platform to add accounts to this project.' : 'Ask a project owner or admin to add accounts.'}</p>{addAccounts}</div>
      </section> : (
        <AccountAccessManager key={tenant.organizationId}
          organizationId={tenant.organizationId}
          accounts={adAccounts.map(account => ({ ...account, connectionStatus: connections.find(connection => connection.provider === account.provider)?.status ?? 'revoked', accountSelectionId: connections.find(connection => connection.provider === account.provider)?.accountSelectionId, accountSelectionUnavailable: connections.find(connection => connection.provider === account.provider)?.accountSelectionUnavailable }))}
          canManage={['owner', 'admin'].includes(tenant.role)}
          maxActiveAccounts={entitlement.plan.maxActiveAccounts}
          organizationActiveCount={usage.enabledAccounts}
          providerFilter={providerFilter}
        />
      )}
      {(['tiktok', 'reddit'] as const).map(provider => canManage && providerFilter === provider ? <Disclosure key={tenant.organizationId + ':' + provider} label={`${providerLabel(provider)} catalog access`} className="account-catalog-disclosure"><CatalogAccessManager provider={provider} organizationId={tenant.organizationId} projectName={tenant.organizationName}
        accounts={inventory.filter(account => account.provider === provider).map(account => ({ accountId: account.accountId, name: account.name, ready: account.enabled && connections.some(connection => connection.provider === provider && connection.status === 'connected' && !connection.accountSelectionId) }))} /></Disclosure> : null)}
    </main>
  );
}
