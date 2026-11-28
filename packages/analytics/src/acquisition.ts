import { AdportError, type AcquisitionAnalytics, type AcquisitionQuery, type AcquisitionReport, type AcquisitionRow, type AnalyticsGoal } from '@adport/core';
import type { AnalyticsClient, Resource } from './client.js';

export function propertyId(value: string): string {
  if (!/^\d{1,30}$/.test(value)) throw new AdportError('INVALID_INPUT', 'GA4 property IDs must be numeric.');
  return value;
}

type ReportData = {
  rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }>;
  rowCount?: number;
  metadata?: { currencyCode?: string; timeZone?: string; subjectToThresholding?: boolean; dataLossFromOtherRow?: boolean;
    samplingMetadatas?: unknown[]; schemaRestrictionResponse?: { activeMetricRestrictions?: Array<{ metricName: string }> } };
};

function recordQuality(data: ReportData, notes: Set<string>): boolean {
  const m = data.metadata;
  if (m?.subjectToThresholding) notes.add('GA4 privacy thresholds may omit rows.');
  if (m?.dataLossFromOtherRow) notes.add('GA4 grouped high-cardinality values into (other).');
  if (m?.samplingMetadatas?.length) notes.add('GA4 sampled this report.');
  if (m?.schemaRestrictionResponse?.activeMetricRestrictions?.length) notes.add('GA4 restricted one or more metrics for this user.');
  return Boolean(m?.subjectToThresholding || m?.dataLossFromOtherRow || m?.samplingMetadatas?.length);
}

function metric(data: ReportData, name: string, value?: string): number | null {
  if (data.metadata?.schemaRestrictionResponse?.activeMetricRestrictions?.some(r => r.metricName === name)) return null;
  const n = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export class Ga4Acquisition implements AcquisitionAnalytics {
  constructor(private readonly client: AnalyticsClient) {}

  async listGoals(accountId: string): Promise<AnalyticsGoal[]> {
    const path = `properties/${propertyId(accountId)}/keyEvents`;
    const goals: AnalyticsGoal[] = [], seen = new Set<string>();
    let token: string | undefined;
    do {
      const page = await this.client.request('admin', path, undefined, { pageSize: '200', ...(token ? { pageToken: token } : {}) });
      for (const event of (page.keyEvents ?? []) as Resource[]) {
        if (typeof event.name !== 'string' || !event.name.startsWith(path + '/') || !event.name.slice(path.length + 1)
          || typeof event.eventName !== 'string' || !event.eventName) throw new AdportError('PROVIDER_ERROR', 'GA4 returned an invalid key event.');
        goals.push({ id: event.name, name: event.eventName, ...(typeof event.countingMethod === 'string' ? { counting_method: event.countingMethod } : {}) });
      }
      token = page.nextPageToken as string | undefined;
      if (token && seen.has(token)) throw new AdportError('PROVIDER_ERROR', 'GA4 repeated a key event pagination token.');
      if (token) seen.add(token);
    } while (token);
    return goals;
  }

  async acquisitionReport(q: AcquisitionQuery): Promise<AcquisitionReport> {
    const property = propertyId(q.account_id);
    if (q.cursor && !/^(0|[1-9]\d{0,8})$/.test(q.cursor)) throw new AdportError('INVALID_INPUT', 'Invalid GA4 report cursor.');
    const offset = Number(q.cursor ?? 0);
    const goals = q.goal_ids ? await this.listGoals(property) : [];
    const selected = q.goal_ids?.map(id => {
      const goal = goals.find(g => g.id === id);
      if (!goal) throw new AdportError('INVALID_INPUT', 'A selected goal is missing from this property. Refresh analytics_goals.');
      return goal;
    });
    const dimensions = ['sessionSource', 'sessionMedium', 'sessionCampaignName', ...(q.landing_page ? ['landingPage'] : [])];
    const run = (fields: string[], metrics: string[], extra: Resource): Promise<ReportData> =>
      this.client.request('data', `properties/${property}:runReport`, {
        dimensions: fields.map(name => ({ name })), metrics: metrics.map(name => ({ name })),
        dateRanges: [{ startDate: q.start_date, endDate: q.end_date }], ...extra,
      });
    const base = await run(dimensions, ['sessions', 'keyEvents', 'purchaseRevenue'], {
      orderBys: dimensions.map(dimensionName => ({ dimension: { dimensionName, orderType: 'ALPHANUMERIC' } })),
      offset: String(offset), limit: String(q.limit),
    });
    const notes = new Set<string>();
    recordQuality(base, notes);
    const nativeRows = base.rows ?? [];
    const tuples = nativeRows.map(row => row.dimensionValues.map(cell => cell.value));
    const rows: AcquisitionRow[] = nativeRows.map((row, index) => {
      const tuple = tuples[index]!;
      if (tuple.length !== dimensions.length) throw new AdportError('PROVIDER_ERROR', 'GA4 returned incomplete acquisition dimensions.');
      const value = (i: number) => tuple[i] === '(not set)' || !tuple[i] ? null : tuple[i]!;
      return { dimensions: { source: value(0), medium: value(1), campaign: value(2), ...(q.landing_page ? { landing_page: value(3) } : {}) },
        metrics: { sessions: metric(base, 'sessions', row.metricValues[0]?.value), conversions: metric(base, 'keyEvents', row.metricValues[1]?.value),
          revenue: metric(base, 'purchaseRevenue', row.metricValues[2]?.value) } };
    });
    if (selected) {
      // Restrict the second read to the exact tuples on this page. Filtering the sessions read by event would lose nonconverting visits.
      const eventIds = new Map(selected.map(g => [g.name, g.id]));
      for (let from = 0; from < rows.length; from += 20) {
        const batch = tuples.slice(from, from + 20);
        const at = new Map(batch.map((tuple, i) => [JSON.stringify(tuple), from + i]));
        const groups = batch.map(tuple => ({ andGroup: { expressions: dimensions.map((fieldName, i) => ({
          filter: { fieldName, stringFilter: { matchType: 'EXACT', value: tuple[i], caseSensitive: true } },
        })) } }));
        const limit = batch.length * selected.length;
        const detail = await run([...dimensions, 'eventName'], ['keyEvents'], {
          dimensionFilter: { andGroup: { expressions: [
            { filter: { fieldName: 'eventName', inListFilter: { values: [...eventIds.keys()], caseSensitive: true } } },
            { orGroup: { expressions: groups } },
          ] } }, limit: String(limit),
        });
        if ((detail.rowCount ?? 0) > (detail.rows?.length ?? 0)) throw new AdportError('PROVIDER_ERROR', 'GA4 returned an incomplete goal breakdown.');
        const uncertain = recordQuality(detail, notes) || detail.metadata?.schemaRestrictionResponse?.activeMetricRestrictions?.some(r => r.metricName === 'keyEvents');
        for (const index of at.values()) rows[index]!.goal_counts = Object.fromEntries(selected.map(g => [g.id, uncertain || rows[index]!.metrics.conversions === null ? null : 0]));
        for (const row of detail.rows ?? []) {
          const values = row.dimensionValues.map(cell => cell.value);
          const id = eventIds.get(values.pop()!), index = at.get(JSON.stringify(values));
          if (id && index !== undefined) rows[index]!.goal_counts![id] = metric(detail, 'keyEvents', row.metricValues[0]?.value);
        }
        for (const index of at.values()) {
          const counts = Object.values(rows[index]!.goal_counts!);
          rows[index]!.metrics.conversions = counts.some(n => n === null) ? null : counts.reduce<number>((sum, n) => sum + n!, 0);
        }
      }
    }
    return { rows, ...(offset + rows.length < (base.rowCount ?? 0) && rows.length ? { next_cursor: String(offset + rows.length) } : {}),
      date_range: { start: q.start_date, end: q.end_date, timezone: base.metadata?.timeZone ?? null }, currency: base.metadata?.currencyCode ?? null,
      attribution: 'GA4 session acquisition, including manual UTMs and auto-tagged traffic.',
      revenue_basis: 'GA4 purchase revenue after refunds in property currency, across all goals.', notes: [...notes] };
  }
}
