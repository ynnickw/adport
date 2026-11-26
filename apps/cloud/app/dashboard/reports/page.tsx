import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { readReport } from '@/lib/cloud/reads';
import { parseCampaignRange } from './range';
import { CampaignReport } from './report-view';

export const metadata = { title: 'Reports' };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const [tenant, params] = await Promise.all([requireDashboardTenant(), searchParams]);
  const { range, warning } = parseCampaignRange(params);
  const result = await readReport({ organizationId: tenant.organizationId, userId: tenant.userId, role: tenant.role, scopes: ['tools:read'] }, range);
  return <CampaignReport key={tenant.organizationId} range={range} rangeWarning={warning}
    result={result.ok ? { ...result, data: { rows: result.data.rows, truncated: result.data.truncated } } : result} />;
}
