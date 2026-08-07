import type { Rule, RulePack } from '../types.js';

/** Active unless the status clearly says otherwise (provider vocabularies differ). */
function isActive(status?: string): boolean {
  return !/(PAUS|DISABLE|REMOV|DELET|CLOS|ARCHIV)/i.test(status ?? 'ENABLED');
}

const zeroConversionSpend: Rule = {
  id: 'zero-conversion-spend',
  title: 'Active campaign spending with zero conversions',
  description: 'Flags campaigns that spent above the threshold over the range without a single tracked conversion.',
  evaluate(ctx) {
    const minSpend = ctx.config.zero_conversion_min_spend!;
    return ctx.rows
      .filter((row) => isActive(row.entity.status))
      .filter((row) => (row.metrics.spend ?? 0) >= minSpend && (row.metrics.conversions ?? 0) === 0)
      .map((row) => ({
        entity: row.entity,
        severity: (row.metrics.spend ?? 0) >= minSpend * 3 ? ('critical' as const) : ('warn' as const),
        title: `"${row.entity.name}" spent ${row.metrics.spend} with 0 conversions`,
        detail:
          `Campaign ${row.entity.id} spent ${row.metrics.spend} between ${ctx.range.start} and ${ctx.range.end} ` +
          'without any tracked conversion. Either conversion tracking is broken or the spend is wasted.',
        recommendation:
          'Verify conversion tracking first; if tracking is correct, pause the campaign and rework targeting/creative.',
        proposedAction: ctx.actions.pauseCampaign?.(ctx.accountId, row.entity.id),
        metrics: row.metrics,
      }));
  },
};

const lowCtr: Rule = {
  id: 'low-ctr',
  title: 'High impressions with very low CTR',
  description: 'Flags campaigns whose creative/targeting is not resonating (lots of impressions, few clicks).',
  evaluate(ctx) {
    const minImpressions = ctx.config.low_ctr_min_impressions!;
    const threshold = ctx.config.low_ctr_threshold_pct!;
    return ctx.rows
      .filter((row) => isActive(row.entity.status))
      .filter((row) => (row.metrics.impressions ?? 0) >= minImpressions && (row.metrics.ctr ?? 100) < threshold)
      .map((row) => ({
        entity: row.entity,
        severity: 'warn' as const,
        title: `"${row.entity.name}" CTR ${row.metrics.ctr}% over ${row.metrics.impressions} impressions`,
        detail: `CTR is below ${threshold}% despite meaningful reach — the ad or audience likely needs work.`,
        recommendation: 'Review creative and audience targeting; test new headlines/assets before touching budgets.',
        metrics: row.metrics,
      }));
  },
};

const cpaOutlier: Rule = {
  id: 'cpa-outlier',
  title: 'Campaign CPA far above account median',
  description: 'Flags converting campaigns whose cost per conversion is a large multiple of the account median.',
  evaluate(ctx) {
    const multiplier = ctx.config.cpa_outlier_multiplier!;
    const converting = ctx.rows.filter((row) => (row.metrics.conversions ?? 0) > 0 && (row.metrics.cpa ?? 0) > 0);
    if (converting.length < 3) return [];
    const cpas = converting.map((row) => row.metrics.cpa!).sort((a, b) => a - b);
    const median = cpas[Math.floor(cpas.length / 2)]!;
    return converting
      .filter((row) => row.metrics.cpa! > median * multiplier)
      .map((row) => ({
        entity: row.entity,
        severity: 'warn' as const,
        title: `"${row.entity.name}" CPA ${row.metrics.cpa} vs account median ${median}`,
        detail: `Cost per conversion is more than ${multiplier}× the account median over the range.`,
        recommendation: 'Shift budget toward lower-CPA campaigns, or tighten targeting/bids here.',
        metrics: row.metrics,
      }));
  },
};

const negativeRoas: Rule = {
  id: 'negative-roas',
  title: 'Campaign returning less than it spends',
  description: 'Flags campaigns with tracked revenue whose ROAS is below break-even.',
  evaluate(ctx) {
    const minSpend = ctx.config.roas_min_spend!;
    return ctx.rows
      .filter((row) => isActive(row.entity.status))
      .filter(
        (row) =>
          (row.metrics.spend ?? 0) >= minSpend &&
          (row.metrics.conversion_value ?? 0) > 0 &&
          (row.metrics.roas ?? 0) < 1,
      )
      .map((row) => ({
        entity: row.entity,
        severity: 'warn' as const,
        title: `"${row.entity.name}" ROAS ${row.metrics.roas} (below break-even)`,
        detail: `Spent ${row.metrics.spend} for ${row.metrics.conversion_value} in tracked revenue over the range.`,
        recommendation: 'Check margins and attribution windows; consider bid/budget reduction or audience changes.',
        metrics: row.metrics,
      }));
  },
};

export const corePerformancePack: RulePack = {
  name: 'core-performance',
  version: '0.1.0',
  rules: [zeroConversionSpend, lowCtr, cpaOutlier, negativeRoas],
  defaults: {
    zero_conversion_min_spend: 50,
    low_ctr_min_impressions: 5000,
    low_ctr_threshold_pct: 0.5,
    cpa_outlier_multiplier: 2.5,
    roas_min_spend: 50,
  },
};
