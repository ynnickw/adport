import { z } from 'zod';

const page = z.object({
  id: z.string(), name: z.string(), category: z.string().optional(), tasks: z.array(z.string()),
});

export const pagesOutput = z.object({ pages: z.array(page), page_count: z.number().int().nonnegative() });

export const pageEngagementOutput = z.object({
  page: z.object({
    id: z.string().optional(), name: z.string().optional(), category: z.string().optional(),
    fan_count: z.number().optional(), followers_count: z.number().optional(), talking_about_count: z.number().optional(),
  }).passthrough(),
  posts: z.array(z.object({
    id: z.string().optional(), message: z.string().optional(), created_time: z.string().optional(),
    permalink_url: z.string().optional(), shares: z.number(), likes: z.number(), comments: z.number(),
  })),
});

// Fields/edges are caller-selected; do not discard API fields or assume a
// campaign-only response. MCP wraps this legacy union under `value`.
const apiObject = z.record(z.string(), z.unknown());
export const apiReadOutput = z.union([z.array(apiObject), apiObject]);

const actionMetric = z.object({ action_type: z.string(), value: z.string() }).passthrough();
export const insightsOutput = z.object({
  rows: z.array(z.object({
    account_id: z.string().optional(), campaign_id: z.string().optional(), campaign_name: z.string().optional(),
    adset_id: z.string().optional(), ad_id: z.string().optional(),
    date_start: z.string().optional(), date_stop: z.string().optional(),
    spend: z.string().optional(), impressions: z.string().optional(), clicks: z.string().optional(),
    actions: z.array(actionMetric).optional(), action_values: z.array(actionMetric).optional(),
    purchase_roas: z.array(actionMetric).optional(),
  }).passthrough()),
  row_count: z.number().int().nonnegative(),
});
