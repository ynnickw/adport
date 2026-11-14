import { z } from 'zod';

// Reddit-owned v3 OpenAPI, reviewed2026-11-03 (post-Sep2026 objective migration).
export const redditId = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const micros = z.number().int().nonnegative().safe();
export const status = z.enum(['ACTIVE', 'PAUSED']);
export const objective = z.enum(['APP_INSTALLS', 'BRAND_AWARENESS', 'CATALOG_SALES', 'CLICKS', 'CONVERSIONS', 'IMPRESSIONS', 'LEAD_GENERATION', 'SALES', 'VIDEO_VIEWABLE_IMPRESSIONS']);
export const createCampaign = z.object({
  name: z.string().trim().min(1), objective: objective.default('CLICKS'), funding_instrument_id: redditId,
  configured_status: status.default('PAUSED'), budget_micros: micros.positive().optional(), budget_type: z.enum(['DAILY_SPEND', 'LIFETIME_SPEND']).default('DAILY_SPEND'),
  conversion_pixel_id: redditId.optional(), spend_cap_micros: micros.positive().optional(),
}).refine(v => !v.budget_micros || Boolean(v.conversion_pixel_id), 'conversion_pixel_id is required for CBO campaigns');
export const setCampaignStatus = z.object({ campaign_id: redditId, configured_status: status });
export const setCampaignBudget = z.object({ campaign_id: redditId, budget_micros: micros.positive(), budget_type: z.enum(['DAILY_SPEND', 'LIFETIME_SPEND']).optional() });
