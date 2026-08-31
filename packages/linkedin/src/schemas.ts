import { z } from 'zod';

export const linkedinId = z.string().regex(/^[1-9]\d*$/);
const numericId = z.number().int().positive().safe();
export const accountUrn = z.string().regex(/^urn:li:sponsoredAccount:[1-9]\d*$/);
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
export const moneySchema = z.object({ amount: decimal, currencyCode: z.string().regex(/^[A-Z]{3}$/) });
export const accountSchema = z.looseObject({ id: numericId, name: z.string(), currency: z.string().regex(/^[A-Z]{3}$/), status: z.string(), test: z.boolean().optional() });
export const campaignSchema = z.looseObject({ id: numericId, name: z.string(), account: accountUrn, status: z.string(), dailyBudget: moneySchema.optional(), totalBudget: moneySchema.optional(), campaignGroup: z.string().regex(/^urn:li:sponsoredCampaignGroup:[1-9]\d*$/).optional() });
export const groupSchema = z.looseObject({ id: numericId, name: z.string(), account: accountUrn, status: z.string(), budgetOptimization: z.looseObject({ budgetOptimizationStrategy: z.string().optional() }).optional() });
const date = z.object({ year: z.number().int(), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) });
export const reportRowSchema = z.looseObject({
  pivotValues: z.array(z.string()).length(1), dateRange: z.object({ start: date, end: date }),
  costInLocalCurrency: decimal.optional(), conversionValueInLocalCurrency: decimal.optional(),
  impressions: z.number().int().nonnegative().safe().optional(), clicks: z.number().int().nonnegative().safe().optional(), externalWebsiteConversions: z.number().int().nonnegative().safe().optional(),
});
export const NON_DISCRIMINATION_NOTICE = 'LinkedIn tools may not be used to discriminate based on personal characteristics such as gender, age, race, or ethnicity. Learn more: https://www.linkedin.com/legal/ads-policy';
export const NON_POLITICAL_CONSENT = 'I confirm this is not political advertising. None of my ads qualify as political advertising under the law of the targeted countries, including EU law for ads targeted to the EU.';
const facets = z.record(z.string().regex(/^urn:li:adTargetingFacet:[a-zA-Z]+$/), z.array(z.string().regex(/^urn:li:[a-zA-Z]+:[a-zA-Z0-9_()-]+$/)).min(1));
export const targetingSchema = z.object({ include: z.object({ and: z.array(z.object({ or: facets })).min(1) }), exclude: z.object({ or: facets }).optional() });
const micros = z.number().int().positive().safe();
export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200), campaign_group_id: linkedinId,
  type: z.enum(['TEXT_AD', 'SPONSORED_UPDATES', 'SPONSORED_INMAILS', 'DYNAMIC']),
  objective_type: z.enum(['BRAND_AWARENESS', 'ENGAGEMENT', 'JOB_APPLICANTS', 'LEAD_GENERATION', 'WEBSITE_CONVERSIONS', 'WEBSITE_VISITS', 'VIDEO_VIEWS']),
  cost_type: z.enum(['CPM', 'CPC', 'CPV']), unit_cost_micros: micros,
  daily_budget_micros: micros.optional(), total_budget_micros: micros.optional(),
  locale: z.object({ country: z.string().regex(/^[A-Z]{2}$/), language: z.string().regex(/^[a-z]{2}$/) }),
  targeting_criteria: targetingSchema,
  associated_entity: z.string().regex(/^urn:li:(organization|person):[a-zA-Z0-9_-]+$/).optional(),
  format: z.string().regex(/^[A-Z_]+$/).optional(),
  start_time: z.number().int().positive().safe().optional(), end_time: z.number().int().positive().safe().optional(),
  status: z.enum(['PAUSED', 'ACTIVE']).default('PAUSED'),
  non_political_consent: z.literal(true).describe(`Explicit advertiser confirmation required: ${NON_POLITICAL_CONSENT}`),
});
export const setStatusSchema = z.object({ campaign_id: linkedinId, status: z.enum(['PAUSED', 'ACTIVE']), non_political_consent: z.literal(true).optional().describe(`Required when activating: ${NON_POLITICAL_CONSENT}`) });
export const setBudgetSchema = z.object({ campaign_id: linkedinId, budget_type: z.enum(['DAILY', 'TOTAL']), budget_micros: micros });
