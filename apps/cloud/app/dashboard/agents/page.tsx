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
      <PageHeader eyebrow="Remote MCP & REST" title="Agent access" description="Connect an MCP client with Adport OAuth. Grants are scoped to this workspace and every write still passes the same policy gate." />
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h2>MCP OAuth</h2><span className="status">recommended</span></div>
          <div className="card-body stack">
            <p className="subhead">Add the endpoint below to any OAuth-capable MCP client. The client opens Adport sign-in and asks you to approve read and write scopes for this workspace.</p>
            <div className="code"><span>MCP</span>{baseUrl}/mcp</div>
            <p className="inline-note">No API key to copy. Access tokens are short-lived, audience-bound, and refreshed by the MCP client.</p>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Endpoints</h2></div>
          <div className="card-body stack">
            <div className="code"><span>GET</span>{baseUrl}/api/v1/accounts</div>
            <div className="code"><span>POST</span>{baseUrl}/api/v1/tools/&lt;tool&gt;</div>
            <p className="inline-note">REST callers use a manual bearer key. MCP uses streamable HTTP with OAuth discovery; guarded writes need the preview call first, then the identical call to apply.</p>
          </div>
        </section>
        <section className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="card-head"><h2>Agent credentials</h2><span className="card-note">OAuth grants and manual keys · secrets never displayed</span></div>
          <ApiKeyManager organizationId={tenant.organizationId} canManage={canAdminister(tenant)} />
        </section>
      </div>
    </main>
  );
}
