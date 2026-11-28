import { policySchema } from '@adport/core';
import { PiShieldCheck } from 'react-icons/pi';
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
    <main className="page settings-page">
      <PageHeader title="Policies"
        action={<Link className="button secondary" href={params.setup === '1' ? setupHref : '/dashboard/accounts'}>{params.setup === '1' ? 'Back to setup' : 'Manage accounts'}</Link>} />
      <section className="settings-section policy-settings" aria-labelledby="policy-safeguards">
        <div className="settings-section-head">
          <h2 id="policy-safeguards">Safeguards <InfoTooltip label="About policy scope">These safeguards apply to this project’s cloud assistants. Local CLI and stdio MCP settings are managed separately.</InfoTooltip></h2>
          <span className="policy-mode"><PiShieldCheck aria-hidden="true" />{entitlement.plan.writeAccess ? 'Preview required for ad changes' : 'Read-only plan'}</span>
        </div>
        <PolicyForm
          key={tenant.organizationId}
          organizationId={tenant.organizationId}
          canAdminister={canAdminister(tenant)}
          policy={policy}
          dataRetentionDays={dataRetentionDays}
          planName={entitlement.plan.name}
          maxRetentionDays={entitlement.plan.maxRetentionDays}
          writeAccess={entitlement.plan.writeAccess}
          accounts={accounts.map(account => ({
            provider: account.provider, accountId: account.accountId, name: account.name,
            currency: account.currency, status: account.status, enabled: account.enabled,
          }))}
        />
      </section>
    </main>
  );
}
