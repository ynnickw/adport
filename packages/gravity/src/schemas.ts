import { z } from 'zod';

// Official Gravity advertiser Dashboard API contracts, reviewed 2026-11-27.
// Source URLs and normalization decisions: docs/providers/gravity.md.
export const gravityId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const gravityStatus = z.enum(['active', 'paused']);
/** Budgets are sent in dollars; micros must land on whole cents so the conversion is exact. */
export const gravityBudgetMicros = z.number().int().min(10_000).max(1_000_000_000_000).refine(value => value % 10_000 === 0, 'Use whole cents (multiples of 10,000 micros)');
const isoDateTime = z.iso.datetime({ offset: true });
const money = z.number().finite().nullable().optional();
const count = z.number().finite().nullable().optional();

export const advertiserSchema = z.looseObject({ advertiser_id: gravityId, name: z.string().nullable().optional() });
export type GravityAdvertiser = z.infer<typeof advertiserSchema>;

export const campaignSchema = z.looseObject({
  campaign_id: gravityId, name: z.string(), status: z.string(), is_active: z.boolean().optional(),
  daily_budget: money, total_budget: money, budget_type: z.string().nullable().optional(),
  landing_page: z.string().nullable().optional(), campaign_objective: z.string().nullable().optional(),
  billing_model: z.string().nullable().optional(), bid_strategy: z.string().nullable().optional(), conversion_type: z.string().nullable().optional(),
  delivery_status: z.string().nullable().optional(), delivery_issues: z.array(z.string()).nullable().optional(),
  start_time: z.string().nullable().optional(), end_time: z.string().nullable().optional(),
  impressions: count, clicks: count, spend: money, conversions: count, conversion_value: money,
});
export type GravityCampaign = z.infer<typeof campaignSchema>;
export const campaignListSchema = z.looseObject({ campaigns: z.array(campaignSchema) });

export const adSchema = z.looseObject({
  id: gravityId, ad_group_id: gravityId.optional(), campaign_id: gravityId.optional(), name: z.string().nullable().optional(),
  headline: z.string().nullable().optional(), status: z.string(), source: z.string().nullable().optional(), review_status: z.string().nullable().optional(),
  copy: z.string().nullable().optional(), cta: z.string().nullable().optional(), landing_page: z.string().nullable().optional(),
});
export const adGroupSchema = z.looseObject({
  id: gravityId, campaign_id: gravityId, name: z.string(), group_type: z.string().optional(), status: z.string(),
  ads: z.array(adSchema).optional(), ads_total: z.number().int().optional(),
});
export type GravityAdGroup = z.infer<typeof adGroupSchema>;

const totals = {
  total_impressions: count, total_clicks: count, total_spend: money, total_conversions: count, total_revenue: money,
};
export const metricsSchema = z.looseObject({ data: z.array(z.looseObject({ date: z.string() })), ...totals });
export const adGroupMetricsSchema = z.looseObject({
  ad_groups: z.array(z.looseObject({ ad_group_id: gravityId, campaign_id: gravityId, name: z.string(), status: z.string().nullable().optional(), ...totals })),
  total_ad_groups: z.number().int().nonnegative(), offset: z.number().int().nonnegative().optional(), truncated: z.boolean(),
});
export const adUnitMetricsSchema = z.looseObject({
  ad_units: z.array(z.looseObject({ ad_unit_id: gravityId, campaign_id: gravityId, name: z.string().nullable().optional(), data_source: z.string().optional(), ...totals })),
});
export type GravityTotals = { [K in keyof typeof totals]?: number | null };

export const conversionSchema = z.looseObject({
  conversion_id: z.string(), event_type: z.string(), value_cents: z.number().int().nullable().optional(), currency: z.string().nullable().optional(),
  conversion_timestamp: z.string(), campaign_id: z.string().nullable().optional(), source: z.string().nullable().optional(),
  is_attributed: z.boolean().optional(), attribution_type: z.string().nullable().optional(),
});
export const conversionPageSchema = z.looseObject({
  conversions: z.array(conversionSchema), has_more: z.boolean(), next_cursor: z.string().nullable().optional(),
  total_conversions: z.number().int().optional(), total_click_through_conversions: z.number().int().optional(), total_view_through_conversions: z.number().int().optional(),
});
export const billingSchema = z.looseObject({
  total_spend_dollars: z.number().finite(), total_billed_dollars: z.number().finite(), unbilled_dollars: z.number().finite(),
  credits_dollars: z.number().finite(), billing_enabled: z.boolean(),
});

export const listCampaignsSchema = z.object({ account_id: gravityId, status: z.enum(['active', 'paused', 'draft']).optional() });
export const listAdGroupsSchema = z.object({ account_id: gravityId, campaign_id: gravityId.optional(), include_archived: z.boolean().default(false) });
export const listConversionsSchema = z.object({
  account_id: gravityId, campaign_id: gravityId.optional(),
  event_type: z.string().min(1).max(100).optional().describe('For example purchase or lead'),
  attribution_type: z.enum(['click_through', 'view_through']).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export const billingInputSchema = z.object({ account_id: gravityId });
export const getAdSchema = z.object({ account_id: gravityId, ad_id: gravityId });
const webUrl = z.url({ protocol: /^https?$/ }).max(2000);
export const pixelSchema = z.object({
  pixel_id: gravityId, name: z.string(), url: webUrl, is_active: z.boolean(), is_functional: z.boolean().nullable(),
});
export const createPixelSchema = z.object({ url: webUrl, name: z.string().trim().min(1).max(255).optional() }).strict();
export const conversionStatsInput = z.object({
  account_id: gravityId, days: z.number().int().min(1).max(365).optional(),
  start_date: z.iso.date().optional(), end_date: z.iso.date().optional(), event_type: z.string().trim().min(1).max(100).optional(),
}).refine(input => {
  if (!input.start_date && !input.end_date) return true;
  return Boolean(!input.days && input.start_date && input.end_date && input.start_date <= input.end_date);
}, 'Supply days or an ordered start_date and end_date pair');
export const conversionStatsSchema = z.object({
  time_series: z.array(z.object({ date: z.string(), conversions: z.number().int().nonnegative() })),
  total: z.number().int().nonnegative(),
  by_event_type: z.array(z.object({ event_type: z.string(), total: z.number().int().nonnegative() })),
});

const countries = z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250).refine(ids => new Set(ids).size === ids.length, 'Use unique countries');
export const createCampaignSchema = z.object({
  name: z.string().min(1).max(255).refine(value => value.trim().length > 0, 'Name cannot be blank'),
  landing_page: webUrl,
  status: z.enum(['draft', 'paused', 'active']).default('draft'),
  campaign_objective: z.enum(['clicks', 'reach', 'conversions']),
  conversion_type: z.string().min(1).max(100).optional().describe('Conversion event, for example purchase; required for conversions'),
  daily_budget_micros: gravityBudgetMicros.optional(),
  total_budget_micros: gravityBudgetMicros.optional().describe('Total budget for the whole schedule; requires end_time'),
  start_time: isoDateTime.optional(),
  end_time: isoDateTime.optional(),
  allowed_countries: countries.optional(),
  allowed_devices: z.array(z.enum(['web', 'ios_app', 'android_app'])).min(1).max(3).refine(ids => new Set(ids).size === ids.length, 'Use unique devices').optional(),
  english_only: z.boolean().optional(),
  ad_group_name: z.string().min(1).max(500).optional().describe('Defaults to "<name> (Generative)"'),
  context: z.string().min(1).max(5000).describe('Target context of the generative ad group; Gravity writes the ads from it'),
  negative_context: z.string().min(1).max(5000).optional(),
  brand_name: z.string().min(1).max(500).optional().describe('Brand shown to users; defaults to the landing page host'),
}).strict()
  .refine(input => Number(input.daily_budget_micros !== undefined) + Number(input.total_budget_micros !== undefined) === 1, 'Set exactly one daily or total budget')
  .refine(input => input.total_budget_micros === undefined || input.end_time !== undefined, 'A total budget requires end_time')
  .refine(input => input.campaign_objective === 'conversions' ? Boolean(input.conversion_type) : true, 'A conversions campaign requires conversion_type')
  .refine(input => !input.start_time || !input.end_time || Date.parse(input.end_time) > Date.parse(input.start_time), 'end_time must be after start_time');
export const setCampaignStatusSchema = z.object({ campaign_id: gravityId, status: gravityStatus });
export const setAdGroupStatusSchema = z.object({ ad_group_id: gravityId, status: gravityStatus });
export const setAdStatusSchema = z.object({ ad_id: gravityId, status: gravityStatus });
export const createAdGroupSchema = z.object({
  campaign_id: gravityId, name: z.string().trim().min(1).max(500), group_type: z.enum(['generative', 'manual']),
  context: z.string().trim().min(1).max(5000).optional(), negative_context: z.string().trim().min(1).max(5000).optional(),
  brand_name: z.string().trim().min(1).max(500).optional(), landing_page: webUrl.optional(), image_url: webUrl.optional(),
  allowed_countries: countries.optional(), status: gravityStatus.default('paused'),
}).strict().refine(input => input.group_type === 'manual' || Boolean(input.context), 'Generative groups require a target context');
export const createAdSchema = z.object({
  ad_group_id: gravityId, headline: z.string().trim().min(1).max(50), copy: z.string().trim().min(1).max(500),
  cta: z.string().trim().min(1).max(80), landing_page: webUrl, image_url: webUrl.optional(),
  name: z.string().trim().min(1).max(500).optional(), status: gravityStatus.default('paused'),
}).strict();
export const setBudgetSchema = z.object({
  campaign_id: gravityId,
  field: z.enum(['daily_budget', 'total_budget']).default('daily_budget'),
  budget_micros: gravityBudgetMicros,
});
