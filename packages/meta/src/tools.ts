import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { MetaAdsProvider } from './provider.js';

const statusSchema = z.enum(['ACTIVE', 'PAUSED']);

// Current outcome-based objectives (legacy values exist but new campaigns should use these).
const objectiveSchema = z.enum([
  'OUTCOME_APP_PROMOTION',
  'OUTCOME_AWARENESS',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_LEADS',
  'OUTCOME_SALES',
  'OUTCOME_TRAFFIC',
]);

const specialAdCategorySchema = z.enum([
  'NONE',
  'EMPLOYMENT',
  'HOUSING',
  'CREDIT',
  'ISSUES_ELECTIONS_POLITICS',
  'ONLINE_GAMBLING_AND_GAMING',
  'FINANCIAL_PRODUCTS_SERVICES',
]);

export function metaTools(provider: MetaAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'meta_insights',
      namespace: 'meta',
      description:
        'Query the Meta Ads Insights API directly: pick a level (account/campaign/adset/ad), fields ' +
        '(spend, impressions, clicks, actions, action_values, purchase_roas, campaign_name, ...), and a ' +
        'date_preset (last_7d, last_30d, maximum, ...) or explicit time_range. Values come back as strings; ' +
        'spend is whole currency units.',
      input: z.object({
        account_id: z.string().describe('Numeric ad account id, act_ prefix optional'),
        level: z.enum(['account', 'campaign', 'adset', 'ad']).default('campaign'),
        fields: z.array(z.string()).min(1).default(['campaign_id', 'campaign_name', 'spend', 'impressions', 'clicks']),
        date_preset: z.string().optional(),
        time_range: z.object({ since: z.string(), until: z.string() }).optional(),
        breakdowns: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(5000).default(200),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        const rows = await provider.insights(input);
        return { rows, row_count: rows.length };
      },
    }),
    guardedWriteTool({
      name: 'meta_create_campaign',
      namespace: 'meta',
      description:
        'Create a Meta campaign. Budget is optional at campaign level (Advantage/CBO) — otherwise set it on ad sets. ' +
        'special_ad_categories is required by Meta for regulated verticals; defaults to none.',
      provider: 'meta',
      kind: 'create',
      payload: z.object({
        name: z.string().min(1),
        objective: objectiveSchema.default('OUTCOME_TRAFFIC'),
        status: statusSchema.optional(),
        special_ad_categories: z.array(specialAdCategorySchema).default([]),
        daily_budget_cents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Minor currency units (cents for EUR/USD) — campaign-level CBO budget'),
      }),
    }),
    guardedWriteTool({
      name: 'meta_set_campaign_status',
      namespace: 'meta',
      description: 'Activate or pause a Meta campaign.',
      provider: 'meta',
      kind: 'update',
      payload: z.object({ campaign_id: z.string(), status: statusSchema }),
    }),
    guardedWriteTool({
      name: 'meta_set_budget',
      namespace: 'meta',
      description:
        'Change the daily budget of a Meta campaign (CBO) or ad set — pass the object id that owns the budget. ' +
        'The preview shows the current value and fails clearly when the object has no daily budget.',
      provider: 'meta',
      kind: 'update',
      payload: z.object({
        object_id: z.string().describe('Campaign id (CBO) or ad set id that owns the daily budget'),
        daily_budget_cents: z.number().int().positive().describe('Minor currency units (cents for EUR/USD)'),
      }),
    }),
    guardedWriteTool({
      name: 'meta_create_ad_set',
      namespace: 'meta',
      description:
        'Create an ad set in a campaign with minimal country targeting. Omit daily_budget_cents when the campaign ' +
        'uses CBO. Defaults: LINK_CLICKS optimization, IMPRESSIONS billing.',
      provider: 'meta',
      kind: 'create',
      payload: z.object({
        campaign_id: z.string(),
        name: z.string().min(1),
        countries: z.array(z.string().length(2)).min(1).describe('ISO country codes for geo targeting'),
        daily_budget_cents: z.number().int().positive().optional(),
        optimization_goal: z.string().optional(),
        billing_event: z.string().optional(),
        status: statusSchema.optional(),
      }),
    }),
    guardedWriteTool({
      name: 'meta_set_ad_set_status',
      namespace: 'meta',
      description: 'Activate or pause a Meta ad set.',
      provider: 'meta',
      kind: 'update',
      payload: z.object({ ad_set_id: z.string(), status: statusSchema }),
    }),
  ];
}
