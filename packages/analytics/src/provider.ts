import { AdportError, ga4ReportSchema, ga4RealtimeSchema, gscReportSchema, searchConsoleSite,
  type AdProvider, type Account, type NormalizedQuery, type Report, type WriteOperation,
  type WritePreview, type WriteResult, type Ga4ReportInput, type Ga4RealtimeInput, type GscReportInput } from '@adport/core';
import { AnalyticsClient, type Resource } from './client.js';

function propertyId(value: string): string {
  if (!/^\d+$/.test(value)) throw new AdportError('INVALID_INPUT', 'GA4 property IDs must be numeric.');
  return value;
}
abstract class ReadOnlyAnalytics implements AdProvider {
  abstract readonly id: string;
  abstract listAccounts(): Promise<Account[]>;
  capabilities() { return { serverDryRun: false, reporting: false }; }
  async report(_query: NormalizedQuery): Promise<Report> { throw new AdportError('INVALID_INPUT', `Use the ${this.id} reporting tools for analytics-specific dimensions and metrics.`); }
  async previewWrite(_op: WriteOperation): Promise<WritePreview> { throw new AdportError('POLICY_VIOLATION', 'This analytics integration is read-only.'); }
  async applyWrite(_op: WriteOperation): Promise<WriteResult> { throw new AdportError('POLICY_VIOLATION', 'This analytics integration is read-only.'); }
}

export class Ga4Provider extends ReadOnlyAnalytics {
  readonly id = 'ga4';
  constructor(private readonly client: AnalyticsClient) { super(); }
  async listAccounts(): Promise<Account[]> {
    const accounts = new Map<string, Account>(), seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const result = await this.client.request('admin', 'accountSummaries', undefined, { pageSize: '200', ...(pageToken ? { pageToken } : {}) });
      for (const account of (result.accountSummaries ?? []) as Array<{ displayName?: string; propertySummaries?: Array<{ property: string; displayName?: string }> }>) {
        for (const property of account.propertySummaries ?? []) {
          const id = propertyId(property.property.replace(/^properties\//, ''));
          accounts.set(id, { provider: this.id, id, name: [property.displayName ?? id, account.displayName].filter(Boolean).join(' — ') });
        }
      }
      pageToken = result.nextPageToken as string | undefined;
      if (pageToken && seen.has(pageToken)) throw new AdportError('PROVIDER_ERROR', 'GA4 repeated a property pagination token.');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return [...accounts.values()];
  }
  property(accountId: string) { return this.client.request('admin', `properties/${propertyId(accountId)}`); }
  metadata(accountId: string) { return this.client.request('data', `properties/${propertyId(accountId)}/metadata`); }
  async analyticsReport(input: Ga4ReportInput | Ga4RealtimeInput, realtime = false) {
    const i = realtime ? ga4RealtimeSchema.parse(input) : ga4ReportSchema.parse(input);
    const offset = realtime ? 0 : (i as Ga4ReportInput).offset;
    const filters = i.dimension_filters.map(filter => ({ filter: { fieldName: filter.field,
      stringFilter: { matchType: filter.match, value: filter.value, caseSensitive: filter.case_sensitive } } }));
    const body = {
      dimensions: i.dimensions.map(name => ({ name })), metrics: i.metrics.map(name => ({ name })),
      ...(!realtime ? { dateRanges: [{ startDate: (i as Ga4ReportInput).start_date, endDate: (i as Ga4ReportInput).end_date }] } : {}),
      ...(filters.length ? { dimensionFilter: filters.length === 1 ? filters[0] : { [i.filter_mode === 'and' ? 'andGroup' : 'orGroup']: { expressions: filters } } } : {}),
      limit: String(i.limit), ...(!realtime ? { offset: String(offset) } : {}), returnPropertyQuota: true,
    };
    const result = await this.client.request('data', `properties/${propertyId(i.account_id)}:${realtime ? 'runRealtimeReport' : 'runReport'}`, body);
    const dimensions = (result.dimensionHeaders ?? []) as Array<{ name: string }>;
    const metrics = (result.metricHeaders ?? []) as Array<{ name: string; type: string }>;
    const rows = ((result.rows ?? []) as Array<{ dimensionValues?: Array<{ value: string }>; metricValues?: Array<{ value: string }> }>).map(row => ({
      dimensions: Object.fromEntries(dimensions.map((d, index) => [d.name, row.dimensionValues?.[index]?.value ?? ''])),
      metrics: Object.fromEntries(metrics.map((m, index) => [m.name, row.metricValues?.[index]?.value ?? ''])),
    }));
    const rowCount = Number(result.rowCount ?? rows.length), metadata = result.metadata as Resource | undefined;
    return { provider: this.id, account_id: i.account_id, report_type: realtime ? 'realtime' : 'historical',
      rows, metric_headers: metrics, metadata, row_count: rowCount, offset, limit: i.limit,
      ...(!realtime && offset + rows.length < rowCount && rows.length ? { next_offset: offset + rows.length, truncated: true } : {}),
      notes: [realtime ? 'Realtime dimensions and metrics differ from historical reporting.' : 'Dates use the GA4 property reporting time zone.',
        ...(metadata?.subjectToThresholding ? ['Privacy thresholds may omit data.'] : []),
        ...(Array.isArray(metadata?.samplingMetadatas) && metadata.samplingMetadatas.length ? ['This report contains sampled data.'] : [])],
      property_quota: result.propertyQuota };
  }
}

export class SearchConsoleProvider extends ReadOnlyAnalytics {
  readonly id = 'gsc';
  constructor(private readonly client: AnalyticsClient) { super(); }
  private path(accountId: string) { return `sites/${encodeURIComponent(searchConsoleSite.parse(accountId))}`; }
  async listAccounts(): Promise<Account[]> {
    const result = await this.client.request('search', 'sites');
    return ((result.siteEntry ?? []) as Array<{ siteUrl: string; permissionLevel: string }>).filter(site => site.permissionLevel !== 'siteUnverifiedUser')
      .map(site => ({ provider: this.id, id: searchConsoleSite.parse(site.siteUrl), name: site.siteUrl, status: site.permissionLevel }));
  }
  site(accountId: string) { return this.client.request('search', this.path(accountId)); }
  sitemaps(accountId: string) { return this.client.request('search', `${this.path(accountId)}/sitemaps`); }
  inspectUrl(accountId: string, inspectionUrl: string) {
    return this.client.request('inspection', 'urlInspection/index:inspect', { siteUrl: searchConsoleSite.parse(accountId), inspectionUrl, languageCode: 'en-US' });
  }
  async searchAnalytics(input: GscReportInput) {
    const i = gscReportSchema.parse(input);
    const result = await this.client.request('search', `${this.path(i.account_id)}/searchAnalytics/query`, {
      startDate: i.start_date, endDate: i.end_date, dimensions: i.dimensions, type: i.type,
      ...(i.filters.length ? { dimensionFilterGroups: [{ groupType: 'and', filters: i.filters }] } : {}),
      aggregationType: i.aggregation_type, rowLimit: i.limit, startRow: i.start_row,
    });
    const rows = ((result.rows ?? []) as Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }>).map(row => ({
      dimensions: Object.fromEntries(i.dimensions.map((name, index) => [name, row.keys?.[index] ?? ''])),
      metrics: { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position },
    }));
    return { provider: this.id, account_id: i.account_id, rows, start_row: i.start_row, limit: i.limit,
      ...(rows.length === i.limit ? { next_start_row: i.start_row + rows.length, truncated: true } : {}),
      aggregation_type: result.responseAggregationType, date_range: { start: i.start_date, end: i.end_date, timezone: 'America/Los_Angeles' },
      notes: ['Organic Google Search data. The API returns top rows; privacy filtering and API limits can omit queries. CTR is a fraction; position is an average, not a total.'] };
  }
}
