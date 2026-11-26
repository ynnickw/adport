import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { AUDIT_FILTERS, decodeAuditCursor, listAuditEventPage } from '@/lib/cloud/audit-history';
import { AuditHistory } from './history-view';

export const metadata = { title: 'Audit log' };

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [tenant, params] = await Promise.all([requireDashboardTenant(), searchParams]);
  const filter = AUDIT_FILTERS.find(item => item.id === params.show) ?? AUDIT_FILTERS[0];
  const direction = params.older !== undefined && params.newer === undefined ? 'older' : params.newer !== undefined && params.older === undefined ? 'newer' : undefined;
  const position = direction && decodeAuditCursor(params[direction], tenant.organizationId, filter.id);
  const boundary = direction && position ? { direction, position } as const : undefined;
  const result = await listAuditEventPage(tenant.organizationId, filter.id, boundary);
  return <AuditHistory filter={filter} result={result} paged={Boolean(boundary)} />;
}
