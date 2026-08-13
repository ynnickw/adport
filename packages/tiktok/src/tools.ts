import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { TikTokAdsProvider } from './provider.js';

const OBJECTIVES = [
  'REACH',
  'TRAFFIC',
  'VIDEO_VIEWS',
  'LEAD_GENERATION',
  'ENGAGEMENT',
  'APP_PROMOTION',
  'WEB_CONVERSIONS',
  'PRODUCT_SALES',
] as const;

const operationStatusSchema = z.enum(['ENABLE', 'DISABLE']);

export function tiktokTools(provider: TikTokAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'tiktok_api_read',
      namespace: 'tiktok',
      description: 'Call any documented TikTok Business API v1.3 GET endpoint with advertiser scoping and API-shaped parameters.',
      input: z.object({
        account_id: z.string(),
        path: z.string().min(3).describe('Relative endpoint, e.g. adgroup/get, ad/get, creative/report/get'),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        return provider.apiRead(input);
      },
    }),
    defineTool({
      name: 'tiktok_campaigns',
      namespace: 'tiktok',
      description: 'List TikTok campaigns (id, name, operation_status ENABLE/DISABLE, budget, budget_mode, objective).',
      input: z.object({
        account_id: z.string().describe('Advertiser id'),
        campaign_ids: z.array(z.string()).optional(),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        const campaigns = await provider.listCampaigns(input.account_id, input.campaign_ids);
        return { campaigns };
      },
    }),
    defineTool({
      name: 'tiktok_report',
      namespace: 'tiktok',
      description:
        'Raw TikTok synchronous reporting (report/integrated). Metric values come back as strings; ' +
        'note total_complete_payment_rate is total purchase VALUE (misleading name), complete_payment_roas is purchase ROAS.',
      input: z.object({
        account_id: z.string(),
        data_level: z.enum(['AUCTION_ADVERTISER', 'AUCTION_CAMPAIGN', 'AUCTION_ADGROUP', 'AUCTION_AD']).default('AUCTION_CAMPAIGN'),
        dimensions: z.array(z.string()).min(1).default(['campaign_id']),
        metrics: z.array(z.string()).min(1).default(['spend', 'impressions', 'clicks', 'conversion']),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        page_size: z.number().int().positive().max(1000).default(200),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        const rows = await provider.rawReport(input);
        return { rows, row_count: rows.length };
      },
    }),
    guardedWriteTool({
      name: 'tiktok_create_campaign',
      namespace: 'tiktok',
      description:
        'Create a TikTok campaign. Budget is a float in whole account-currency units (min ~20 USD-equivalent for ' +
        'DAY/TOTAL modes). TikTok has no server-side dry run — the preview is a client-side diff.',
      provider: 'tiktok',
      kind: 'create',
      payload: z.object({
        campaign_name: z.string().min(1).max(512),
        objective_type: z.enum(OBJECTIVES).default('TRAFFIC'),
        budget_mode: z.enum(['BUDGET_MODE_DAY', 'BUDGET_MODE_TOTAL', 'BUDGET_MODE_INFINITE']).default('BUDGET_MODE_DAY'),
        budget: z.number().positive().optional().describe('Whole currency units (float), required unless BUDGET_MODE_INFINITE'),
        operation_status: operationStatusSchema.optional(),
      }),
    }),
    guardedWriteTool({
      name: 'tiktok_set_campaign_status',
      namespace: 'tiktok',
      description: 'Enable or pause (DISABLE) up to 20 TikTok campaigns.',
      provider: 'tiktok',
      kind: 'update',
      payload: z.object({
        campaign_ids: z.array(z.string()).min(1).max(20),
        operation_status: operationStatusSchema,
      }),
    }),
    guardedWriteTool({
      name: 'tiktok_set_budget',
      namespace: 'tiktok',
      description:
        "Change a TikTok campaign's budget (whole currency units). TikTok rejects new budgets below 105% of current spend.",
      provider: 'tiktok',
      kind: 'update',
      payload: z.object({
        campaign_id: z.string(),
        budget: z.number().positive(),
      }),
    }),
    guardedWriteTool({
      name: 'tiktok_api_create',
      namespace: 'tiktok',
      description:
        'Create through any documented TikTok Business API v1.3 /create endpoint. The advertiser is forced to account_id, campaign creation is paused, and budget fields are policy-checked.',
      provider: 'tiktok',
      kind: 'create',
      payload: z.object({ path: z.string().min(3), body: z.record(z.string(), z.unknown()) }),
    }),
    guardedWriteTool({
      name: 'tiktok_api_update',
      namespace: 'tiktok',
      description: 'Update non-budget fields through any documented TikTok Business API v1.3 /update endpoint.',
      provider: 'tiktok',
      kind: 'update',
      payload: z.object({ path: z.string().min(3), body: z.record(z.string(), z.unknown()) }),
    }),
    guardedWriteTool({
      name: 'tiktok_api_delete',
      namespace: 'tiktok',
      description: 'Permanently delete through any documented TikTok Business API v1.3 /delete endpoint.',
      provider: 'tiktok',
      kind: 'remove',
      destructive: true,
      payload: z.object({ path: z.string().min(3), body: z.record(z.string(), z.unknown()) }),
    }),
  ];
}
