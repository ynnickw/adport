import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { oauthAvailability } from '@/lib/cloud/provider-oauth';
import { providerLabel } from '@/lib/cloud/providers';
import { listConnections } from '@/lib/cloud/repository';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { ProviderConnections, type OAuthProviderView } from './provider-connections';

export const metadata = { title: 'Connections' };

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [connections, params] = await Promise.all([listConnections(tenant.organizationId), searchParams]);
  const availability = oauthAvailability(tenant.organizationId);
  const oauthProviders: OAuthProviderView[] = OAUTH_PROVIDERS.map((id) => ({ id, available: availability[id] }));
  return (
    <main className="page">
      <PageHeader
        title="Connections"
        description="Connect your ad platforms and manage account access."
      />
      <div className="stack" style={{ marginBottom: '0.9rem' }}>
        {params.connected ? <div className="callout success">{providerLabel(params.connected)} is connected and its accessible ad accounts were verified.</div> : null}
        {params.error ? <div className="error-callout" style={{ marginBottom: 0 }}>{params.error}</div> : null}
      </div>
      <ProviderConnections
        organizationId={tenant.organizationId}
        canManage={canAdminister(tenant)}
        connections={connections.map((connection) => ({
          provider: connection.provider,
          status: connection.status,
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
