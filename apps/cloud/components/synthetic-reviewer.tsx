import { PageHeader } from '@/components/ui';
import type { DashboardTenant } from '@/lib/cloud/dashboard';

/** Keep retired reviewer sessions isolated without serving any demo data or tools. */
export function SyntheticReviewer(_props: { tenant: DashboardTenant }) {
  return <main className="page">
    <PageHeader title="Workspace retired" description="This demo workspace is no longer available. Sign out and sign in with your real Adport account, then reconnect your agent." />
  </main>;
}
