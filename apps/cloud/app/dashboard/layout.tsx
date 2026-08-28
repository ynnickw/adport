import { Shell } from '@/components/shell';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const tenant = await requireDashboardTenant();
  if (!tenant.onboardingCompletedAt) redirect('/onboarding');
  return (
    <Shell tenant={{ organizationName: tenant.organizationName, userName: tenant.userName, email: tenant.email, role: tenant.role }}>
      {children}
    </Shell>
  );
}
