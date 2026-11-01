import { policySchema } from '@adport/core';
import Link from 'next/link';
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
      <PageHeader title="Policies" description="Set the safeguards for this project’s cloud assistants. Local CLI and stdio MCP settings are configured separately."
        action={<Link className="button secondary" href={params.setup === '1' ? setupHref : '/dashboard/accounts'} prefetch={false}>{params.setup === '1' ? 'Back to setup' : 'Manage accounts'}</Link>} />
      <section className="policy-overview" aria-label="Policy coverage">
        <div><span>Write protection</span><strong><i className="policy-dot" />Preview required</strong><small>Always on for ad changes <InfoTooltip label="About write protection">Every advertising change must be previewed before it can be applied with its matching token and exact arguments. This step cannot be turned off.</InfoTooltip></small></div>
        <div><span>Account scope</span><strong>{accounts.filter((account) => account.enabled).length} active</strong><small>{accounts.length} discovered across providers</small></div>
        <div><span>Current plan</span><strong>{entitlement.plan.name}</strong><small>{entitlement.plan.writeAccess ? 'Guarded read and write' : 'Read-only agent access'}</small></div>
      </section>
      <section className="card policy-card">
        <div className="card-head"><h2>{tenant.organizationName} policy <InfoTooltip label="About policy changes">Saved changes apply to this project’s cloud clients. Changing a safety setting requires fresh previews before pending changes can be applied.</InfoTooltip></h2></div>
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
