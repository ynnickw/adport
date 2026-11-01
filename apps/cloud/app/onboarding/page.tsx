import { redirect } from 'next/navigation';
import { BrandLockup } from '@/components/logos';
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

export const metadata = { title: 'Set up Adport' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ connected?: string; accounts_saved?: string; error?: string; return_to?: string; step?: string }> }) {
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
  if (state.completedAt || !canAdminister(tenant)) redirect(returnTo);
  const availability = oauthAvailability(tenant.organizationId);
  const providers: OAuthProviderView[] = OAUTH_PROVIDERS.map((id) => ({ id, available: availability[id] }));
  return (
    <main className="onboarding-page">
      <ProductAnalytics key={`${tenant.userId}:${tenant.organizationId}`} />
      <header className="onboarding-head"><BrandLockup /><span>{tenant.organizationName}</span></header>
      {tenant.projects.length > 1 ? <div className="onboarding-stage"><ProjectSwitcher projects={tenant.projects} currentProjectId={tenant.organizationId} /></div> : null}
      <OnboardingFlow key={tenant.organizationId + ':' + (params.step === 'connect' ? 'connect' : '')}
        organizationId={tenant.organizationId}
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
    </main>
  );
}
