import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { env } from '@/lib/env';
import { ApiKeyManager } from './api-key-manager';

export const metadata = { title: 'Agent access' };

export default async function AgentsPage() {
  const tenant = await requireDashboardTenant();
  const baseUrl = env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '');
  return (
    <main className="page">
      <PageHeader eyebrow="Remote MCP & REST" title="Agent access" description="Bearer keys let AI clients use this organization's connections remotely, under the same write policy." />
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h2>API keys</h2><span className="card-note">hashed at rest · shown once</span></div>
          <ApiKeyManager organizationId={tenant.organizationId} canManage={canAdminister(tenant)} />
        </section>
        <section className="card">
          <div className="card-head"><h2>Endpoints</h2></div>
          <div className="card-body stack">
            <div className="code"><span>MCP</span>{baseUrl}/mcp</div>
            <div className="code"><span>GET</span>{baseUrl}/api/v1/accounts</div>
            <div className="code"><span>POST</span>{baseUrl}/api/v1/tools/&lt;tool&gt;</div>
            <p className="inline-note">Send <code>Authorization: Bearer &lt;key&gt;</code>. MCP uses streamable HTTP; guarded writes need the preview call first, then the identical call to apply.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
