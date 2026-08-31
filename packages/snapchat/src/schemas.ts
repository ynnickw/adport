import { z } from 'zod';

// Official Snap Marketing API v1 contracts, reviewed 2026-08-31.
// Source URLs and normalization decisions: docs/providers/snapchat.md.
export const snapchatId = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const snapchatStatus = z.enum(['ACTIVE', 'PAUSED']);
export const snapchatMicros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const wireNumber = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)])
  .transform(Number).pipe(z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER));

export const organizationSchema = z.looseObject({ id: snapchatId, name: z.string() });
export const accountSchema = z.looseObject({
  id: snapchatId, name: z.string(), currency: z.string(), timezone: z.string(), status: z.string(),
});
export const campaignSchema = z.looseObject({
  id: snapchatId, ad_account_id: snapchatId, name: z.string(), status: z.string(),
  daily_budget_micro: wireNumber.optional(), lifetime_spend_cap_micro: wireNumber.optional(),
});
export type SnapchatCampaign = z.infer<typeof campaignSchema>;
export const statSchema = z.looseObject({
  id: snapchatId,
  stats: z.record(z.string(), wireNumber).optional(),
  breakdown_stats: z.record(z.string(), z.array(z.looseObject({
    id: snapchatId, stats: z.record(z.string(), wireNumber),
  }))).optional(),
});

export const createCampaignSchema = z.object({
  name: z.string().min(1).max(375),
  start_time: z.iso.datetime({ offset: true }),
  end_time: z.iso.datetime({ offset: true }).optional(),
  objective: z.string().min(1).default('BRAND_AWARENESS'),
  status: snapchatStatus.default('PAUSED'),
  daily_budget_micro: snapchatMicros.positive().optional(),
  lifetime_spend_cap_micro: snapchatMicros.positive().optional(),
  measurement_spec: z.object({ ios_app_id: z.string().optional(), android_app_url: z.string().optional() }).optional(),
  regulations: z.object({ restricted_delivery_signals: z.boolean() }).optional(),
});
export const setStatusSchema = z.object({ campaign_id: snapchatId, status: snapchatStatus });
export const setBudgetSchema = z.object({
  campaign_id: snapchatId,
  field: z.enum(['daily_budget_micro', 'lifetime_spend_cap_micro']).default('daily_budget_micro'),
  budget_micros: snapchatMicros.positive(),
});
