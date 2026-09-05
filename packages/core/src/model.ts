export const METRICS = [
  'spend',
  'impressions',
  'clicks',
  'conversions',
  'conversion_value',
  'ctr',
  'cpc',
  'cpm',
  'cpa',
  'roas',
] as const;
export type MetricName = (typeof METRICS)[number];

export const ENTITY_LEVELS = ['account', 'campaign', 'ad_group', 'ad'] as const;
export type EntityLevel = (typeof ENTITY_LEVELS)[number];

export const DATE_PRESETS = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

/** ISO dates, inclusive on both ends. */
export interface DateRange {
  start: string;
  end: string;
}

export interface NormalizedQuery {
  /** Provider ids to query; omit for all connected providers. */
  providers?: string[];
  /** Account ids to include; omit for all accounts of the selected providers. */
  accountIds?: string[];
  level: EntityLevel;
  metrics: MetricName[];
  dateRange: DateRange | DatePreset;
  limit?: number;
}

export interface ReportRow {
  provider: string;
  accountId: string;
  /** Account currency; absent when the provider cannot supply it. Never infer FX. */
  currency?: string;
  entity: { level: EntityLevel; id: string; name: string; status?: string };
  metrics: Partial<Record<MetricName, number>>;
}

export interface Report {
  rows: ReportRow[];
  truncated?: boolean;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function resolveDateRange(range: DateRange | DatePreset, now = new Date()): DateRange {
  if (typeof range !== 'string') return range;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000);
  switch (range) {
    case 'today':
      return { start: iso(today), end: iso(today) };
    case 'yesterday':
      return { start: iso(daysAgo(1)), end: iso(daysAgo(1)) };
    case 'last_7_days':
      return { start: iso(daysAgo(7)), end: iso(daysAgo(1)) };
    case 'last_30_days':
      return { start: iso(daysAgo(30)), end: iso(daysAgo(1)) };
    case 'this_month':
      return { start: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), end: iso(today) };
  }
}

export function rangeDayCount(range: DateRange): number {
  const start = Date.parse(`${range.start}T00:00:00Z`);
  const end = Date.parse(`${range.end}T00:00:00Z`);
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}
