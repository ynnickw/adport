import { DATE_PRESETS, defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { MicrosoftAdsProvider } from './provider.js';
import { microsoftChildTools } from './child-tools.js';
import { microsoftImageTools } from './images.js';
import { microsoftExtensionTools } from './extensions.js';
import { microsoftTargetingTools } from './targeting.js';
import { microsoftNegativeKeywordTools } from './negative-keywords.js';
import { microsoftBudgetTools } from './budgets.js';
import { microsoftPlanningTools } from './planning.js';
import { microsoftConversionTools } from './conversions.js';
import { microsoftAudienceTools } from './audiences.js';
import { microsoftAudienceTargetingTools } from './audience-targeting.js';

const statusSchema = z.enum(['Active', 'Paused']);

export function microsoftTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    ...microsoftChildTools(provider),
    ...microsoftImageTools(provider),
    ...microsoftExtensionTools(provider),
    ...microsoftTargetingTools(provider),
    ...microsoftNegativeKeywordTools(provider),
    ...microsoftBudgetTools(provider),
    ...microsoftPlanningTools(provider),
    ...microsoftConversionTools(provider),
    ...microsoftAudienceTools(provider),
    ...microsoftAudienceTargetingTools(provider),
    ...(['keyword', 'search_term'] as const).map(kind => defineTool({
      name: `microsoft_${kind}_report`, namespace: 'microsoft',
      description: `Read the native Microsoft ${kind.replace('_', ' ')} performance report through Submit/Poll/CSV. Native numeric values remain strings; empty or unavailable values are preserved.`,
      input: z.object({ account_id: z.string().regex(/^\d+$/), date_range: z.union([z.enum(DATE_PRESETS), z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })]).default('last_7_days'), limit: z.number().int().positive().max(5000).default(1000) }),
      output: z.object({ rows: z.array(z.record(z.string(), z.string())), truncated: z.boolean(), report_type: z.string() }),
      annotations: { readOnly: true }, handler: input => provider.nativeReport({ ...input, kind }),
    })),
    defineTool({
      name: 'microsoft_api_read',
      namespace: 'microsoft',
      description:
        'Call any documented Microsoft Advertising v13 query, search, get, or reporting submit/poll operation with selected-account headers.',
      input: z.object({
        account_id: z.string(),
        service: z.enum(['campaign', 'customer', 'reporting', 'adinsight']),
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
        'List all eight Microsoft Advertising campaign types (Id, Name, Status, DailyBudget in account currency, BudgetId when shared).',
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
        'Create through Microsoft Campaign Management v13 using its documented API body. Under paused creation, campaigns/ad groups/ads/keywords receive explicit Paused status, including omitted status. Budget fields are policy-checked; shared budgets, conversion goals, UET tags and audiences require typed tools.',
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
