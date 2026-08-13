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
        'Call any documented Apple Ads v5 read/query/report endpoint. GET supports public entity reads; POST is restricted to selector /find endpoints and report endpoints.',
      input: z.object({
        account_id: z.string().optional().describe('Apple Ads orgId; omit only for unscoped endpoints such as acls'),
        method: z.enum(['GET', 'POST']).default('GET'),
        path: z.string().min(1).describe('Relative v5 path, for example campaigns/123/adgroups or reports/campaigns/123/keywords'),
        body: z.record(z.string(), z.unknown()).optional().describe('Selector or reporting request for POST reads'),
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
        'List Apple Ads campaigns for an organization (id, name, status, servingStatus, dailyBudgetAmount as string Money).',
      input: z.object({
        account_id: z.string().describe('Apple Ads organization id (orgId)'),
        limit: z.number().int().positive().max(1000).default(100),
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
        'Create an Apple Ads search campaign (App Store search results, TAPS billing). ' +
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
        'Create a documented Apple Ads v5 entity using a relative endpoint and API-shaped body. Created ENABLED statuses are coerced to PAUSED; budget/bid Money fields are reported to policy.',
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
        'Update a documented non-monetary Apple Ads v5 entity. Budget/bid changes are rejected here and require typed tools with current-value policy checks.',
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
      description: 'Delete a documented Apple Ads v5 campaign-management entity by relative path.',
      provider: 'apple',
      kind: 'remove',
      destructive: true,
      payload: z.object({ path: z.string().min(1) }),
    }),
  ];
}
