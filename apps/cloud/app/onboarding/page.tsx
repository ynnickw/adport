import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getAccountSelection } from '@/lib/cloud/account-selection';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOnboardingState } from '@/lib/cloud/onboarding';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { oauthAvailability } from '@/lib/cloud/provider-oauth';
import { getOrganizationPolicy, listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { env } from '@/lib/env';
import type { OAuthProviderView } from '../dashboard/connections/provider-connections';
import { OnboardingFlow } from './onboarding-flow';
import { ProjectSwitcher } from '@/components/project-switcher';
import { ProductAnalytics } from '@/components/product-analytics';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { safeDashboardReturnPath } from '@/lib/return-path';
import { SupportWidget } from '@/components/support-widget';
import { getAssistantListings } from '@/lib/cloud/assistant-listings';

export const metadata = { title: 'Set up Adport' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ connected?: string; accounts_saved?: string; access_enabled?: string; error?: string; return_to?: string; step?: string; resume?: string; selection_id?: string; selection_unavailable?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [state, connections, accounts, entitlement, params, usage, policy] = await Promise.all([
    getOnboardingState(tenant.organizationId),
    listConnections(tenant.organizationId, tenant.userId),
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    searchParams,
    getOrganizationUsage(tenant.organizationId),
    getOrganizationPolicy(tenant.organizationId),
  ]);
  const returnTo = safeDashboardReturnPath(params.return_to ?? null);
  if (((state.completedAt || state.skippedAt) && params.resume !== '1') || !canAdminister(tenant)) redirect(returnTo);
  const selectionId = z.string().uuid().safeParse(params.selection_id);
  const selection = selectionId.success ? await getAccountSelection({ ...tenant, scopes: [] }, selectionId.data) : undefined;
  const selectionUnavailable = params.selection_unavailable || (params.selection_id && !selection);
  const availability = oauthAvailability(tenant.organizationId);
  const providers: OAuthProviderView[] = OAUTH_PROVIDERS.map((id) => ({ id, available: availability[id] }));
  return (
    <main className="onboarding-page">
      <ProductAnalytics key={`${tenant.userId}:${tenant.organizationId}`} />
      <OnboardingFlow key={tenant.organizationId + ':' + (selection?.id ?? (params.step === 'connect' ? 'connect' : ''))}
        organizationId={tenant.organizationId}
        projectName={tenant.organizationName}
        policy={policy}
        setupKind={usage.projects > 1 ? 'new_project' : 'first_project'}
        projectSwitcher={tenant.projects.length > 1 ? <ProjectSwitcher projects={tenant.projects} currentProjectId={tenant.organizationId} /> : undefined}
        resuming={params.resume === '1'}
        canManage={canAdminister(tenant)}
        initialStep={selection ? 'accounts' : params.step === 'connect' || params.step === 'accounts' || params.step === 'agent' ? params.step : state.currentStep}
        initialAgent={state.selectedAgent}
        baseUrl={env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '')}
        listings={getAssistantListings()}
        connectedProvider={selection?.provider ?? params.accounts_saved ?? params.connected}
        pendingSelection={selection ? { id: selection.id, provider: selection.provider, accounts: selection.accounts, pages: selection.pages } : undefined}
        accountsSaved={Boolean(params.accounts_saved)}
        accountsEnabled={params.access_enabled === '1'}
        oauthError={params.error ?? (selectionUnavailable ? 'This account selection is no longer available. Reconnect the platform to choose accounts again.' : undefined)}
        providers={providers}
        connections={connections.map((connection) => ({
          provider: connection.provider, status: connection.status, externalLabel: connection.externalLabel,
          accountSelectionId: connection.accountSelectionId,
          accountSelectionUnavailable: connection.accountSelectionUnavailable,
          lastError: connection.lastError, connectedAt: connection.connectedAt.toISOString(),
          lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
        }))}
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
  );
}
