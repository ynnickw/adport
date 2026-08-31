import { z } from 'zod';

// Pinterest's official OpenAPI 5.28.0, reviewed 2026-08-31.
export const pinterestId = z.string().regex(/^\d+$/).max(18);
export const entityStatus = z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED', 'DRAFT', 'DELETED_DRAFT']);
const micros = z.number().int().nonnegative().safe();
export const accountSchema = z.looseObject({ id: pinterestId, name: z.string().optional(), currency: z.string().optional() });
export const entitySchema = z.looseObject({ id: pinterestId, ad_account_id: pinterestId, name: z.string().nullable().optional(), status: entityStatus.optional() });
export const campaignSchema = entitySchema.extend({
  daily_spend_cap: micros.nullable().optional(), lifetime_spend_cap: micros.nullable().optional(),
  is_campaign_budget_optimization: z.boolean().nullable().optional(),
  is_flexible_daily_budgets: z.boolean().nullable().optional(),
});
export const batchResponseSchema = z.object({ items: z.array(z.object({
  data: campaignSchema.partial().optional(), exceptions: z.array(z.unknown()).optional(),
})) });
export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(255),
  objective_type: z.enum(['AWARENESS', 'CONSIDERATION', 'WEB_CONVERSION', 'CATALOG_SALES', 'VIDEO_COMPLETION', 'APP_INSTALL', 'SALES', 'LEADS', 'CTV_CONSIDERATION']),
  status: z.enum(['PAUSED', 'ACTIVE']).default('PAUSED'),
  budget_type: z.enum(['DAILY', 'LIFETIME']).default('DAILY'),
  budget_micros: micros.positive(),
  start_time: z.number().int().positive().safe().optional(),
  end_time: z.number().int().positive().safe().optional(),
  app_id: z.string().min(1).optional(), app_platform: z.enum(['IOS', 'ANDROID']).optional(),
}).superRefine((value, ctx) => {
  if (value.budget_type === 'LIFETIME' && !value.end_time) ctx.addIssue({ code: 'custom', path: ['end_time'], message: 'Lifetime campaign budgets require an end time.' });
  if (value.start_time && value.end_time && value.end_time <= value.start_time) ctx.addIssue({ code: 'custom', path: ['end_time'], message: 'End time must be after start time.' });
  if (value.objective_type === 'APP_INSTALL' && (!value.app_id || !value.app_platform)) ctx.addIssue({ code: 'custom', path: ['app_id'], message: 'APP_INSTALL requires app_id and app_platform and Pinterest beta access.' });
});
export const setStatusSchema = z.object({ campaign_id: pinterestId, status: z.enum(['PAUSED', 'ACTIVE']) });
export const setBudgetSchema = z.object({ campaign_id: pinterestId, budget_micros: micros.positive() });
