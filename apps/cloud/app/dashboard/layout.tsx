import { Shell } from '@/components/shell';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { countPendingOperations } from '@/lib/cloud/repository';
import { redirect } from 'next/navigation';
import { ProjectSwitcher } from '@/components/project-switcher';
import { ProductAnalytics } from '@/components/product-analytics';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { SidebarPlanUsage } from '@/components/plan-usage';
import { headers } from 'next/headers';
import { REQUEST_PATH_HEADER, safeDashboardReturnPath } from '@/lib/return-path';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const tenant = await requireDashboardTenant();
  if (!tenant.onboardingCompletedAt && !tenant.onboardingSkippedAt && ['owner', 'admin'].includes(tenant.role)) {
    const destination = safeDashboardReturnPath((await headers()).get(REQUEST_PATH_HEADER));
    if (!['/dashboard/billing', '/dashboard/preferences', '/dashboard/policies', '/dashboard/projects', '/dashboard/organization'].includes(new URL(destination, 'https://adport.invalid').pathname)) {
      redirect('/onboarding?return_to=' + encodeURIComponent(destination));
    }
  }
  const [pendingApprovals, entitlement, usage] = await Promise.all([
    countPendingOperations(tenant.organizationId),
    getOrganizationEntitlement(tenant.organizationId),
    getOrganizationUsage(tenant.organizationId),
  ]);
  return (
    <Shell tenant={{ organizationName: tenant.organizationName, userName: tenant.userName, email: tenant.email, role: tenant.role, projectSwitcher: <ProjectSwitcher projects={tenant.projects} currentProjectId={tenant.organizationId} />, planUsage: <SidebarPlanUsage plan={entitlement.plan} usage={usage} /> }} pendingApprovals={pendingApprovals}>
      {children}
      <ProductAnalytics key={`${tenant.userId}:${tenant.organizationId}`} />
    </Shell>
  );
}
