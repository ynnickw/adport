import { DATE_PRESETS, resolveDateRange, type DatePreset, type DateRange } from '@adport/core/dates';

export type OverviewRange = DatePreset | DateRange;
export const OVERVIEW_RANGE_OPTIONS = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' },
  { value: 'last_7_days', label: 'Last 7 days' }, { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'this_month', label: 'This month' }, { value: 'custom', label: 'Custom range' },
];

export function validateOverviewRange(range: OverviewRange, now = new Date()): DateRange {
  const resolved = resolveDateRange(range, now);
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(resolved.start) || !valid(resolved.end)) throw new Error('Choose a valid start and end date.');
  if (resolved.start > resolved.end) throw new Error('End date must be on or after the start date.');
  if (resolved.end > now.toISOString().slice(0, 10)) throw new Error('Choose dates up to today.');
  return resolved;
}

export function overviewRangeFromParams(params: URLSearchParams): OverviewRange {
  const range = params.get('range') ?? 'last_7_days';
  if (range === 'custom') {
    const custom = { start: params.get('from') ?? '', end: params.get('to') ?? '' };
    validateOverviewRange(custom);
    return custom;
  }
  if (!DATE_PRESETS.includes(range as DatePreset)) throw new Error('Choose a supported date range.');
  return range as DatePreset;
}

export function overviewRangeParams(range: OverviewRange): URLSearchParams {
  return new URLSearchParams(typeof range === 'string' ? { range } : { range: 'custom', from: range.start, to: range.end });
}

export function overviewRangeLabel(range: OverviewRange): string {
  if (typeof range === 'string') return OVERVIEW_RANGE_OPTIONS.find(option => option.value === range)?.label ?? 'Last 7 days';
  const format = (value: string) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
  return range.start === range.end ? format(range.start) : `${format(range.start)} – ${format(range.end)}`;
}
