import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { isSyntheticReviewer } from '@/lib/cloud/synthetic-reviewer';
import { SyntheticReviewer } from '@/components/synthetic-reviewer';
import { PageHeader } from '@/components/ui';
import { ProviderConnections } from '@/app/dashboard/connections/provider-connections';
import { AddProviderDialog } from '@/app/dashboard/connections/add-provider-dialog';
import { connectionView, platformOptions } from '@/app/dashboard/connections/connection-view';
import { PendingAccountSelections } from '@/components/pending-account-selections';
import { AccountAccessManager } from '@/app/dashboard/accounts/account-access-manager';
import { ProviderAccountPicker } from '@/app/account-selection/provider-account-picker';
import { getAccountSelection } from '@/lib/cloud/account-selection';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { providerLabel, providerResourceName, usesAdAccountSlot } from '@/lib/cloud/providers';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { isOAuthProvider } from '@/lib/cloud/types';

export const metadata = { title: 'Analytics & tracking' };

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{
  connected?: string; accounts_saved?: string; access_enabled?: string; error?: string;
  select_provider?: string; selection_id?: string; selection_unavailable?: string;
}> }) {
  const tenant = await requireDashboardTenant();
  if (isSyntheticReviewer(tenant.organizationId)) return <SyntheticReviewer tenant={tenant} />;
  const [connections, inventory, params] = await Promise.all([
    listConnections(tenant.organizationId, tenant.userId), listOrganizationAdAccounts(tenant.organizationId), searchParams,
  ]);
  const canManage = canAdminister(tenant);
  const analyticsConnections = connections.filter(connection => !usesAdAccountSlot(connection.provider));
  const accounts = inventory.filter(account => !usesAdAccountSlot(account.provider));
  const selectionId = z.string().uuid().safeParse(params.selection_id);
  const selection = canManage && selectionId.success ? await getAccountSelection({ ...tenant, scopes: [] }, selectionId.data) : undefined;
  if (selection && usesAdAccountSlot(selection.provider)) redirect('/dashboard/accounts?selection_id=' + selection.id);
  if (selection) return <main className="page">
    <Link className="selection-back" href="/dashboard/analytics">← Analytics & tracking</Link>
    <PageHeader title={`Add ${providerLabel(selection.provider)} ${providerResourceName(selection.provider)}`} showDescription description={`Project: ${tenant.organizationName}`} />
    <ProviderAccountPicker organizationId={tenant.organizationId} selectionId={selection.id} provider={selection.provider}
      accounts={selection.accounts} initialSelectedIds={accounts.filter(account => account.provider === selection.provider).map(account => account.accountId)}
      initialEnabledIds={accounts.filter(account => account.provider === selection.provider && account.enabled).map(account => account.accountId)}
      backHref="/dashboard/analytics" nextPath="/dashboard/analytics" />
  </main>;
  const providers = platformOptions(tenant.organizationId, 'analytics');
  const views = analyticsConnections.map(connectionView);
  const pending = analyticsConnections.filter(connection => connection.accountSelectionId && connection.status === 'connected');
  const addSource = canManage ? <AddProviderDialog projectId={tenant.organizationId} projectName={tenant.organizationName}
    providers={providers} connections={views} category="analytics" /> : undefined;
  const requestedProvider = params.select_provider;
  const providerFilter = requestedProvider && isOAuthProvider(requestedProvider) && !usesAdAccountSlot(requestedProvider) ? requestedProvider : undefined;
  return <main className="page">
    <PageHeader title="Analytics & tracking" action={accounts.length || pending.length ? addSource : undefined} />
    <div className="stack">
    {params.error ? <div className="error-callout" role="alert">{params.error}</div> : null}
    {params.accounts_saved ? <div className="callout success" role="status">{params.access_enabled === '1' ? 'Sources enabled for assistants.' : 'Sources saved. New sources are off until enabled.'}</div> : null}
    {params.selection_id || params.selection_unavailable ? <div className="error-callout" role="alert">This selection is no longer available. {canManage ? 'Choose the platform again to restart.' : 'Ask an owner or admin to restart it.'}</div> : null}
    {providerFilter ? <div><Link className="button secondary small" href="/dashboard/analytics">View all sources</Link></div> : null}
    <PendingAccountSelections connections={pending} canManage={canManage} noun="sources" />
    {accounts.length ? <div id="account-access"><AccountAccessManager key={tenant.organizationId} category="analytics"
      organizationId={tenant.organizationId} canManage={canManage} maxActiveAccounts={null} providerFilter={providerFilter}
      accounts={accounts.map(account => ({ ...account, connectionStatus: analyticsConnections.find(connection => connection.provider === account.provider)?.status ?? 'revoked',
        accountSelectionId: analyticsConnections.find(connection => connection.provider === account.provider)?.accountSelectionId,
        accountSelectionUnavailable: analyticsConnections.find(connection => connection.provider === account.provider)?.accountSelectionUnavailable }))} /></div>
        : !pending.length ? <section id="account-access" className="card"><div className="empty"><h2>No sources yet</h2><p>{canManage ? 'Connect an analytics or tracking platform to choose sources.' : 'Ask a project owner or admin to add a source.'}</p>{addSource}</div></section> : null}
    <section className="dashboard-section">
      <h2>Analytics platforms</h2>
      <ProviderConnections organizationId={tenant.organizationId} projectName={tenant.organizationName} canManage={canManage}
        returnTo="/dashboard/analytics" oauthProviders={providers} connections={views} />
    </section>
    </div>
  </main>;
}
