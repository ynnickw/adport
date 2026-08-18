import { requireTenant } from '@/lib/auth';
import { Shell } from '@/components/shell';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const tenant = await requireTenant();
  return <Shell tenant={tenant}>{children}</Shell>;
}
