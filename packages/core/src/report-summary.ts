import type { MetricName, ReportRow } from './model.js';

const additiveMetrics = ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value'] as const;
const available = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Summarize only returned rows; unknown currencies must stay account-scoped. */
export function summarizeReport(rows: ReportRow[], complete: boolean) {
  const groups = new Map<string, { currency: string | null; rows: ReportRow[] }>();
  for (const row of rows) {
    const currency = row.currency && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null;
    const key = currency || JSON.stringify([row.provider, row.accountId]);
    if (!groups.has(key)) groups.set(key, { currency, rows: [] });
    groups.get(key)!.rows.push(row);
  }
  return {
    scope: 'returned_rows' as const,
    complete,
    groups: [...groups].map(([key, group]) => {
      const total = (metric: MetricName): number | null => {
        if (!group.rows.every((row) => available(row.metrics[metric]))) return null;
        const value = group.rows.reduce((sum, row) => sum + row.metrics[metric]!, 0);
        return available(value) ? value : null;
      };
      const metrics = Object.fromEntries(additiveMetrics.map((metric) => [metric, total(metric)])) as Record<typeof additiveMetrics[number], number | null>;
      // Match the card: reconstruct returns from spend-weighted reported ROAS
      // only when conversion value is absent. Never average campaign ratios.
      const returns = group.rows.map(({ metrics: row }) => available(row.conversion_value)
        ? row.conversion_value
        : available(row.spend) && row.spend > 0 && available(row.roas) ? row.spend * row.roas : null);
      const value = returns.every(available) ? returns.reduce((sum, item) => sum + item, 0) : null;
      const roas = metrics.spend !== null && metrics.spend > 0 && value !== null ? value / metrics.spend : null;
      return {
        key,
        currency: group.currency,
        accounts: [...new Map(group.rows.map((row) => [JSON.stringify([row.provider, row.accountId]), { provider: row.provider, account_id: row.accountId }])).values()],
        row_count: group.rows.length,
        metrics: { ...metrics, roas: available(roas) ? roas : null },
        roas_method: !available(roas) ? null : metrics.conversion_value !== null ? 'conversion_value_over_spend' : 'spend_weighted_reported_roas',
      };
    }),
  };
}
