import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { AppleAdsProvider } from './provider.js';

const statusSchema = z.enum(['ENABLED', 'PAUSED']);

export function appleTools(provider: AppleAdsProvider): AnyToolDefinition[] {
  return [
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
  ];
}
