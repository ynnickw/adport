import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { GoogleAdsProvider } from './provider.js';

const statusSchema = z.enum(['ENABLED', 'PAUSED']);
const matchTypeSchema = z.enum(['EXACT', 'PHRASE', 'BROAD']);

export function googleTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'google_gaql',
      namespace: 'google',
      description:
        'Run a structured Google Ads (GAQL) query: pick a resource (campaign, ad_group, keyword_view, change_event, ...), ' +
        'fields (e.g. campaign.name, metrics.clicks, segments.date), optional conditions and ordering. ' +
        "Conditions are raw GAQL predicates, e.g. \"segments.date DURING LAST_7_DAYS\" or \"campaign.status = 'ENABLED'\".",
      input: z.object({
        customer_id: z.string().describe('10-digit account id, dashes ok'),
        resource: z.string().min(1),
        fields: z.array(z.string()).min(1),
        conditions: z.array(z.string()).optional(),
        order_by: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(10_000).default(200),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        const rows = await provider.gaqlSearch(input);
        return { rows, row_count: rows.length };
      },
    }),
    guardedWriteTool({
      name: 'google_create_campaign',
      namespace: 'google',
      description:
        'Create a Google Ads campaign with its own (non-shared) daily budget, atomically. Manual CPC bidding; refine later.',
      provider: 'google',
      kind: 'create',
      payload: z.object({
        name: z.string().min(1),
        daily_budget_micros: z.number().int().positive().describe('1 currency unit = 1,000,000 micros'),
        channel_type: z.enum(['SEARCH', 'DISPLAY', 'SHOPPING', 'VIDEO', 'PERFORMANCE_MAX']).default('SEARCH'),
        status: statusSchema.optional(),
      }),
    }),
    guardedWriteTool({
      name: 'google_set_campaign_status',
      namespace: 'google',
      description: 'Enable or pause a campaign.',
      provider: 'google',
      kind: 'update',
      payload: z.object({ campaign_id: z.string(), status: statusSchema }),
    }),
    guardedWriteTool({
      name: 'google_set_budget',
      namespace: 'google',
      description: "Change a campaign's daily budget. The preview warns when the budget is shared across campaigns.",
      provider: 'google',
      kind: 'update',
      payload: z.object({ campaign_id: z.string(), daily_budget_micros: z.number().int().positive() }),
    }),
    guardedWriteTool({
      name: 'google_set_bid_ceiling',
      namespace: 'google',
      description:
        "Set a campaign's max CPC bid ceiling (micros). Works for MAXIMIZE_CLICKS (target spend) and " +
        'TARGET_IMPRESSION_SHARE strategies; fails with guidance for others.',
      provider: 'google',
      kind: 'update',
      payload: z.object({
        campaign_id: z.string(),
        cpc_bid_ceiling_micros: z.number().int().positive().describe('1 currency unit = 1,000,000 micros'),
      }),
    }),
    guardedWriteTool({
      name: 'google_set_bidding_strategy',
      namespace: 'google',
      description:
        "Switch a campaign's bidding strategy: MANUAL_CPC, MAXIMIZE_CLICKS (optional cpc_bid_ceiling_micros), " +
        'MAXIMIZE_CONVERSIONS (optional target_cpa_micros), MAXIMIZE_CONVERSION_VALUE (optional target_roas). ' +
        'Also updates the target of the current strategy when the strategy stays the same.',
      provider: 'google',
      kind: 'update',
      payload: z.object({
        campaign_id: z.string(),
        strategy: z.enum(['MANUAL_CPC', 'MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE']),
        target_cpa_micros: z.number().int().positive().optional(),
        target_roas: z.number().positive().optional().describe('e.g. 3.5 = 350% return on ad spend'),
        cpc_bid_ceiling_micros: z.number().int().positive().optional(),
      }),
    }),
    guardedWriteTool({
      name: 'google_create_ad_group',
      namespace: 'google',
      description: 'Create a SEARCH_STANDARD ad group in a campaign.',
      provider: 'google',
      kind: 'create',
      payload: z.object({
        campaign_id: z.string(),
        name: z.string().min(1),
        cpc_bid_micros: z.number().int().positive().optional(),
      }),
    }),
    guardedWriteTool({
      name: 'google_set_ad_group_status',
      namespace: 'google',
      description: 'Enable or pause an ad group.',
      provider: 'google',
      kind: 'update',
      payload: z.object({ ad_group_id: z.string(), status: statusSchema }),
    }),
    guardedWriteTool({
      name: 'google_add_keywords',
      namespace: 'google',
      description: 'Add keywords (or negative keywords) to an ad group.',
      provider: 'google',
      kind: 'create',
      payload: z.object({
        ad_group_id: z.string(),
        keywords: z.array(z.object({ text: z.string().min(1), match_type: matchTypeSchema })).min(1),
        negative: z.boolean().default(false),
      }),
    }),
    guardedWriteTool({
      name: 'google_set_keyword_status',
      namespace: 'google',
      description: 'Enable or pause a keyword criterion.',
      provider: 'google',
      kind: 'update',
      payload: z.object({ ad_group_id: z.string(), criterion_id: z.string(), status: statusSchema }),
    }),
    guardedWriteTool({
      name: 'google_remove_keywords',
      namespace: 'google',
      description: 'PERMANENTLY remove keyword criteria from an ad group. Prefer google_set_keyword_status to pause.',
      provider: 'google',
      kind: 'remove',
      destructive: true,
      payload: z.object({ ad_group_id: z.string(), criterion_ids: z.array(z.string()).min(1) }),
    }),
    guardedWriteTool({
      name: 'google_create_responsive_search_ad',
      namespace: 'google',
      description: 'Create a responsive search ad (3–15 headlines ≤30 chars, 2–4 descriptions ≤90 chars).',
      provider: 'google',
      kind: 'create',
      payload: z.object({
        ad_group_id: z.string(),
        headlines: z.array(z.string()).min(3).max(15),
        descriptions: z.array(z.string()).min(2).max(4),
        final_urls: z.array(z.string().url()).min(1),
        path1: z.string().max(15).optional(),
        path2: z.string().max(15).optional(),
      }),
    }),
  ];
}
