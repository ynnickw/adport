import { Shell } from '@/components/shell';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const tenant = await requireDashboardTenant();
  return (
    <Shell tenant={{ organizationName: tenant.organizationName, userName: tenant.userName, role: tenant.role }}>
      {children}
    </Shell>
  );
}
