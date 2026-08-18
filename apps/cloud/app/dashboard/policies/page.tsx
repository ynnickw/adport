import { policySchema } from '@adport/core';
import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { db } from '@/lib/db';
import { PolicyForm } from './policy-form';

export const metadata = { title: 'Policies' };

export default async function PoliciesPage() {
  const tenant = await requireDashboardTenant();
  const settings = await db()<Array<{ policy: unknown; dataRetentionDays: number }>>`
    select policy, data_retention_days from public.organization_settings where organization_id = ${tenant.organizationId}
  `;
  const policy = policySchema.parse(settings[0]?.policy ?? {});
  const dataRetentionDays = settings[0]?.dataRetentionDays ?? 90;
  return (
    <main className="page">
      <PageHeader eyebrow="Structural safety" title="Policies" description="The write policy every agent, REST call, and MCP session must satisfy. It is enforced server-side inside the shared policy engine, not in the client." />
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h2>Write policy</h2><span className="status">Enforced</span></div>
          <div className="card-body">
            <PolicyForm organizationId={tenant.organizationId} canAdminister={canAdminister(tenant)} policy={policy} dataRetentionDays={dataRetentionDays} />
          </div>
        </section>
        <aside className="stack">
          <section className="card">
            <div className="card-head"><h2>Active guardrails</h2></div>
            <div className="card-body policy-list">
              {Object.entries(policy).map(([key, value]) => (
                <div className="policy-row" key={key}>
                  <span className="policy-key">{key.replaceAll('_', ' ')}</span>
                  <span className="policy-value">{JSON.stringify(value)}</span>
                </div>
              ))}
              <div className="policy-row"><span className="policy-key">data retention days</span><span className="policy-value">{dataRetentionDays}</span></div>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Execution contract</h2></div>
            <div className="card-body">
              <div className="callout">Preview first → identical argument hash → explicit approval → single apply → append-only audit. Provider coercions are always visible.</div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
