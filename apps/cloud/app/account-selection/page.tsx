import Link from 'next/link';
import { z } from 'zod';
import { PageHeader } from '@/components/ui';
import { BrandLockup } from '@/components/logos';
import { requireDashboardTenant, canAdminister } from '@/lib/cloud/dashboard';
import { getAccountSelection } from '@/lib/cloud/account-selection';
import { listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { providerLabel } from '@/lib/cloud/providers';
import { ProviderAccountPicker } from './provider-account-picker';

export const metadata = { title: 'Add accounts' };

export default async function SelectAccountsPage({ searchParams }: { searchParams: Promise<{ selection_id?: string }> }) {
  const tenant = await requireDashboardTenant();
  const { selection_id } = await searchParams;
  const id = z.string().uuid().safeParse(selection_id);
  const selection = canAdminister(tenant) && id.success
    ? await getAccountSelection({ ...tenant, scopes: [] }, id.data) : undefined;
  if (!selection) return <main className="page">
    <PageHeader title="Account selection unavailable" description="This selection was saved, expired, or belongs to another authorization. Re-authorize the provider to choose accounts again." />
    <Link href="/dashboard/connections" className="button">Open connections</Link>
  </main>;
  const inventory = await listOrganizationAdAccounts(tenant.organizationId);
  return <main className="onboarding-page">
    <header className="onboarding-head"><BrandLockup /><span>{tenant.organizationName}</span></header>
    <div className="account-selection-content">
    <PageHeader title={`Add ${providerLabel(selection.provider)} accounts`} description={selection.accounts.length === 1 ? 'Confirm this account to add it to Adport. Enabling agent access is a separate step.' : 'Choose which accounts to add to Adport. Everything you leave unchecked will disappear after you save. Re-authorize the provider to choose again.'} />
    <ProviderAccountPicker organizationId={tenant.organizationId} selectionId={selection.id}
      provider={selection.provider} accounts={selection.accounts}
      initialSelectedIds={inventory.filter(account => account.provider === selection.provider).map(account => account.accountId)} />
    </div>
  </main>;
}
