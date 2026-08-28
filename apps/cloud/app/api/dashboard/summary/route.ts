import { sessionPrincipal } from '@/lib/cloud/auth';
import { readReport } from '@/lib/cloud/reads';
import { apiError, HttpError, noStoreJson } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const organizationId = new URL(request.url).searchParams.get('organization_id') ?? undefined;
    const principal = await sessionPrincipal(organizationId);
    const reportResult = await readReport(principal, 'last_7_days');
    if (!reportResult.ok) throw new HttpError(reportResult.error, 400);
    return noStoreJson({
      rows: reportResult.data.rows,
      truncated: reportResult.data.truncated,
      warnings: reportResult.warnings,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required.') return apiError(error, 401);
    return apiError(error instanceof HttpError ? error : new HttpError('Unable to read provider data.', 400), 400);
  }
}
