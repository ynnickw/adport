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
      <PageHeader eyebrow="Remote MCP & REST" title="Agent access" description="Bearer keys let AI clients call this organization's tools remotely. Every key inherits the connections, account scope, and write policy shown in this dashboard." />
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h2>API keys</h2><span className="card-note">hashed at rest · shown once</span></div>
          <ApiKeyManager organizationId={tenant.organizationId} canManage={canAdminister(tenant)} />
        </section>
        <aside className="stack">
          <section className="card">
            <div className="card-head"><h2>Remote MCP endpoint</h2></div>
            <div className="card-body stack">
              <div className="code"><span>URL</span>{baseUrl}/mcp</div>
              <p className="inline-note">Configure your MCP client with this URL and <code>Authorization: Bearer &lt;key&gt;</code>. Streamable HTTP transport; the server name is <code>adport-cloud</code>.</p>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>REST</h2></div>
            <div className="card-body stack">
              <div className="code"><span>GET</span>{baseUrl}/api/v1/accounts</div>
              <div className="code"><span>POST</span>{baseUrl}/api/v1/tools/&lt;tool&gt;</div>
              <p className="inline-note">Guarded writes always require the preview call first and the identical second call to apply.</p>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
