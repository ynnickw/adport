import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { MicrosoftAdsProvider } from './provider.js';

const statusSchema = z.enum(['Active', 'Paused']);

export function microsoftTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'microsoft_campaigns',
      namespace: 'microsoft',
      description:
        'List Microsoft Advertising campaigns (Id, Name, Status Active/Paused/BudgetPaused, DailyBudget in account currency, BudgetId when shared).',
      input: z.object({ account_id: z.string().describe('Ad account id') }),
      annotations: { readOnly: true },
      async handler(input) {
        const campaigns = await provider.listCampaigns(input.account_id);
        return { campaigns };
      },
    }),
    guardedWriteTool({
      name: 'microsoft_create_campaign',
      namespace: 'microsoft',
      description:
        'Create a Microsoft Advertising Search campaign. daily_budget is a float in account currency. ' +
        "The API's own default status is Paused. No server dry-run — previews are client-side diffs.",
      provider: 'microsoft',
      kind: 'create',
      payload: z.object({
        name: z.string().min(1).max(128),
        daily_budget: z.number().positive(),
        time_zone: z.string().optional().describe('Bing Ads time zone name, default PacificTimeUSCanadaTijuana'),
        status: statusSchema.optional(),
      }),
    }),
    guardedWriteTool({
      name: 'microsoft_set_campaign_status',
      namespace: 'microsoft',
      description: 'Activate or pause a Microsoft Advertising campaign.',
      provider: 'microsoft',
      kind: 'update',
      payload: z.object({ campaign_id: z.string(), status: statusSchema }),
    }),
    guardedWriteTool({
      name: 'microsoft_set_budget',
      namespace: 'microsoft',
      description:
        "Change a Microsoft campaign's DailyBudget (float, account currency). Fails clearly for shared budgets.",
      provider: 'microsoft',
      kind: 'update',
      payload: z.object({ campaign_id: z.string(), daily_budget: z.number().positive() }),
    }),
  ];
}
