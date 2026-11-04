import { AdportError } from './errors.js';
import { resolveDateRange, type DatePreset, type DateRange } from './model.js';

/** Each daily observation comes from a provider read scoped to that exact date. */
export function reportPeriods(range: DateRange | DatePreset, granularity: 'total' | 'day'): DateRange[] {
  const resolved = resolveDateRange(range);
  const valid = (value: string) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!valid(resolved.start) || !valid(resolved.end) || resolved.start > resolved.end) {
    throw new AdportError('INVALID_INPUT', 'Choose a valid inclusive report date range.');
  }
  if (granularity === 'total') return [resolved];
  const days = (Date.parse(resolved.end) - Date.parse(resolved.start)) / 86_400_000 + 1;
  if (days > 31) throw new AdportError('INVALID_INPUT', 'Daily reports are limited to 31 days per request. Choose a shorter date range.');
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(Date.parse(resolved.start) + index * 86_400_000).toISOString().slice(0, 10);
    return { start: day, end: day };
  });
}
