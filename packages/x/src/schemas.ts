import { z } from 'zod';

export const xId = z.string().regex(/^[a-z0-9]+$/).min(1).max(64);
const micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const currency = z.string().regex(/^[A-Z]{3}$/);
export const accountSchema = z.object({
  id: xId, name: z.string(), timezone: z.string(), timezone_switch_at: z.string().nullable().optional(),
  approval_status: z.string(), deleted: z.boolean(),
});
export const fundingSchema = z.object({
  id: xId, account_id: xId, description: z.string(), currency, type: z.string(),
  entity_status: z.string(), able_to_fund: z.boolean(), deleted: z.boolean(),
});
export const campaignSchema = z.object({
  id: xId, name: z.string(), currency, funding_instrument_id: xId, entity_status: z.string(), deleted: z.boolean(),
  budget_optimization: z.string(), daily_budget_amount_local_micro: micros.nullable(), total_budget_amount_local_micro: micros.nullable(),
});
export const lineItemSchema = z.object({
  id: xId, name: z.string(), campaign_id: xId, currency, entity_status: z.string(), deleted: z.boolean(),
  placements: z.array(z.string()), product_type: z.string(), objective: z.string(),
});
export const promotedTweetSchema = z.object({
  id: xId, line_item_id: xId, tweet_id: z.string().regex(/^\d+$/), entity_status: z.string(), deleted: z.boolean(),
});
export const promotedAccountSchema = z.object({ id: xId, line_item_id: xId, user_id: z.string().regex(/^\d+$/), entity_status: z.string(), deleted: z.boolean() });
export const mediaCreativeSchema = z.object({ id: xId, line_item_id: xId, account_media_id: xId, entity_status: z.string(), deleted: z.boolean() });
export const createCampaignSchema = z.object({
  name: z.string().min(1).max(255), funding_instrument_id: xId,
  daily_budget_micros: micros.positive(), total_budget_micros: micros.positive().optional(),
  status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'),
});
export const setStatusSchema = z.object({ campaign_id: xId, status: z.enum(['ACTIVE', 'PAUSED']) });
export const setBudgetSchema = z.object({ campaign_id: xId, budget_type: z.enum(['DAILY', 'TOTAL']), budget_micros: micros.positive() });
