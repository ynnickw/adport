import { sessionPrincipal } from '@/lib/cloud/auth';
import { readAccounts, readReport } from '@/lib/cloud/reads';
import { apiError, HttpError, noStoreJson } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const organizationId = new URL(request.url).searchParams.get('organization_id') ?? undefined;
    const principal = await sessionPrincipal(organizationId);
    const [accountsResult, reportResult] = await Promise.all([
      readAccounts(principal),
      readReport(principal, 'last_7_days'),
    ]);
    if (!accountsResult.ok) throw new HttpError(accountsResult.error, 400);
    if (!reportResult.ok) throw new HttpError(reportResult.error, 400);
    return noStoreJson({
      accounts: accountsResult.data,
      rows: reportResult.data.rows,
      truncated: reportResult.data.truncated,
      warnings: [...accountsResult.warnings, ...reportResult.warnings]
        .filter((warning, index, all) => all.findIndex((value) => value.provider === warning.provider && value.message === warning.message) === index),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required.') return apiError(error, 401);
    return apiError(error instanceof HttpError ? error : new HttpError('Unable to read provider data.', 400), 400);
  }
}
