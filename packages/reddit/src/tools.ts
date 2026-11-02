import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { RedditAdsProvider } from './provider.js';
import { createCampaign, setCampaignBudget, setCampaignStatus } from './schemas.js';
import { redditCreativeTools } from './creative-tools.js';
import { redditManagementTools } from './management-tools.js';

export function redditTools(provider: RedditAdsProvider): AnyToolDefinition[] {
  return [
    ...redditCreativeTools(provider),
    ...redditManagementTools(provider),
    defineTool({
      name: 'reddit_api_read',
      namespace: 'reddit',
      description: 'Call a documented Reddit Ads API v3 GET or read-only reports/history/query/search POST endpoint, scoped to the selected ad account.',
      input: z.object({
        account_id: z.string(),
        path: z.string().min(3).describe('Relative v3 path, e.g. ad_accounts/{id}/ad_groups or campaigns/{campaign_id}'),
        method: z.enum(['GET', 'POST']).default('GET'),
        params: z.record(z.string(), z.unknown()).optional(),
        body: z.record(z.string(), z.unknown()).optional(),
        limit: z.number().int().positive().max(5000).optional().describe('Follow list pagination for GET responses'),
      }),
      annotations: { readOnly: true },
      handler: (input) => provider.apiRead(input),
    }),
    defineTool({
      name: 'reddit_campaigns',
      namespace: 'reddit',
      description: 'List Reddit campaigns and their native configured/effective status, CBO budget, objective, and funding instrument.',
      input: z.object({ account_id: z.string(), campaign_ids: z.array(z.string()).optional() }),
      annotations: { readOnly: true },
      async handler(input) { return { campaigns: await provider.listCampaigns(input.account_id, input.campaign_ids) }; },
    }),
    defineTool({
      name: 'reddit_report',
      namespace: 'reddit',
      description: 'Query Reddit Ads API v3 reporting directly. Spend/CPC/CPM use micros; conversion TOTAL_VALUE fields use cents. Missing metrics remain unavailable.',
      input: z.object({
        account_id: z.string(),
        breakdowns: z.array(z.string()).max(4).optional(),
        fields: z.array(z.string()).min(1).default(['SPEND', 'IMPRESSIONS', 'CLICKS']),
        starts_at: z.string().datetime({ offset: true }),
        ends_at: z.string().datetime({ offset: true }),
        time_zone_id: z.string().default('UTC'),
        filter: z.string().optional(),
        page_size: z.number().int().positive().max(1000).default(200),
      }),
      annotations: { readOnly: true },
      handler: (input) => provider.rawReport(input),
    }),
    guardedWriteTool({
      name: 'reddit_create_campaign',
      namespace: 'reddit',
      description: 'Create a Reddit campaign through API v3. Campaigns are forced PAUSED. CBO budgets and spend caps are integer micros.',
      provider: 'reddit', kind: 'create',
      payload: createCampaign,
    }),
    guardedWriteTool({
      name: 'reddit_set_campaign_status', namespace: 'reddit',
      description: 'Activate or pause a Reddit campaign after verifying ad-account ownership.',
      provider: 'reddit', kind: 'update',
      payload: setCampaignStatus,
    }),
    guardedWriteTool({
      name: 'reddit_set_budget', namespace: 'reddit',
      description: 'Change a Reddit CBO campaign goal_value in integer micros, with current-value lookup and policy checks.',
      provider: 'reddit', kind: 'update',
      payload: setCampaignBudget,
    }),
    guardedWriteTool({
      name: 'reddit_api_create', namespace: 'reddit',
      description: 'Create via an account-scoped Reddit Ads API v3 endpoint. Campaign status is forced PAUSED and native micros fields are policy-checked.',
      provider: 'reddit', kind: 'create',
      payload: z.object({ path: z.string().min(3), body: z.record(z.string(), z.unknown()) }),
    }),
    guardedWriteTool({
      name: 'reddit_api_update', namespace: 'reddit',
      description: 'PATCH non-budget fields on a Reddit Ads API v3 resource after verifying ad-account ownership.',
      provider: 'reddit', kind: 'update',
      payload: z.object({ path: z.string().min(3), body: z.record(z.string(), z.unknown()) }),
    }),
    guardedWriteTool({
      name: 'reddit_api_delete', namespace: 'reddit',
      description: 'Permanently DELETE a Reddit Ads API v3 resource after verifying ad-account ownership.',
      provider: 'reddit', kind: 'remove', destructive: true,
      payload: z.object({ path: z.string().min(3) }),
    }),
  ];
}
