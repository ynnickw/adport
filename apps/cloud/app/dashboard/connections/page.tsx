import { PageHeader } from '@/components/ui';
import { SuccessToast } from '@/components/toast';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { providerLabel, usesAdAccountSlot } from '@/lib/cloud/providers';
import { listConnections } from '@/lib/cloud/repository';
import { ProviderConnections } from './provider-connections';
import { connectionView, platformOptions } from './connection-view';
import { isSyntheticReviewer } from '@/lib/cloud/synthetic-reviewer';
import { SyntheticReviewer } from '@/components/synthetic-reviewer';

export const metadata = { title: 'Platforms' };

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const tenant = await requireDashboardTenant();
  if (isSyntheticReviewer(tenant.organizationId)) return <SyntheticReviewer tenant={tenant} />;
  const [connections, params] = await Promise.all([listConnections(tenant.organizationId, tenant.userId), searchParams]);
  return (
    <main className="page">
      <PageHeader
        title="Ad platforms"
        description="Connect your advertising platforms, then manage ad-account access."
      />
      <div className="stack" style={{ marginBottom: '0.9rem' }}>
        <SuccessToast message={params.connected ? `${providerLabel(params.connected)} connected.` : undefined} />
        {params.error ? <div className="error-callout" role="alert" style={{ marginBottom: 0 }}>{params.error}</div> : null}
      </div>
      <ProviderConnections
        organizationId={tenant.organizationId}
        projectName={tenant.organizationName}
        canManage={canAdminister(tenant)}
        connections={connections.filter(connection => usesAdAccountSlot(connection.provider)).map(connectionView)}
        oauthProviders={platformOptions(tenant.organizationId, 'advertising')}
      />
    </main>
  );
}
