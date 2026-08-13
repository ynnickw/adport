import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { MicrosoftAdsProvider } from './provider.js';

const statusSchema = z.enum(['Active', 'Paused']);

export function microsoftTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'microsoft_api_read',
      namespace: 'microsoft',
      description:
        'Call any documented Microsoft Advertising v13 query, search, get, or reporting submit/poll operation with selected-account headers.',
      input: z.object({
        account_id: z.string(),
        service: z.enum(['campaign', 'customer', 'reporting']),
        path: z.string().min(3).describe('REST operation path, e.g. AdGroups/QueryByCampaignId or GenerateReport/Submit'),
        body: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        return provider.apiRead(input);
      },
    }),
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
    guardedWriteTool({
      name: 'microsoft_api_create',
      namespace: 'microsoft',
      description:
        'Create through any Microsoft Advertising Campaign Management v13 collection using the documented API body. Active statuses are forced to Paused and budget fields are policy-checked.',
      provider: 'microsoft',
      kind: 'create',
      payload: z.object({ resource: z.string().min(2), body: z.record(z.string(), z.unknown()) }),
    }),
    guardedWriteTool({
      name: 'microsoft_api_update',
      namespace: 'microsoft',
      description: 'Update non-budget fields through any Microsoft Advertising Campaign Management v13 collection.',
      provider: 'microsoft',
      kind: 'update',
      payload: z.object({ resource: z.string().min(2), body: z.record(z.string(), z.unknown()) }),
    }),
    guardedWriteTool({
      name: 'microsoft_api_delete',
      namespace: 'microsoft',
      description: 'Permanently delete through any Microsoft Advertising Campaign Management v13 collection.',
      provider: 'microsoft',
      kind: 'remove',
      destructive: true,
      payload: z.object({ resource: z.string().min(2), body: z.record(z.string(), z.unknown()) }),
    }),
  ];
}
