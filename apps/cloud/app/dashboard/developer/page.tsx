import { PiArrowRight } from 'react-icons/pi';
import { DashboardLink as Link } from '@/components/dashboard-navigation';
import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { connectedCatalogProviders } from '@/lib/cloud/tool-catalog';
import { hostedToolCatalogCounts } from '@/lib/cloud/runtime';
import { env } from '@/lib/env';
import { ApiKeyManager } from '../agents/api-key-manager';
import { DeveloperReference } from './developer-reference';

export const metadata = { title: 'Developer settings' };

export default async function DeveloperPage() {
  const tenant = await requireDashboardTenant();
  if (!canAdminister(tenant)) return <main className="page">
    <PageHeader title="Developer settings" />
    <p>Only project owners and admins can manage API keys.</p>
    <Link href="/dashboard/agents">Back to AI assistants</Link>
  </main>;
  const providers = await connectedCatalogProviders([tenant.organizationId]);
  return <main className="page settings-page">
    <PageHeader title="Developer settings" description="Connect scripts, services, and custom AI integrations." showDescription
      action={<Link className="link-button settings-link" href="/dashboard/agents">AI assistants <PiArrowRight aria-hidden="true" /></Link>} />
    <ApiKeyManager key={tenant.organizationId} organizationId={tenant.organizationId} suggestedProviders={providers[tenant.organizationId] ?? []}
      catalogCounts={hostedToolCatalogCounts([tenant.organizationId])} />
    <DeveloperReference baseUrl={env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '')} />
  </main>;
}
