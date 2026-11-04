import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { oauthAvailability } from '@/lib/cloud/provider-oauth';
import { providerLabel } from '@/lib/cloud/providers';
import { listConnections } from '@/lib/cloud/repository';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { ProviderConnections, type OAuthProviderView } from './provider-connections';
import { GOOGLE_DATA_MANAGER_SCOPE } from '@/lib/cloud/google-oauth';
import { isSyntheticReviewer } from '@/lib/cloud/synthetic-reviewer';
import { SyntheticReviewer } from '@/components/synthetic-reviewer';
import { PINTEREST_PIN_SCOPES, PINTEREST_SECRET_PIN_SCOPES } from '@adport/provider-pinterest';

export const metadata = { title: 'Platforms' };

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const tenant = await requireDashboardTenant();
  if (isSyntheticReviewer(tenant.organizationId)) return <SyntheticReviewer tenant={tenant} />;
  const [connections, params] = await Promise.all([listConnections(tenant.organizationId, tenant.userId), searchParams]);
  const availability = oauthAvailability(tenant.organizationId);
  const oauthProviders: OAuthProviderView[] = OAUTH_PROVIDERS.map((id) => ({ id, available: availability[id] }));
  return (
    <main className="page">
      <PageHeader
        title="Platforms"
        description="Connect your ad platforms and manage account access."
      />
      <div className="stack" style={{ marginBottom: '0.9rem' }}>
        {params.connected ? <div className="callout success" role="status">{providerLabel(params.connected)} is connected and its accessible ad accounts were verified.</div> : null}
        {params.error ? <div className="error-callout" role="alert" style={{ marginBottom: 0 }}>{params.error}</div> : null}
      </div>
      <ProviderConnections
        organizationId={tenant.organizationId}
        canManage={canAdminister(tenant)}
        connections={connections.map((connection) => ({
          provider: connection.provider,
          status: connection.status,
          accountSelectionId: connection.accountSelectionId,
          accountSelectionUnavailable: connection.accountSelectionUnavailable,
          dataManagerEnabled: connection.provider === 'google' && connection.scopes.includes(GOOGLE_DATA_MANAGER_SCOPE),
          pinManagementEnabled: connection.provider === 'pinterest' && PINTEREST_PIN_SCOPES.every(scope => connection.scopes.includes(scope)),
          secretPinsEnabled: connection.provider === 'pinterest' && PINTEREST_SECRET_PIN_SCOPES.every(scope => connection.scopes.includes(scope)),
          externalLabel: connection.externalLabel,
          lastError: connection.lastError,
          connectedAt: connection.connectedAt.toISOString(),
          lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
        }))}
        oauthProviders={oauthProviders}
      />
    </main>
  );
}
