import { DashboardLink as Link } from '@/components/dashboard-navigation';
import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { connectedCatalogProviders } from '@/lib/cloud/tool-catalog';
import { env } from '@/lib/env';
import { ApiKeyManager } from '../agents/api-key-manager';

export const metadata = { title: 'Developer settings' };

export default async function DeveloperPage() {
  const tenant = await requireDashboardTenant();
  if (!canAdminister(tenant)) return <main className="page">
    <PageHeader title="Developer settings" />
    <p>Only project owners and admins can manage API keys.</p>
    <Link href="/dashboard/agents">Back to AI assistants</Link>
  </main>;
  const providers = await connectedCatalogProviders([tenant.organizationId]);
  return <main className="page">
    <PageHeader title="Developer settings" description="API keys for scripts and custom integrations." showDescription
      action={<Link className="button secondary" href="/dashboard/agents">AI assistants</Link>} />
    <ApiKeyManager key={tenant.organizationId} organizationId={tenant.organizationId} suggestedProviders={providers[tenant.organizationId] ?? []} baseUrl={env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '')} />
  </main>;
}
