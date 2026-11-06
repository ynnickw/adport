import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { isSyntheticReviewer } from '@/lib/cloud/synthetic-reviewer';
import { SyntheticReviewer } from '@/components/synthetic-reviewer';
import { Empty, PageHeader } from '@/components/ui';
import { ProviderConnections } from '@/app/dashboard/connections/provider-connections';
import { AccountAccessManager } from '@/app/dashboard/accounts/account-access-manager';
import { ProviderAccountPicker } from '@/app/account-selection/provider-account-picker';
import { getAccountSelection } from '@/lib/cloud/account-selection';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { oauthAvailability } from '@/lib/cloud/provider-oauth';
import { providerLabel, usesAdAccountSlot } from '@/lib/cloud/providers';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { isOAuthProvider, OAUTH_PROVIDERS } from '@/lib/cloud/types';

export const metadata = { title: 'Analytics & tracking' };

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{
  connected?: string; accounts_saved?: string; access_enabled?: string; error?: string;
  select_provider?: string; selection_id?: string;
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
    <PageHeader title={`Add ${providerLabel(selection.provider)} accounts`} showDescription description="Choose the accounts your assistants can use. Analytics and tracking connections do not use ad-account slots." />
    <ProviderAccountPicker organizationId={tenant.organizationId} selectionId={selection.id} provider={selection.provider}
      accounts={selection.accounts} initialSelectedIds={accounts.filter(account => account.provider === selection.provider).map(account => account.accountId)}
      initialEnabledIds={accounts.filter(account => account.provider === selection.provider && account.enabled).map(account => account.accountId)}
      backHref="/dashboard/analytics" nextPath="/dashboard/analytics" />
  </main>;
  const availability = oauthAvailability(tenant.organizationId);
  const providers = OAUTH_PROVIDERS.filter(provider => !usesAdAccountSlot(provider)).map(id => ({ id, available: availability[id] }));
  const requestedProvider = params.select_provider;
  const providerFilter = requestedProvider && isOAuthProvider(requestedProvider) && !usesAdAccountSlot(requestedProvider) ? requestedProvider : undefined;
  return <main className="page">
    <PageHeader title="Analytics & tracking" showDescription description="Connect analytics and tracking tools separately from your ad platforms. These connections do not use ad-account slots." />
    {params.error ? <div className="error-callout" role="alert">{params.error}</div> : null}
    {params.accounts_saved ? <div className="callout success" role="status">{params.access_enabled === '1' ? 'Analytics accounts added and enabled for your assistants.' : 'Analytics accounts imported. Enable access below when ready.'}</div> : null}
    {params.selection_id ? <div className="error-callout" role="alert">This selection is no longer available. Reconnect the analytics platform to choose accounts again.</div> : null}
    {providers.some(provider => provider.available) || analyticsConnections.length ? <ProviderConnections organizationId={tenant.organizationId} canManage={canManage}
      returnTo="/dashboard/analytics" oauthProviders={providers}
      connections={analyticsConnections.map(connection => ({ provider: connection.provider, status: connection.status,
        accountSelectionId: connection.accountSelectionId, accountSelectionUnavailable: connection.accountSelectionUnavailable,
        externalLabel: connection.externalLabel, lastError: connection.lastError, connectedAt: connection.connectedAt.toISOString(),
        lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null }))} />
      : <section className="card"><Empty title="No analytics integrations available yet" copy="Available analytics and tracking integrations will appear here." /></section>}
    {accounts.length ? <div id="account-access" style={{ marginTop: '1.5rem' }}><AccountAccessManager key={tenant.organizationId} category="analytics"
      organizationId={tenant.organizationId} canManage={canManage} maxActiveAccounts={null} providerFilter={providerFilter}
      accounts={accounts.map(account => ({ ...account, connectionStatus: analyticsConnections.find(connection => connection.provider === account.provider)?.status ?? 'revoked',
        accountSelectionId: analyticsConnections.find(connection => connection.provider === account.provider)?.accountSelectionId,
        accountSelectionUnavailable: analyticsConnections.find(connection => connection.provider === account.provider)?.accountSelectionUnavailable }))} /></div> : null}
  </main>;
}
