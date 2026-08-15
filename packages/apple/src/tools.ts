import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { AppleAdsProvider } from './provider.js';

const statusSchema = z.enum(['ENABLED', 'PAUSED']);

export function appleTools(provider: AppleAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'apple_api_read',
      namespace: 'apple',
      description:
        'Call any documented Apple Ads Platform API v1 read, query, insight, suggestion, recommendation-query, or report endpoint.',
      input: z.object({
        account_id: z.string().optional().describe('Apple Ads adAccountId; omit only for unscoped endpoints such as acls and me'),
        method: z.enum(['GET', 'POST']).default('GET'),
        path: z.string().min(1).describe('Relative v1 path, for example campaigns/query or reports/apps/campaigns/query'),
        body: z.record(z.string(), z.unknown()).optional().describe('Query, reporting, insight, or suggestion request for POST reads'),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        return provider.apiRead(input);
      },
    }),
    defineTool({
      name: 'apple_campaigns',
      namespace: 'apple',
      description:
        'List Apple Ads Platform API v1 campaigns for an ad account.',
      input: z.object({
        account_id: z.string().describe('Apple Ads ad account id (adAccountId)'),
        limit: z.number().int().positive().max(5000).default(100),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        const campaigns = await provider.listCampaigns(input.account_id, input.limit);
        return { campaigns };
      },
    }),
    guardedWriteTool({
      name: 'apple_create_campaign',
      namespace: 'apple',
      description:
        'Create an Apple Ads Platform API v1 App Store campaign (search results, TAPS billing). ' +
        'daily_budget is a float in whole currency units; adam_id is the App Store app id. ' +
        'Apple has no dry run — previews are client-side diffs.',
      provider: 'apple',
      kind: 'create',
      payload: z.object({
        name: z.string().min(1),
        adam_id: z.number().int().positive().describe('App Store app id (adamId)'),
        countries_or_regions: z.array(z.string().length(2)).min(1),
        daily_budget: z.number().positive(),
        currency: z.string().length(3).describe('Org currency, e.g. USD/EUR'),
        status: statusSchema.optional(),
      }),
    }),
    guardedWriteTool({
      name: 'apple_set_campaign_status',
      namespace: 'apple',
      description: 'Enable or pause an Apple Ads campaign.',
      provider: 'apple',
      kind: 'update',
      payload: z.object({ campaign_id: z.string(), status: statusSchema }),
    }),
    guardedWriteTool({
      name: 'apple_create_ad_group',
      namespace: 'apple',
      description:
        'Create an Apple Ads Platform API v1 App Store ad group using CPT pricing and a MANUAL_CPT/TAP bid strategy. The typed tool emits the documented bidStrategy.bid Money shape.',
      provider: 'apple',
      kind: 'create',
      payload: z.object({
        campaign_id: z.string().min(1),
        name: z.string().min(1),
        bid: z.number().positive(),
        currency: z.string().length(3),
        status: statusSchema.optional(),
        device_classes: z.array(z.enum(['IPHONE', 'IPAD'])).min(1).optional(),
        automated_keywords_opt_in: z.boolean().optional(),
        start_time: z.string().min(1).optional(),
        end_time: z.string().min(1).optional(),
      }),
    }),
    guardedWriteTool({
      name: 'apple_create_keyword',
      namespace: 'apple',
      description:
        'Create a documented Apple Ads Platform API v1 keyword. Omit bid and currency together to inherit the ad-group bid.',
      provider: 'apple',
      kind: 'create',
      payload: z.object({
        ad_group_id: z.string().min(1),
        text: z.string().min(1),
        match_type: z.enum(['BROAD', 'EXACT']),
        bid: z.number().positive().optional(),
        currency: z.string().length(3).optional(),
        status: statusSchema.optional(),
      }).refine((value) => (value.bid === undefined) === (value.currency === undefined), {
        message: 'bid and currency must be provided together',
      }),
    }),
    guardedWriteTool({
      name: 'apple_set_budget',
      namespace: 'apple',
      description: "Change an Apple Ads campaign's daily budget (float, whole currency units).",
      provider: 'apple',
      kind: 'update',
      payload: z.object({ campaign_id: z.string(), daily_budget: z.number().positive() }),
    }),
    guardedWriteTool({
      name: 'apple_api_create',
      namespace: 'apple',
      description:
        'Create a documented Apple Ads Platform API v1 entity using a relative endpoint and API-shaped body. ' +
        'For adgroups, v1 requires pricingModel and bidStrategy.bid Money; defaultBid and defaultBidAmount are not v1 fields. ' +
        'Also supports keyword and negative-keyword bulk-create. Created ENABLED statuses are coerced to PAUSED; budget/bid Money fields are reported to policy.',
      provider: 'apple',
      kind: 'create',
      payload: z.object({
        path: z.string().min(1),
        body: z.record(z.string(), z.unknown()),
      }),
    }),
    guardedWriteTool({
      name: 'apple_api_update',
      namespace: 'apple',
      description:
        'Update a documented non-monetary Apple Ads Platform API v1 entity. Also supports keyword and negative-keyword bulk-update. Budget/bid changes are rejected here and require typed tools with current-value policy checks.',
      provider: 'apple',
      kind: 'update',
      payload: z.object({
        path: z.string().min(1),
        body: z.record(z.string(), z.unknown()),
      }),
    }),
    guardedWriteTool({
      name: 'apple_api_delete',
      namespace: 'apple',
      description: 'Delete a documented Apple Ads Platform API v1 campaign-management entity by relative path.',
      provider: 'apple',
      kind: 'remove',
      destructive: true,
      payload: z.object({ path: z.string().min(1) }),
    }),
    guardedWriteTool({
      name: 'apple_upload_asset',
      namespace: 'apple',
      description:
        'Upload a PNG, JPG/JPEG, or HEIC creative asset for a Business Brand. The required SHA-256 binds the exact local file contents to the preview/apply approval.',
      provider: 'apple',
      kind: 'create',
      payload: z.object({
        file_path: z.string().min(1),
        expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
        promoted_object_id: z.string().min(1),
        promoted_object_type: z.literal('BUSINESS_BRAND').default('BUSINESS_BRAND'),
      }),
    }),
    guardedWriteTool({
      name: 'apple_apply_recommendations',
      namespace: 'apple',
      description:
        'Apply Apple Ads v1 daily-budget or target-CPA recommendations. The provider re-queries every recommendation and policy-checks the current and proposed Money values before apply.',
      provider: 'apple',
      kind: 'update',
      payload: z.object({
        category: z.enum(['daily_budget', 'target_cpa']),
        promoted_object_id: z.string().min(1),
        promoted_object_type: z.enum(['APPSTORE_APP', 'BUSINESS_BRAND']),
        recommendations: z.array(z.object({
          id: z.string().min(1),
          applied_amount: z.number().positive().optional(),
          currency: z.string().length(3).optional(),
        })).min(1),
      }),
    }),
    guardedWriteTool({
      name: 'apple_dismiss_recommendations',
      namespace: 'apple',
      description: 'Dismiss Apple Ads v1 daily-budget or target-CPA recommendations through the normal preview/apply gate.',
      provider: 'apple',
      kind: 'update',
      payload: z.object({
        category: z.enum(['daily_budget', 'target_cpa']),
        promoted_object_id: z.string().min(1),
        promoted_object_type: z.enum(['APPSTORE_APP', 'BUSINESS_BRAND']),
        recommendation_ids: z.array(z.string().min(1)).min(1),
      }),
    }),
    guardedWriteTool({
      name: 'apple_set_bid',
      namespace: 'apple',
      description:
        'Change a v1 campaign, ad-group, or keyword bid after fetching the current Money value for policy enforcement.',
      provider: 'apple',
      kind: 'update',
      payload: z.object({
        resource_type: z.enum(['campaign', 'ad_group', 'keyword']),
        resource_id: z.string().min(1),
        amount: z.number().positive(),
        currency: z.string().length(3).optional(),
      }),
    }),
    guardedWriteTool({
      name: 'apple_set_shared_budget',
      namespace: 'apple',
      description: 'Change an Apple Ads v1 shared-budget value after fetching its current Money value.',
      provider: 'apple',
      kind: 'update',
      payload: z.object({
        shared_budget_id: z.string().min(1),
        amount: z.number().positive(),
        currency: z.string().length(3).optional(),
      }),
    }),
  ];
}
