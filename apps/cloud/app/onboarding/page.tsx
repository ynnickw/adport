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

export const metadata = { title: 'Set up Adport' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ connected?: string; accounts_saved?: string; error?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [state, connections, accounts, entitlement, params] = await Promise.all([
    getOnboardingState(tenant.organizationId),
    listConnections(tenant.organizationId),
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    searchParams,
  ]);
  if (state.completedAt) redirect('/dashboard');
  const availability = oauthAvailability(tenant.organizationId);
  const providers: OAuthProviderView[] = OAUTH_PROVIDERS.map((id) => ({ id, available: availability[id] }));
  return (
    <main className="onboarding-page">
      <header className="onboarding-head"><BrandLockup /><span>{tenant.organizationName}</span></header>
      <OnboardingFlow
        organizationId={tenant.organizationId}
        canManage={canAdminister(tenant)}
        initialStep={state.currentStep}
        initialAgent={state.selectedAgent}
        baseUrl={env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '')}
        connectedProvider={params.accounts_saved ?? params.connected}
        oauthError={params.error}
        providers={providers}
        connections={connections.map((connection) => ({
          provider: connection.provider, status: connection.status, externalLabel: connection.externalLabel,
          accountSelectionId: connection.accountSelectionId,
          lastError: connection.lastError, connectedAt: connection.connectedAt.toISOString(),
          lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
        }))}
        accounts={accounts.map((account) => ({
          provider: account.provider, accountId: account.accountId, name: account.name,
          currency: account.currency, status: account.status, enabled: account.enabled,
        }))}
        maxActiveAccounts={entitlement.plan.maxActiveAccounts}
      />
    </main>
  );
}
