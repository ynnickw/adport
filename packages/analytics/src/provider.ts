import { AdportError, gscReportSchema, searchConsoleSite,
  type AdProvider, type Account, type NormalizedQuery, type Report, type WriteOperation,
  type WritePreview, type WriteResult, type GscReportInput } from '@adport/core';
import { Ga4Acquisition, propertyId } from './acquisition.js';
import { AnalyticsClient } from './client.js';

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
  readonly acquisitionAnalytics: Ga4Acquisition;
  constructor(private readonly client: AnalyticsClient) { super(); this.acquisitionAnalytics = new Ga4Acquisition(client); }
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
