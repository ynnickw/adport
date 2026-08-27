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
      <PageHeader title="Policies" description="Every write from the dashboard, REST, or MCP must satisfy this policy. It is enforced server-side." />
      <section className="card" style={{ maxWidth: '46rem' }}>
        <div className="card-head"><h2>Write policy</h2><span className="status">Enforced</span></div>
        <div className="card-body">
          <PolicyForm organizationId={tenant.organizationId} canAdminister={canAdminister(tenant)} policy={policy} dataRetentionDays={dataRetentionDays} />
        </div>
      </section>
    </main>
  );
}
