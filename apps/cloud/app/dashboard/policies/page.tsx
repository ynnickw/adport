import { policySchema } from '@adport/core';
import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { db } from '@/lib/db';
import { PolicyForm } from './policy-form';

export const metadata = { title: 'Policies' };

export default async function PoliciesPage() {
  const tenant = await requireDashboardTenant();
  const [settings, accounts, entitlement] = await Promise.all([
    db()<Array<{ policy: unknown; dataRetentionDays: number }>>`
      select policy, data_retention_days from public.organization_settings where organization_id = ${tenant.organizationId}
    `,
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
  ]);
  const policy = policySchema.parse(settings[0]?.policy ?? {});
  const dataRetentionDays = settings[0]?.dataRetentionDays ?? 90;
  return (
    <main className="page policy-page">
      <PageHeader title="Policies" description="Set the boundaries every dashboard, REST, and MCP write must satisfy before it can reach an ad platform."
        action={<Link className="button secondary" href="/dashboard/accounts" prefetch={false}>Manage accounts</Link>} />
      <section className="policy-overview" aria-label="Policy coverage">
        <div><span>Enforcement</span><strong><i className="policy-dot" />Always on</strong><small>Preview + exact approval</small></div>
        <div><span>Account scope</span><strong>{accounts.filter((account) => account.enabled).length} active</strong><small>{accounts.length} discovered across providers</small></div>
        <div><span>Current plan</span><strong>{entitlement.plan.name}</strong><small>{entitlement.plan.writeAccess ? 'Guarded read and write' : 'Read-only agent access'}</small></div>
      </section>
      <section className="card policy-card">
        <div className="card-head"><div><h2>Workspace safety policy</h2><p className="card-kicker">Changes apply immediately to every agent client.</p></div><span className="status">Enforced</span></div>
        <div className="card-body">
          <PolicyForm
            organizationId={tenant.organizationId}
            canAdminister={canAdminister(tenant)}
            policy={policy}
            dataRetentionDays={dataRetentionDays}
            planName={entitlement.plan.name}
            maxRetentionDays={entitlement.plan.maxRetentionDays}
            writeAccess={entitlement.plan.writeAccess}
            accounts={accounts.map((account) => ({
              provider: account.provider, accountId: account.accountId, name: account.name,
              currency: account.currency, status: account.status, enabled: account.enabled,
            }))}
          />
        </div>
      </section>
    </main>
  );
}
