import { policySchema } from '@adport/core';
import { DashboardLink as Link } from '@/components/dashboard-navigation';
import { PageHeader } from '@/components/ui';
import { InfoTooltip } from '@/components/info-tooltip';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { db } from '@/lib/db';
import { safeDashboardReturnPath } from '@/lib/return-path';
import { PolicyForm } from './policy-form';

export const metadata = { title: 'Policies' };

export default async function PoliciesPage({ searchParams }: { searchParams: Promise<{ setup?: string; return_to?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [settings, accounts, entitlement, params] = await Promise.all([
    db()<Array<{ policy: unknown; dataRetentionDays: number }>>`
      select policy, data_retention_days from public.organization_settings where organization_id = ${tenant.organizationId}
    `,
    listOrganizationAdAccounts(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    searchParams,
  ]);
  const policy = policySchema.parse(settings[0]?.policy ?? {});
  const dataRetentionDays = settings[0]?.dataRetentionDays ?? 90;
  const setupHref = '/onboarding?' + new URLSearchParams({ resume: '1', return_to: safeDashboardReturnPath(params.return_to ?? null) });
  return (
    <main className="page policy-page">
      <PageHeader title="Policies"
        action={<Link className="button secondary" href={params.setup === '1' ? setupHref : '/dashboard/accounts'}>{params.setup === '1' ? 'Back to setup' : 'Manage accounts'}</Link>} />
      <section className="policy-overview" aria-label="Policy coverage">
        <div><span>Ad changes</span><strong><i className="policy-dot" />{entitlement.plan.writeAccess ? 'Preview required' : 'Read-only plan'}</strong></div>
        <div><span>New campaigns</span><strong>{policy.paused_creation ? 'Start paused' : 'Use requested status'}</strong></div>
        <div><span>Budget changes</span><strong>{policy.max_budget_delta_pct == null ? 'No percentage cap' : `${policy.max_budget_delta_pct}% cap per change`}</strong></div>
      </section>
      <section className="card policy-card">
        <div className="card-head"><h2>Safeguards <InfoTooltip label="About policy scope">Applies to this project’s cloud assistants. Local CLI and stdio MCP settings are managed separately.</InfoTooltip></h2></div>
        <div className="card-body">
          <PolicyForm
            key={tenant.organizationId}
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
