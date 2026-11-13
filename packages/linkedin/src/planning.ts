import { AdportError, defineTool, planningViewSchema, type AnyToolDefinition, type PlanningView } from '@adport/core';
import { z } from 'zod';
import type { LinkedInAdsClient, RestliValue } from './client.js';
import { decimalToMicros, microsToDecimal, type LinkedInAdsProvider } from './provider.js';
import { linkedinId, moneySchema, NON_DISCRIMINATION_NOTICE, targetingSchema } from './schemas.js';

const micros = z.number().int().positive().safe(), timestamp = z.number().int().positive().safe().max(8_640_000_000_000_000);
const bidType = z.enum(['CPM', 'CPC', 'CPV']);
// Planning API codes differ from campaign creation (for example WEBSITE_VISIT).
const objective = z.enum(['VIDEO_VIEW', 'LEAD_GENERATION', 'WEBSITE_CONVERSION', 'BRAND_AWARENESS', 'WEBSITE_VISIT', 'ENGAGEMENT', 'WEBSITE_TRAFFIC', 'CREATIVE_ENGAGEMENT', 'JOB_APPLICATION', 'JOB_APPLICANT', 'TALENT_LEAD']);
const optimization = z.enum(['NONE', 'MAX_IMPRESSION', 'MAX_CLICK', 'MAX_CONVERSION', 'ENHANCED_CONVERSION', 'MAX_VIDEO_VIEW', 'MAX_LEAD', 'MAX_QUALIFIED_LEAD', 'TARGET_COST_PER_CLICK', 'TARGET_COST_PER_IMPRESSION', 'TARGET_COST_PER_VIDEO_VIEW', 'CAP_COST_AND_MAXIMIZE_CLICKS', 'CAP_COST_AND_MAXIMIZE_IMPRESSIONS', 'CAP_COST_AND_MAXIMIZE_VIDEO_VIEWS', 'CAP_COST_AND_MAXIMIZE_LEADS']);
const base = { account_id: linkedinId, targeting_criteria: targetingSchema, objective_type: objective.optional() };
export const pricingInput = z.object({ ...base, campaign_type: z.enum(['TEXT_AD', 'SPONSORED_UPDATES', 'SPONSORED_INMAILS']), bid_type: bidType, match_type: z.enum(['EXACT', 'AUDIENCE_EXPANDED']).default('EXACT'), country_code: z.string().regex(/^[a-z]{2}$/).optional(), daily_budget_micros: micros.optional(), optimization_target_type: z.enum([...optimization.options, 'AWARENESS', 'WEBSITE_VISIT']).optional() });
export const forecastInput = z.object({ ...base, campaign_type: z.enum(['SPONSORED_UPDATES', 'SPONSORED_INMAILS', 'DYNAMIC']), campaign_id: linkedinId.optional(), creative_type: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100).optional(), time_range: z.object({ start: timestamp, end: timestamp }).refine(v => v.end > v.start, 'End must follow start'), daily_budget_micros: micros.optional(), total_budget_micros: micros.optional(), competing_bid: z.object({ bid_type: bidType, bid_micros: micros }).optional(), optimization_target: optimization.default('NONE'), target_cost_micros: micros.optional(), cost_cap_micros: micros.optional(), enable_audience_network: z.boolean().default(false), enable_audience_expansion: z.boolean().default(false), connected_television_only: z.boolean().default(false) }).superRefine((v, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.daily_budget_micros === undefined && v.total_budget_micros === undefined) error('Supply a daily or total budget');
  const manual = ['NONE', 'ENHANCED_CONVERSION'].includes(v.optimization_target), targetCost = v.optimization_target.startsWith('TARGET_COST_'), costCap = v.optimization_target.startsWith('CAP_COST_');
  if (manual !== Boolean(v.competing_bid)) error('Manual forecasting requires competing_bid; auto/target/cap forecasts omit it');
  if (targetCost !== (v.target_cost_micros !== undefined)) error('target_cost_micros is required only for TARGET_COST bidding');
  if (costCap !== (v.cost_cap_micros !== undefined)) error('cost_cap_micros is required only for CAP_COST bidding');
  if (v.connected_television_only && (v.campaign_type !== 'SPONSORED_UPDATES' || !v.enable_audience_network)) error('Connected television requires SPONSORED_UPDATES and explicit audience-network inclusion');
});
const paging = z.object({ start: z.number().int().nonnegative(), count: z.number().int().nonnegative(), total: z.number().int().nonnegative().optional(), links: z.array(z.looseObject({ rel: z.string() })).optional() }).optional();
const money = moneySchema.safeExtend({ amount: moneySchema.shape.amount.max(100) });
const moneyRange = z.object({ min: money.nullish(), max: money.nullish(), default: money.nullish() });
const pricingRow = z.looseObject({ bidLimits: moneyRange.optional(), dailyBudgetLimits: moneyRange.optional(), suggestedBid: moneyRange.optional() });
const pricingResponse = z.object({ elements: z.array(pricingRow).max(100), paging });
const numeric = z.number().nonnegative();
const point = z.object({ timestamp, value: numeric.nullish(), adForecastRange: z.object({ lowEnd: numeric.nullish(), highEnd: numeric.nullish() }).optional() });
const forecastRow = z.looseObject({ metricType: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(120), granularity: z.enum(['DAILY', 'SEVEN_DAY', 'THIRTY_DAY', 'CUSTOM']), timeSeries: z.array(point).max(10_000) });
const forecastResponse = z.object({ elements: z.array(forecastRow).max(128), paging });
const output = { account_id: linkedinId, currency: z.string().regex(/^[A-Z]{3}$/), truncated: z.boolean(), planning: planningViewSchema };
const pricingOutput = pricingResponse.safeExtend({ ...output, request: pricingInput }), forecastOutput = forecastResponse.safeExtend({ ...output, request: forecastInput });
const partial = (value: { elements: unknown[]; paging?: z.infer<typeof paging> }) => Boolean(value.paging && value.paging.start > 0 || value.paging?.links?.some(link => link.rel === 'next')) || (value.paging?.total !== undefined && (value.paging.start + value.elements.length < value.paging.total));
const exactMoneyCompare = (a: string, b: string) => { const [aw, af = ''] = a.split('.'), [bw, bf = ''] = b.split('.'), length = Math.max(af.length, bf.length); const av = BigInt(aw! + af.padEnd(length, '0')), bv = BigInt(bw! + bf.padEnd(length, '0')); return av < bv ? -1 : av > bv ? 1 : 0; };
const formatPoint = (value: number | null | undefined) => value == null ? null : String(value);
const countMetrics = new Set(['IMPRESSION', 'CLICK', 'VIDEO_VIEW', 'LEAD', 'SPONSORED_INMAIL_SEND', 'CONVERSION', 'REACH']);
function unit(metric: string, currency: string) {
  if (['SPENDING', 'MAX_POTENTIAL_BUDGET'].includes(metric)) return `${currency} currency units`;
  if (/^COST_PER_MILLION_(IMPRESSIONS|CLICKS|VIEWS|LEADS|REACHES|MESSAGE_SENDS)$/.test(metric)) return `${currency} per 1,000,000 ${metric.slice('COST_PER_MILLION_'.length).toLowerCase().replaceAll('_', ' ')}`;
  if (/^(CLICK|VIDEO_VIEW|LEAD|REACH)_PER_MILLION_IMPRESSIONS$/.test(metric)) return `${metric.split('_PER_')[0]} per 1,000,000 impressions`;
  return countMetrics.has(metric) ? 'count' : 'native unit not documented';
}

/** LinkedIn Marketing202608 pricing/forecast contracts reviewed 2026-11-04. */
export class LinkedInPlanningService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider) {}
  private money(value: number, currency: string) { return { amount: microsToDecimal(value), currencyCode: currency }; }
  async pricing(raw: z.input<typeof pricingInput>) {
    const input = pricingInput.parse(raw), account = await this.provider.getAccount(input.account_id);
    const result = await this.client.get('adBudgetPricing', pricingResponse, { q: 'criteriaV2', account: `urn:li:sponsoredAccount:${input.account_id}`, campaignType: input.campaign_type, bidType: input.bid_type, currency: account.currency, matchType: input.match_type, targetingCriteria: input.targeting_criteria, ...(input.country_code ? { countryCode: input.country_code } : {}), ...(input.daily_budget_micros ? { dailyBudget: this.money(input.daily_budget_micros, account.currency) } : {}), ...(input.objective_type ? { objectiveType: input.objective_type } : {}), ...(input.optimization_target_type ? { optimizationTargetType: input.optimization_target_type } : {}) });
    const rows: PlanningView['rows'] = [], notes = ['Native pricing estimates, not observed results, budget changes or a campaign-creation validation. No campaign, bid, budget or delivery setting was changed.', input.campaign_type === 'SPONSORED_UPDATES' ? 'For Sponsored Updates, a bid below bidLimits.min can mean poor delivery; it is not universally a hard rejection threshold.' : 'For formats other than Sponsored Updates, LinkedIn documents bidLimits.min as a minimum allowable bid.'];
    for (const [index, entry] of result.elements.entries()) for (const [field, label] of [['bidLimits', 'Bid limits'], ['dailyBudgetLimits', 'Daily budget limits'], ['suggestedBid', 'Suggested bid']] as const) {
      const range = entry[field]; if (!range) continue;
      for (const item of [range.min, range.max, range.default]) if (item && item.currencyCode !== account.currency) throw new AdportError('PROVIDER_ERROR', 'linkedin: pricing returned a foreign currency');
      if (range.min && range.max && exactMoneyCompare(range.min.amount, range.max.amount) > 0 || range.default && range.min && exactMoneyCompare(range.default.amount, range.min.amount) < 0 || range.default && range.max && exactMoneyCompare(range.default.amount, range.max.amount) > 0) throw new AdportError('PROVIDER_ERROR', 'linkedin: pricing returned inverted bounds or a default outside its range');
      const basis = field === 'dailyBudgetLimits' ? 'per day' : input.bid_type === 'CPM' ? 'per 1,000 impressions' : input.bid_type === 'CPC' ? 'per click' : 'per video view';
      rows.push({ result: String(index + 1), metric: label, minimum: range.min?.amount ?? null, suggested: range.default?.amount ?? null, maximum: range.max?.amount ?? null, unit: `${account.currency} ${basis}` });
      for (const item of [range.min, range.max, range.default]) if (item) { try { decimalToMicros(item.amount); } catch { if (!notes.some(note => note.startsWith('Some native'))) notes.push('Some native decimal amounts cannot be represented as safe integer micros. Exact native decimal strings are preserved; no rounding is performed.'); } }
    }
    const truncated = partial(result); if (truncated) notes.push('The native response indicates incomplete results; no undocumented continuation request was made.');
    if (!rows.length) notes.push('LinkedIn returned no pricing amounts for this selection. Missing values remain unavailable.');
    notes.push(`Selection: ${input.campaign_type}; ${input.bid_type}; ${input.match_type}${input.objective_type ? `; ${input.objective_type}` : ''}. Missing amounts remain unavailable.`);
    return { ...result, request: input, account_id: input.account_id, currency: account.currency, truncated, planning: { title: 'LinkedIn bid and budget pricing', columns: [...(result.elements.length > 1 ? [{ key: 'result', label: 'Native result' }] : []), { key: 'metric', label: 'Pricing' }, { key: 'minimum', label: 'Minimum' }, { key: 'suggested', label: 'Default / suggested' }, { key: 'maximum', label: 'Maximum' }, { key: 'unit', label: 'Unit' }], rows, notes } };
  }
  async forecast(raw: z.input<typeof forecastInput>) {
    const input = forecastInput.parse(raw);
    if (input.time_range.start <= Date.now()) throw new AdportError('INVALID_INPUT', 'linkedin: forecast start must be after the current UTC time');
    const account = await this.provider.getAccount(input.account_id);
    if (input.campaign_id) await this.provider.getCampaign(input.account_id, input.campaign_id);
    const params: Record<string, RestliValue> = { q: 'criteriaV2', account: `urn:li:sponsoredAccount:${input.account_id}`, campaignType: input.campaign_type, timeRange: input.time_range, targetingCriteria: input.targeting_criteria, optimizationTarget: input.optimization_target, enableAudienceNetwork: String(input.enable_audience_network), enableAudienceExpansion: String(input.enable_audience_expansion), connectedTelevisionOnly: String(input.connected_television_only), ...(input.objective_type ? { objectiveType: input.objective_type } : {}), ...(input.creative_type ? { creativeType: input.creative_type } : {}), ...(input.campaign_id ? { campaign: `urn:li:sponsoredCampaign:${input.campaign_id}` } : {}), ...(input.daily_budget_micros ? { dailyBudget: this.money(input.daily_budget_micros, account.currency) } : {}), ...(input.total_budget_micros ? { totalBudget: this.money(input.total_budget_micros, account.currency) } : {}), ...(input.competing_bid ? { competingBid: { bidType: input.competing_bid.bid_type, bidPrice: this.money(input.competing_bid.bid_micros, account.currency) } } : {}), ...(input.target_cost_micros ? { targetCost: microsToDecimal(input.target_cost_micros) } : {}), ...(input.cost_cap_micros ? { costCap: microsToDecimal(input.cost_cap_micros) } : {}) };
    const result = await this.client.get('adSupplyForecasts', forecastResponse, params), rows: PlanningView['rows'] = [], seen = new Set<string>();
    for (const entry of result.elements) for (const point of entry.timeSeries) {
      const key = `${entry.metricType}:${entry.granularity}:${point.timestamp}`;
      if (seen.has(key)) throw new AdportError('PROVIDER_ERROR', 'linkedin: forecast repeated a metric/granularity/timestamp'); seen.add(key);
      const low = point.adForecastRange?.lowEnd, high = point.adForecastRange?.highEnd;
      if (low != null && high != null && low > high) throw new AdportError('PROVIDER_ERROR', 'linkedin: forecast returned inverted bounds');
      rows.push({ metric: entry.metricType, period: entry.granularity, timestamp: new Date(point.timestamp).toISOString(), value: formatPoint(point.value), low: formatPoint(low), high: formatPoint(high), unit: unit(entry.metricType, account.currency) });
      if (rows.length > 50_000) throw new AdportError('PROVIDER_ERROR', 'linkedin: native forecast exceeded the supported presentation size');
    }
    const truncated = partial(result), notes = ['Hypothetical native estimates with uncertainty, not observed performance or a campaign-creation validation. No campaign, ad, bid, budget, audience or delivery setting was changed.', 'DAILY, SEVEN_DAY, THIRTY_DAY and CUSTOM periods can overlap; do not add them together. Timestamp is the native period start in UTC, not an end date.', 'Per-million metrics retain their native scaling. Divide COST_PER_MILLION_* by 1,000,000 for cost per result; divide *_PER_MILLION_IMPRESSIONS by 1,000,000 for the corresponding ratio. These are not automatically CTR percentages or CPM.', 'Missing point estimates or bounds remain unavailable. Native maximum forecast horizon, campaign eligibility and objective/format combinations are validated by LinkedIn.'];
    if (truncated) notes.push('The native response indicates incomplete results; no undocumented continuation request was made.');
    if (!rows.length) notes.push('LinkedIn returned no forecast points for this selection.');
    notes.push(`Requested UTC range: ${new Date(input.time_range.start).toISOString()} inclusive to ${new Date(input.time_range.end).toISOString()} exclusive. ${input.campaign_type}; ${input.optimization_target}.`);
    notes.push('LinkedIn documents daily forecast spending up to 1.2 times the daily budget. A total budget can exhaust before the forecast range ends, leaving later periods at zero.');
    return { ...result, request: input, account_id: input.account_id, currency: account.currency, truncated, planning: { title: 'LinkedIn supply forecast', columns: [{ key: 'metric', label: 'Metric' }, { key: 'period', label: 'Period' }, { key: 'timestamp', label: 'Starts (UTC)' }, { key: 'value', label: 'Estimate' }, { key: 'low', label: 'Low' }, { key: 'high', label: 'High' }, { key: 'unit', label: 'Native unit' }], rows, notes } };
  }
}

export function linkedinPlanningTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'linkedin_budget_pricing', namespace: 'linkedin', description: `Read native bid limits, suggested bids and daily budget limits for targeting, bid type and campaign format. Uses actual account currency and exact decimal results; does not validate campaign creation or change money/delivery. Planning objective/optimization codes are native, not campaign-create aliases. ${NON_DISCRIMINATION_NOTICE}`, input: pricingInput, output: pricingOutput, presentation: 'planning', annotations: { readOnly: true }, handler: input => provider.planning.pricing(input) }),
    defineTool({ name: 'linkedin_supply_forecast', namespace: 'linkedin', description: 'Read hypothetical supply/spend/response estimates and native uncertainty bounds for a future UTC range. Choose manual bid or auto/target/cap mode; budget/bid inputs are integer account-currency micros. Preserves per-million units and overlapping native periods. Does not create, activate or validate a campaign.', input: forecastInput, output: forecastOutput, presentation: 'planning', annotations: { readOnly: true }, handler: input => provider.planning.forecast(input) }),
  ];
}
