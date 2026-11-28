import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getAccountSelection } from '@/lib/cloud/account-selection';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOnboardingState } from '@/lib/cloud/onboarding';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { oauthAvailability } from '@/lib/cloud/provider-oauth';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { CLOUD_PROVIDERS, isOAuthProvider } from '@/lib/cloud/types';
import { env } from '@/lib/env';
import type { OAuthProviderView } from '../dashboard/connections/provider-connections';
import { connectionView } from '../dashboard/connections/connection-view';
import { OnboardingFlow } from './onboarding-flow';
import { ProjectSwitcher } from '@/components/project-switcher';
import { ProductAnalytics } from '@/components/product-analytics';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { safeDashboardReturnPath } from '@/lib/return-path';
import { SupportWidget } from '@/components/support-widget';
import { getAssistantListings } from '@/lib/cloud/assistant-listings';
import { UpgradeProvider } from '@/components/upgrade-context';
import { upgradeBillingOptions } from '@/lib/cloud/billing-options';

export const metadata = { title: 'Set up Adport' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ connected?: string; accounts_saved?: string; access_enabled?: string; error?: string; return_to?: string; step?: string; resume?: string; selection_id?: string; selection_unavailable?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [state, connections, accounts, entitlement, params, usage] = await Promise.all([
    getOnboardingState(tenant.organizationId),
    listConnections(tenant.organizationId, tenant.userId),
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    searchParams,
    getOrganizationUsage(tenant.organizationId),
  ]);
  const returnTo = safeDashboardReturnPath(params.return_to ?? null);
  if (((state.completedAt || state.skippedAt) && params.resume !== '1') || !canAdminister(tenant)) redirect(returnTo);
  const selectionId = z.string().uuid().safeParse(params.selection_id);
  const selection = selectionId.success ? await getAccountSelection({ ...tenant, scopes: [] }, selectionId.data) : undefined;
  const selectionUnavailable = params.selection_unavailable || (params.selection_id && !selection);
  const usableProviders = new Set(connections.filter(connection => connection.status === 'connected' && !connection.accountSelectionId).map(connection => connection.provider));
  const enabledAccounts = accounts.filter(account => account.enabled && usableProviders.has(account.provider));
  const requestedStep = params.step === 'connect' || params.step === 'accounts' || params.step === 'agent' ? params.step : undefined;
  const resumeStep = state.currentStep !== 'welcome' ? state.currentStep : enabledAccounts.length ? 'agent'
    : accounts.length || connections.some(connection => connection.status === 'connected' && connection.accountSelectionId) ? 'accounts' : 'connect';
  const currentProject = tenant.projects.find(project => project.id === tenant.organizationId);
  const workspace = currentProject?.defaultProjectId === tenant.organizationId && ['owner', 'admin'].includes(tenant.organizationRole)
    ? { organizationName: tenant.organizationGroupName, projectName: tenant.organizationName } : undefined;
  const startWithNames = workspace && tenant.organizationRole === 'owner' && state.currentStep === 'welcome' && !state.completedAt && !state.skippedAt
    && resumeStep === 'connect' && !requestedStep && !params.connected && !params.accounts_saved && !params.error && !selectionUnavailable;
  const availability = oauthAvailability(tenant.organizationId);
  const providers: OAuthProviderView[] = CLOUD_PROVIDERS.map(id => ({ id, available: isOAuthProvider(id) ? availability[id] : true }));
  return (
    <UpgradeProvider value={{ planId: entitlement.plan.id, canManageBilling: tenant.organizationRole === 'owner', projectId: tenant.organizationId, billingOptions: upgradeBillingOptions(entitlement) }}>
    <main className="onboarding-page">
      <ProductAnalytics key={`${tenant.userId}:${tenant.organizationId}`} />
      <OnboardingFlow key={JSON.stringify([tenant.organizationId, selection?.id, params.accounts_saved, params.access_enabled, params.connected, params.step === 'connect'])}
        organizationId={tenant.organizationId}
        projectName={tenant.organizationName}
        setupKind={usage.projects > 1 ? 'new_project' : 'first_project'}
        projectSwitcher={<ProjectSwitcher projects={tenant.projects} currentProjectId={tenant.organizationId} />}
        resuming={params.resume === '1'}
        canManage={canAdminister(tenant)}
        initialStep={selection ? 'accounts' : startWithNames ? 'workspace' : requestedStep ?? resumeStep}
        workspace={workspace}
        initialAgent={state.selectedAgent}
        baseUrl={env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '')}
        listings={getAssistantListings()}
        connectedProvider={selection?.provider ?? params.accounts_saved ?? params.connected}
        pendingSelection={selection ? { id: selection.id, provider: selection.provider, accounts: selection.accounts, pages: selection.pages } : undefined}
        accountsSaved={Boolean(params.accounts_saved)}
        accountsEnabled={params.access_enabled === '1' && enabledAccounts.some(account => account.provider === params.accounts_saved)}
        oauthError={params.error ?? (selectionUnavailable ? 'This account selection is no longer available. Reconnect the platform to choose accounts again.' : undefined)}
        providers={providers}
        connections={connections.map(connectionView)}
        accounts={accounts.map((account) => ({
          provider: account.provider, accountId: account.accountId, name: account.name,
          currency: account.currency, status: account.status, enabled: account.enabled,
        }))}
        maxActiveAccounts={entitlement.plan.maxActiveAccounts}
        organizationActiveCount={usage.enabledAccounts}
        returnTo={returnTo}
      />
      <SupportWidget />
    </main>
    </UpgradeProvider>
  );
}
