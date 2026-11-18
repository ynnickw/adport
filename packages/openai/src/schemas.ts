import { z } from 'zod';

// Official OpenAI Ads API v1 contracts (OpenAPI 2.3.0), reviewed 2026-11-17.
// Source URLs and normalization decisions: docs/providers/openai.md.
export const openaiId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const openaiStatus = z.enum(['active', 'paused']);
/** Campaign budgets are integer micros with a documented floor of one currency unit. */
export const openaiBudgetMicros = z.number().int().min(1_000_000).max(Number.MAX_SAFE_INTEGER);
const unixSeconds = z.number().int().nonnegative();
const schedule = z.iso.datetime({ offset: true }).refine(value => {
  const seconds = Date.parse(value) / 1000;
  return seconds >= 946684800 && seconds <= 4102444800;
}, 'Schedule must be between 2000-01-01 and 2100-01-01');
const metric = z.number().finite().nullable().optional();

export const accountSchema = z.looseObject({
  id: openaiId, name: z.string(), status: z.string().optional(), timezone: z.string(), currency_code: z.string(),
});
export type OpenAIAccount = z.infer<typeof accountSchema>;

export const budgetSchema = z.looseObject({
  lifetime_spend_limit_micros: z.number().int().nonnegative().optional(),
  daily_spend_limit_micros: z.number().int().nonnegative().optional(),
});
export const campaignSchema = z.looseObject({
  id: openaiId, name: z.string(), status: z.string(), description: z.string().nullable().optional(),
  start_time: unixSeconds.nullable().optional(), end_time: unixSeconds.nullable().optional(),
  budget: budgetSchema, bidding_type: z.string().optional(), objective: z.string().optional(),
});
export type OpenAICampaign = z.infer<typeof campaignSchema>;
export const adGroupSchema = z.looseObject({ id: openaiId, name: z.string(), status: z.string() });
export const adSchema = z.looseObject({ id: openaiId, name: z.string(), status: z.string(), review_status: z.string().optional() });

export const listEnvelope = <T extends z.ZodType>(item: T) => z.looseObject({
  data: z.array(item), has_more: z.boolean(), last_id: z.string().nullable().optional(),
});

export const insightRowSchema = z.looseObject({
  id: z.string(),
  impressions: metric, clicks: metric, spend: metric, conversions: metric, order_created_attributed_sales: metric,
  ad_account_id: z.string().nullable().optional(), ad_account_name: z.string().nullable().optional(),
  campaign_id: z.string().nullable().optional(), campaign_name: z.string().nullable().optional(), campaign_status: z.string().nullable().optional(),
  ad_group_id: z.string().nullable().optional(), ad_group_name: z.string().nullable().optional(), ad_group_status: z.string().nullable().optional(),
  ad_id: z.string().nullable().optional(), ad_name: z.string().nullable().optional(), ad_status: z.string().nullable().optional(),
});
export type OpenAIInsightRow = z.infer<typeof insightRowSchema>;

export const listCampaignsSchema = z.object({ account_id: openaiId });
export const listAdGroupsSchema = z.object({ account_id: openaiId, campaign_id: openaiId.optional() });
export const listAdsSchema = z.object({ account_id: openaiId, ad_group_id: openaiId.optional() });

export const createCampaignSchema = z.object({
  name: z.string().min(3).max(1000).refine(value => value.trim().length > 0, 'Name cannot be blank'),
  description: z.string().max(1000).optional(),
  status: openaiStatus.default('paused'),
  lifetime_spend_limit_micros: openaiBudgetMicros.optional(),
  daily_spend_limit_micros: openaiBudgetMicros.optional(),
  bidding_type: z.enum(['impressions', 'clicks', 'conversions']).optional(),
  objective: z.enum(['reach', 'clicks', 'conversions']).optional(),
  conversion_event_setting_ids: z.array(openaiId).length(1).optional(),
  start_time: schedule.optional(),
  end_time: schedule.optional(),
  target_countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250).refine(ids => new Set(ids).size === ids.length, 'Use unique countries').optional(),
  target_location_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(250).refine(ids => new Set(ids).size === ids.length, 'Use unique location IDs').optional(),
}).strict().refine(input => input.lifetime_spend_limit_micros !== undefined || input.daily_spend_limit_micros !== undefined, 'Set a lifetime or daily spend limit')
  .refine(input => input.bidding_type === 'conversions' || input.objective === 'conversions' ? Boolean(input.conversion_event_setting_ids) : !input.conversion_event_setting_ids, {
  message: 'Conversion bidding requires exactly one conversion_event_setting_id; other bidding types must omit it',
});
export const setCampaignStatusSchema = z.object({ campaign_id: openaiId, status: openaiStatus });
export const setAdGroupStatusSchema = z.object({ ad_group_id: openaiId, status: openaiStatus });
export const setAdStatusSchema = z.object({ ad_id: openaiId, status: openaiStatus });
export const setBudgetSchema = z.object({
  campaign_id: openaiId,
  field: z.enum(['daily_spend_limit_micros', 'lifetime_spend_limit_micros']).default('daily_spend_limit_micros'),
  budget_micros: openaiBudgetMicros,
});
