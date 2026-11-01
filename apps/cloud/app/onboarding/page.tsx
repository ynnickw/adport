import { redirect } from 'next/navigation';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOnboardingState } from '@/lib/cloud/onboarding';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { oauthAvailability } from '@/lib/cloud/provider-oauth';
import { listConnections, listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { env } from '@/lib/env';
import type { OAuthProviderView } from '../dashboard/connections/provider-connections';
import { OnboardingFlow } from './onboarding-flow';
import { ProjectSwitcher } from '@/components/project-switcher';
import { ProductAnalytics } from '@/components/product-analytics';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { safeDashboardReturnPath } from '@/lib/return-path';
import { SupportWidget } from '@/components/support-widget';

export const metadata = { title: 'Set up Adport' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ connected?: string; accounts_saved?: string; error?: string; return_to?: string; step?: string; resume?: string }> }) {
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
  if ((state.completedAt && params.resume !== '1') || !canAdminister(tenant)) redirect(returnTo);
  const availability = oauthAvailability(tenant.organizationId);
  const providers: OAuthProviderView[] = OAUTH_PROVIDERS.map((id) => ({ id, available: availability[id] }));
  return (
    <main className="onboarding-page">
      <ProductAnalytics key={`${tenant.userId}:${tenant.organizationId}`} />
      <OnboardingFlow key={tenant.organizationId + ':' + (params.step === 'connect' ? 'connect' : '')}
        organizationId={tenant.organizationId}
        projectName={tenant.organizationName}
        setupKind={usage.projects > 1 ? 'new_project' : 'first_project'}
        projectSwitcher={tenant.projects.length > 1 ? <ProjectSwitcher projects={tenant.projects} currentProjectId={tenant.organizationId} /> : undefined}
        resuming={params.resume === '1'}
        canManage={canAdminister(tenant)}
        initialStep={params.step === 'connect' ? 'connect' : state.currentStep}
        initialAgent={state.selectedAgent}
        baseUrl={env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '')}
        connectedProvider={params.accounts_saved ?? params.connected}
        oauthError={params.error}
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
