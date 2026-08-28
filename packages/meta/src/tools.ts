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
      name: 'meta_list_pages',
      namespace: 'meta',
      description:
        'List the Facebook Pages the connected user can access, including their Page roles/tasks. Uses pages_show_list and never returns Page access tokens.',
      input: z.object({}),
      annotations: { readOnly: true },
      async handler() {
        const pages = await provider.listPages();
        return { pages, page_count: pages.length };
      },
    }),
    defineTool({
      name: 'meta_page_engagement',
      namespace: 'meta',
      description:
        'Read engagement metadata and recent posts for an accessible Facebook Page. Uses pages_read_engagement after verifying the Page belongs to the connected user.',
      input: z.object({
        page_id: z.string().regex(/^\d+$/),
        post_limit: z.number().int().positive().max(100).default(25),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        return provider.pageEngagement(input);
      },
    }),
    defineTool({
      name: 'meta_api_read',
      namespace: 'meta',
      description:
        'Read any Meta Marketing API v25 ad-account edge with fields and string query parameters, following pagination.',
      input: z.object({
        account_id: z.string(),
        edge: z.string().min(2).describe('Ad-account edge such as campaigns, adsets, ads, adcreatives, customaudiences, or pixels'),
        fields: z.array(z.string()).optional(),
        params: z.record(z.string(), z.string()).optional(),
        limit: z.number().int().positive().max(5000).default(200),
        paged: z.boolean().default(true).describe('Set false for endpoints that return a single object instead of a data page'),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        return provider.apiRead(input);
      },
    }),
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
        is_adset_budget_sharing_enabled: z
          .boolean()
          .optional()
          .describe('For campaigns without a campaign budget: allow eligible ad sets to share up to 20% of their daily budgets; defaults to false'),
      }).superRefine((value, ctx) => {
        if (value.daily_budget_cents !== undefined && value.is_adset_budget_sharing_enabled !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['is_adset_budget_sharing_enabled'],
            message: 'Only set is_adset_budget_sharing_enabled when daily_budget_cents is omitted',
          });
        }
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
    guardedWriteTool({
      name: 'meta_set_lifetime_budget',
      namespace: 'meta',
      description: 'Change a campaign or ad set lifetime budget with a current-value lookup and policy delta check.',
      provider: 'meta',
      kind: 'update',
      payload: z.object({
        object_id: z.string(),
        lifetime_budget_cents: z.number().int().positive().describe('Minor currency units'),
      }),
    }),
    guardedWriteTool({
      name: 'meta_api_create',
      namespace: 'meta',
      description:
        'Create an object on any Meta Marketing API v25 ad-account edge using API-shaped fields. Campaign, ad set, and ad status is forced to PAUSED; budget fields are policy-checked.',
      provider: 'meta',
      kind: 'create',
      payload: z.object({
        edge: z.string().min(2),
        fields: z.record(z.string(), z.unknown()),
      }),
    }),
    guardedWriteTool({
      name: 'meta_api_update',
      namespace: 'meta',
      description: 'Update a non-budget Meta Marketing API v25 object after verifying it belongs to the selected ad account.',
      provider: 'meta',
      kind: 'update',
      payload: z.object({
        object_id: z.string(),
        fields: z.record(z.string(), z.unknown()),
      }),
    }),
    guardedWriteTool({
      name: 'meta_api_delete',
      namespace: 'meta',
      description: 'Permanently delete a Meta Marketing API v25 object after verifying ad-account ownership.',
      provider: 'meta',
      kind: 'remove',
      destructive: true,
      payload: z.object({ object_id: z.string() }),
    }),
  ];
}
