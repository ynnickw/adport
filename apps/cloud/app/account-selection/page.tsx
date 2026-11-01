import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireDashboardTenant, canAdminister } from '@/lib/cloud/dashboard';
import { getAccountSelection } from '@/lib/cloud/account-selection';
import { accountSelectionPath } from '@/lib/account-selection-path';

export const metadata = { title: 'Add accounts' };

// Existing OAuth callbacks and bookmarked selection links keep working.
export default async function SelectAccountsPage({ searchParams }: { searchParams: Promise<{ selection_id?: string }> }) {
  const tenant = await requireDashboardTenant();
  const { selection_id } = await searchParams;
  const id = z.string().uuid().safeParse(selection_id);
  const selection = canAdminister(tenant) && id.success
    ? await getAccountSelection({ ...tenant, scopes: [] }, id.data) : undefined;
  if (!selection) redirect(tenant.onboardingCompletedAt
    ? '/dashboard/accounts?selection_unavailable=1'
    : '/onboarding?step=connect&selection_unavailable=1');
  redirect(accountSelectionPath(selection.id, selection.returnPath, !tenant.onboardingCompletedAt));
}
