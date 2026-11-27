import { AdportError, isMatomoBlockedModule, matomoSegmentNamesVisitor, matomoReportMetadataSchema, matomoReportSchema,
  type AdProvider, type Account, type NormalizedQuery, type Report, type WriteOperation, type WritePreview, type WriteResult,
  type MatomoReportInput, type MatomoReportMetadataInput } from '@adport/core';
import type { MatomoClient } from './client.js';

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
const scalar = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : object(value) ? Object.values(value) : [];
// Row metadata that Matomo can mix into processed rows; not a metric.
const ROW_METADATA = new Set(['label', 'idsubdatatable', 'segment', 'url', 'logo', 'logoWidth', 'logoHeight', 'logoHeigth', 'html_label_prefix', 'html_label_suffix']);

export function matomoSiteId(value: unknown): string {
  const id = text(value);
  if (!id || !/^[1-9]\d{0,9}$/.test(id)) throw new AdportError('PROVIDER_ERROR', 'Matomo returned an invalid site ID.');
  return id;
}

type MultiPeriod = 'day' | 'week' | 'month' | 'year';
/**
 * ISO start date (YYYY-MM-DD) of every period Matomo returns for date=start,end, in order.
 * Matomo keys multi-period results by localized labels ("week October 26 – November 1, 2026"),
 * so dates are derived here: weeks start on Monday, months and years on their first day.
 */
export function matomoPeriodStarts(period: MultiPeriod, start: string, end: string): string[] {
  const date = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`);
  if (period === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (period === 'month' || period === 'year') date.setUTCDate(1);
  if (period === 'year') date.setUTCMonth(0);
  const starts: string[] = [];
  while (date <= last && starts.length < 1000) {
    starts.push(date.toISOString().slice(0, 10));
    if (period === 'day') date.setUTCDate(date.getUTCDate() + 1);
    else if (period === 'week') date.setUTCDate(date.getUTCDate() + 7);
    else if (period === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
    else date.setUTCFullYear(date.getUTCFullYear() + 1);
  }
  return starts;
}

export interface MatomoSite {
  id: string; name: string; main_url?: string; timezone?: string; currency?: string;
  ecommerce: boolean; site_search: boolean; type?: string; created?: string;
}
function toSite(raw: Row): MatomoSite {
  return { id: matomoSiteId(raw.idsite), name: text(raw.name) ?? `Site ${text(raw.idsite)}`, main_url: text(raw.main_url),
    timezone: text(raw.timezone), currency: text(raw.currency), ecommerce: Number(raw.ecommerce) === 1, site_search: Number(raw.sitesearch) === 1,
    type: text(raw.type), created: text(raw.ts_created) };
}

/** Read-only Matomo analytics. Visitor-level and cross-site APIs (Live, UserId, MultiSites) are never called. */
export class MatomoProvider implements AdProvider {
  readonly id = 'matomo';
  constructor(private readonly client: MatomoClient) {}
  capabilities() { return { serverDryRun: false, reporting: false }; }
  async report(_query: NormalizedQuery): Promise<Report> { throw new AdportError('INVALID_INPUT', 'Use matomo_report for Matomo reports.'); }
  async previewWrite(_op: WriteOperation): Promise<WritePreview> { throw new AdportError('POLICY_VIOLATION', 'This analytics integration is read-only.'); }
  async applyWrite(_op: WriteOperation): Promise<WriteResult> { throw new AdportError('POLICY_VIOLATION', 'This analytics integration is read-only.'); }

  async listAccounts(): Promise<Account[]> {
    const sites = list(await this.client.call('SitesManager.getSitesWithAtLeastViewAccess')).filter(object).map(toSite);
    return sites.map(site => ({ provider: this.id, id: site.id, name: site.name,
      ...(site.currency ? { currency: site.currency } : {}), ...(site.timezone ? { timezone: site.timezone } : {}) }));
  }

  async site(accountId: string): Promise<MatomoSite> {
    const id = matomoSiteId(accountId);
    const raw = await this.client.call('SitesManager.getSiteFromId', { idSite: id });
    if (!object(raw)) throw new AdportError('PROVIDER_ERROR', 'Matomo returned no site settings.');
    const site = toSite(raw);
    if (site.id !== id) throw new AdportError('PROVIDER_ERROR', 'Matomo returned settings for a different site.');
    return site;
  }

  async reportMetadata(input: MatomoReportMetadataInput) {
    const i = matomoReportMetadataSchema.parse(input);
    const raw = await this.client.call('API.getReportMetadata', { idSites: i.account_id, idSite: i.account_id, hideMetricsDoc: '1' });
    const reports = list(raw).filter(object)
      .filter(r => !isMatomoBlockedModule(r.module) && (!i.module || r.module === i.module))
      .map(r => ({ module: text(r.module), action: text(r.action), name: text(r.name), category: text(r.category), subcategory: text(r.subcategory),
        ...(text(r.dimension) ? { dimension: text(r.dimension) } : {}),
        metrics: object(r.metrics) ? r.metrics : {}, ...(object(r.processedMetrics) ? { processed_metrics: r.processedMetrics } : {}),
        has_goal_metrics: object(r.metricsGoal) || object(r.processedMetricsGoal),
        ...(object(r.parameters) ? { parameters: r.parameters } : {}) }));
    return { provider: this.id, account_id: i.account_id, reports, count: reports.length,
      notes: ['Pass module and action to matomo_report. Reports with parameters need them (for example id_goal for goal-specific reports).'] };
  }

  async processedReport(input: MatomoReportInput) {
    const i = matomoReportSchema.parse(input);
    const multi = i.period !== 'range';
    const flat = i.flat ?? i.module === 'Actions';
    const params: Record<string, string> = {
      idSite: i.account_id, apiModule: i.module, apiAction: i.action,
      period: multi ? i.period : i.start_date === i.end_date ? 'day' : 'range',
      date: multi || i.start_date !== i.end_date ? `${i.start_date},${i.end_date}` : i.start_date,
      filter_limit: String(i.limit + 1), filter_offset: String(i.offset), hideMetricsDoc: '1', showTimer: '0', format_metrics: '0',
      ...(i.segment ? { segment: i.segment } : {}), ...(i.id_goal !== undefined ? { idGoal: String(i.id_goal) } : {}),
      ...(flat ? { flat: '1' } : {}),
      ...(i.filter_sort_column ? { filter_sort_column: i.filter_sort_column } : {}), ...(i.filter_sort_order ? { filter_sort_order: i.filter_sort_order } : {}),
    };
    const [raw, site] = await Promise.all([this.client.call('API.getProcessedReport', params), this.site(i.account_id)]);
    if (!object(raw) || (!Array.isArray(raw.reportData) && !object(raw.reportData))) {
      throw new AdportError('PROVIDER_ERROR', 'Matomo returned an unexpected report response.');
    }
    const metadata = object(raw.metadata) ? raw.metadata : {};
    // Single periods return an array of rows (or one row object for reports without dimension); several periods
    // return an object keyed by localized period labels, in order. Only array-shaped data is pageable.
    type Group = { label?: string; date?: string; entries: unknown[]; pageable: boolean };
    const group = (value: unknown): Omit<Group, 'label' | 'date'> =>
      ({ entries: Array.isArray(value) ? value : object(value) ? [value] : [], pageable: Array.isArray(value) });
    const labels = multi && object(raw.reportData) ? Object.keys(raw.reportData) : undefined;
    const starts = multi ? matomoPeriodStarts(i.period as MultiPeriod, i.start_date, i.end_date) : [];
    const datesMatch = !!labels && labels.length === starts.length;
    const groups: Group[] = labels
      ? labels.map((label, index) => ({ label, ...(datesMatch ? { date: starts[index] } : {}), ...group((raw.reportData as Row)[label]) }))
      : [group(raw.reportData)];
    const rows = groups.flatMap(({ label, date, entries }) => entries.slice(0, i.limit).filter(object).map(row => ({
      dimensions: { ...(date ? { date } : {}), ...(label !== undefined ? { period_label: label } : {}), ...(row.label !== undefined ? { label: text(row.label) ?? '' } : {}) },
      metrics: Object.fromEntries(Object.entries(row).filter(([key, value]) => !ROW_METADATA.has(key) && scalar(value))),
    })));
    const full = groups.some(({ entries, pageable }) => pageable && entries.length > i.limit);
    const columns = object(raw.columns) ? raw.columns : {};
    return {
      provider: this.id, account_id: i.account_id,
      report: { module: i.module, action: i.action, name: text(metadata.name) ?? `${i.module}.${i.action}`, ...(text(metadata.dimension) ? { dimension: text(metadata.dimension) } : {}) },
      rows, totals: object(raw.reportTotal) ? raw.reportTotal : {},
      metric_labels: Object.fromEntries(Object.entries(columns).filter(([key]) => key !== 'label')),
      ...(object(metadata.metricTypes) ? { metric_types: metadata.metricTypes } : {}),
      row_count: rows.length, offset: i.offset, limit: i.limit,
      ...(full ? { next_offset: i.offset + i.limit, truncated: true } : {}),
      period: i.period, date_range: { start: i.start_date, end: i.end_date, timezone: site.timezone }, currency: site.currency,
      notes: [
        'Dates use the site time zone. Metrics are unformatted numbers: money in the site currency (major units), percent metrics as fractions (0.45 = 45%), duration_s metrics in seconds; see metric_types.',
        ...(multi ? [`Rows are per ${i.period}; dimensions.date is the ISO start date of each ${i.period} and period_label is Matomo's label. limit and offset apply to each period.`] : []),
        ...(labels && !datesMatch ? ['Matomo returned an unexpected number of periods, so rows carry period_label only.'] : []),
        ...(!multi && i.start_date !== i.end_date ? ['Custom ranges may be archived on demand and can be slow on large sites.'] : []),
        ...(i.segment ? ['Segmented data may be archived on demand or unavailable when browser archiving of segments is disabled.'] : []),
      ],
    };
  }

  async goals(accountId: string) {
    const id = matomoSiteId(accountId);
    const goals = list(await this.client.call('Goals.getGoals', { idSite: id })).filter(object).map(goal => ({
      id: text(goal.idgoal), name: text(goal.name), description: text(goal.description) || undefined,
      match_attribute: text(goal.match_attribute), pattern: text(goal.pattern), pattern_type: text(goal.pattern_type),
      revenue: goal.revenue, allow_multiple: Number(goal.allow_multiple) === 1, case_sensitive: Number(goal.case_sensitive) === 1,
    }));
    return { provider: this.id, account_id: id, goals, count: goals.length, notes: ['Goal revenue is the default value in the site currency.'] };
  }

  async segments(accountId: string) {
    const id = matomoSiteId(accountId);
    const stored = list(await this.client.call('SegmentEditor.getAll', { idSite: id })).filter(object);
    const segments = stored.filter(segment => typeof segment.definition === 'string' && !matomoSegmentNamesVisitor(segment.definition)).map(segment => ({
      id: text(segment.idsegment), name: text(segment.name), definition: text(segment.definition),
      all_sites: Number(segment.enable_only_idsite ?? 0) === 0, auto_archive: Number(segment.auto_archive) === 1,
    }));
    return { provider: this.id, account_id: id, segments, count: segments.length };
  }
}
