import { sessionPrincipal } from '@/lib/cloud/auth';
import { readReport } from '@/lib/cloud/reads';
import { apiError, HttpError, noStoreJson } from '@/lib/http';
import { overviewRangeFromParams, validateOverviewRange } from '@/lib/overview-range';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const organizationId = params.get('organization_id') ?? undefined;
    const principal = await sessionPrincipal(organizationId);
    let dateRange;
    try { dateRange = overviewRangeFromParams(params); validateOverviewRange(dateRange); }
    catch (error) { throw new HttpError(error instanceof Error ? error.message : 'Choose a valid date range.', 400); }
    const reportResult = await readReport(principal, dateRange);
    if (!reportResult.ok) throw new HttpError(reportResult.error, 400);
    return noStoreJson({
      rows: reportResult.data.rows,
      summary: reportResult.data.summary,
      truncated: reportResult.data.truncated,
      warnings: reportResult.warnings,
      date_range: dateRange,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required.') return apiError(error, 401);
    return apiError(error instanceof HttpError ? error : new HttpError('Unable to read provider data.', 400), 400);
  }
}
