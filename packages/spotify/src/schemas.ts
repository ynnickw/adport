import { z } from 'zod';

// Spotify Ads v3 reference contracts, reviewed 2026-08-31.
// Response objects remain forward-compatible; fields consumed for policy and
// reporting are validated instead of interpreting malformed data as empty data.
export const spotifyId = z.uuid();
export const businessSchema = z.looseObject({ id: spotifyId, name: z.string() });
export const accountSchema = z.looseObject({
  id: spotifyId, name: z.string(), currency_code: z.string(), status: z.string(),
  business_id: spotifyId.optional(), test_account_type: z.string().optional(),
});
export const campaignSchema = z.looseObject({ id: spotifyId, name: z.string(), status: z.string() });
export const draftSchema = campaignSchema.extend({ ad_account_id: spotifyId });
export const budgetSchema = z.object({ micro_amount: z.number().int().nonnegative().safe(), type: z.enum(['DAILY', 'LIFETIME']) });
export const adSetSchema = z.looseObject({
  id: spotifyId, campaign_id: spotifyId, name: z.string(), budget: budgetSchema, delivery: z.enum(['ON', 'OFF']),
});
export const pagingSchema = z.object({
  page_size: z.number().int().nonnegative(), total_results: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(), current_page: z.number().int().nonnegative(),
});
export const reportRowSchema = z.looseObject({
  entity_type: z.enum(['AD_ACCOUNT', 'CAMPAIGN', 'AD_SET', 'AD']),
  entity_id: spotifyId, entity_name: z.string(), entity_status: z.string(),
  stats: z.array(z.object({ field_type: z.string(), field_value: z.number() })),
});
export const reportSchema = z.looseObject({
  continuation_token: z.string().nullable().optional(),
  granularity: z.enum(['LIFETIME', 'DAY', 'HOUR']), rows: z.array(reportRowSchema),
});
export const createDraftSchema = z.object({
  name: z.string().trim().min(2).max(200),
  purchase_order: z.string().min(2).max(45).optional(),
  delivery_goal_group: z.enum(['AWARENESS', 'WEBSITE_TRAFFIC', 'APP_PROMOTION', 'ENGAGEMENT_ON_SPOTIFY', 'LEAD_GEN', 'VIDEO_VIEWS']),
  status: z.enum(['PAUSED', 'ACTIVE']).default('PAUSED'),
});
export const setStatusSchema = z.object({ campaign_id: spotifyId, status: z.enum(['PAUSED', 'ACTIVE']) });
export const setBudgetSchema = z.object({ ad_set_id: spotifyId, budget_micros: z.number().int().positive().safe() });
export const setDeliverySchema = z.object({ ad_set_id: spotifyId, delivery: z.enum(['OFF', 'ON']) });
