import { sessionPrincipal } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { describeProviderError } from '@/lib/cloud/provider-errors';
import { apiError, HttpError, noStoreJson } from '@/lib/http';

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
    if (error instanceof Error && error.message === 'Authentication required.') return apiError(error, 401);
    return apiError(new HttpError(describeProviderError(error), 400), 400);
  }
}
