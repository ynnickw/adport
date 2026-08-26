import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { env } from '@/lib/env';
import { AgentSetupGuide } from './agent-setup-guide';
import { ApiKeyManager } from './api-key-manager';

export const metadata = { title: 'Agent access' };

export default async function AgentsPage() {
  const tenant = await requireDashboardTenant();
  const baseUrl = env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '');
  return (
    <main className="page">
      <PageHeader eyebrow="Remote MCP & REST" title="Agent access" description="Connect an MCP client with Adport OAuth. Grants are scoped to this workspace and every write still passes the same policy gate." />
      <div className="stack agent-access-stack">
        <AgentSetupGuide baseUrl={baseUrl} />
        <div className="grid-2">
          <section className="card">
            <div className="card-head"><h2>Connection details</h2><span className="card-note">Streamable HTTP</span></div>
            <div className="card-body stack">
              <p className="subhead">Use this endpoint for any other OAuth-capable MCP client. Authorization is scoped to this workspace and can be revoked below.</p>
              <div className="code"><span>MCP</span>{baseUrl}/mcp</div>
              <p className="inline-note">No API key is required. The MCP client receives short-lived, audience-bound access tokens and refreshes them automatically.</p>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>REST fallback</h2><span className="card-note">Manual key required</span></div>
            <div className="card-body stack">
              <div className="code"><span>GET</span>{baseUrl}/api/v1/accounts</div>
              <div className="code"><span>POST</span>{baseUrl}/api/v1/tools/&lt;tool&gt;</div>
              <p className="inline-note">Use a manual bearer key only for clients without MCP OAuth. Guarded writes first return a preview; applying requires the matching pending operation.</p>
            </div>
          </section>
        </div>
        <section className="card">
          <div className="card-head"><h2>Agent credentials</h2><span className="card-note">OAuth grants and manual keys · secrets never displayed</span></div>
          <ApiKeyManager organizationId={tenant.organizationId} canManage={canAdminister(tenant)} />
        </section>
      </div>
    </main>
  );
}
