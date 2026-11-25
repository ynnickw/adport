import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listPendingOperations } from '@/lib/cloud/repository';
import { ApprovalQueue } from './approval-queue';

export const metadata = { title: 'Approvals' };

export default async function ApprovalsPage() {
  const tenant = await requireDashboardTenant();
  const pending = await listPendingOperations(tenant.organizationId);
  return <ApprovalQueue pending={pending} />;
}
