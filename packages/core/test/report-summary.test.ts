import { describe, expect, it } from 'vitest';
import { summarizeReport } from '../src/report-summary.js';
import type { ReportRow } from '../src/model.js';

const row = (metrics: ReportRow['metrics'], currency: string | undefined = 'EUR', accountId = 'one', provider = 'demo'): ReportRow => ({
  provider, accountId, currency, entity: { id: 'campaign', name: 'Synthetic', level: 'campaign' }, metrics,
});

describe('currency-separated report summaries', () => {
  it('provides the exact weighted ROAS that the real host card displays', () => {
    const result = summarizeReport([
      row({ spend: 91, clicks: 434, conversions: 21, roas: 504 / 91 }),
      row({ spend: 112, clicks: 553, conversions: 7, roas: 168 / 112 }),
      row({ spend: 133, clicks: 672, conversions: 35, roas: 840 / 133 }),
      row({ spend: 154, clicks: 791, conversions: 42, roas: 1008 / 154 }, 'USD', 'us'),
    ], true);
    expect(result).toMatchObject({ scope: 'returned_rows', complete: true });
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({ key: 'EUR', row_count: 3, metrics: { spend: 336, clicks: 1659, conversions: 63, conversion_value: null, roas: 4.5 }, roas_method: 'spend_weighted_reported_roas' });
    expect(result.groups[1]?.metrics.roas).toBeCloseTo(1008 / 154);
  });

  it('prefers actual conversion value over a rounded reported ratio', () => {
    expect(summarizeReport([row({ spend: 3, conversion_value: 10, roas: 3.33 })], true).groups[0]).toMatchObject({
      metrics: { conversion_value: 10, roas: 10 / 3 }, roas_method: 'conversion_value_over_spend',
    });
  });

  it('does not invent zeros or aggregate ratios with missing weights/returns', () => {
    const summary = summarizeReport([row({ spend: 100, clicks: 1, roas: 2 }), row({ spend: 50 })], false);
    expect(summary.complete).toBe(false);
    expect(summary.groups[0]?.metrics).toMatchObject({ spend: 150, clicks: null, conversions: null, roas: null });
    expect(summarizeReport([row({ roas: 2 })], true).groups[0]?.metrics.roas).toBeNull();
  });

  it('handles zero spend and non-finite values without non-finite JSON', () => {
    expect(summarizeReport([row({ spend: 0, conversion_value: 0 })], true).groups[0]?.metrics.roas).toBeNull();
    const result = summarizeReport([row({ spend: Number.MAX_VALUE, roas: Number.MAX_VALUE, clicks: NaN })], true);
    expect(result.groups[0]?.metrics.roas).toBeNull();
    expect(result.groups[0]?.metrics.clicks).toBeNull();
  });

  it('isolates unknown currencies by both provider and account', () => {
    const result = summarizeReport([
      row({ spend: 1 }, '', 'same', 'google'), row({ spend: 2 }, '', 'same', 'meta'),
      row({ spend: 3 }, 'invalid', 'other', 'google'), row({ spend: 4 }, 'EUR', 'known'),
    ], true);
    expect(result.groups).toHaveLength(4);
    expect(result.groups.map((g) => g.metrics.spend)).toEqual([1, 2, 3, 4]);
    expect(result.groups.slice(0, 3).every((g) => g.currency === null)).toBe(true);
  });

  it('returns no fictitious total for an empty result', () => {
    expect(summarizeReport([], true).groups).toEqual([]);
  });
});
