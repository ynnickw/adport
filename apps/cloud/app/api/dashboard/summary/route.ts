import { sessionPrincipal } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { apiError, noStoreJson } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const organizationId = new URL(request.url).searchParams.get('organization_id') ?? undefined;
    const principal = await sessionPrincipal(organizationId);
    const runtime = await createTenantRuntime(principal);
    const [accountsResult, reportResult] = await Promise.all([
      runtime.registry.call('accounts_list', {}, runtime.ctx),
      runtime.registry.call('report', {
        level: 'campaign', metrics: ['spend', 'clicks', 'conversions', 'roas'], date_range: 'last_7_days', limit: 100,
      }, runtime.ctx),
    ]) as [{ accounts: unknown[] }, { rows: unknown[]; truncated: boolean }];
    return noStoreJson({ accounts: accountsResult.accounts, rows: reportResult.rows, truncated: reportResult.truncated });
  } catch (error) {
    return apiError(error, 400);
  }
}
