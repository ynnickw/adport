import { z } from 'zod';
import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { createCampaignSchema, pinterestId, setBudgetSchema, setStatusSchema } from './schemas.js';
import type { PinterestAdsProvider } from './provider.js';

export function pinterestTools(provider: PinterestAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'pinterest_list_campaigns', namespace: 'pinterest', description: 'List Pinterest campaigns, including archived and draft entities.', input: z.object({ account_id: pinterestId }), annotations: { readOnly: true }, handler: input => provider.listCampaigns(input.account_id) }),
    guardedWriteTool({ name: 'pinterest_create_campaign', namespace: 'pinterest', provider: 'pinterest', kind: 'create', description: 'Create a Pinterest CBO campaign, paused by policy. Budgets are account-currency micros; lifetime budgets require an end time. Preview is local.', payload: createCampaignSchema }),
    guardedWriteTool({ name: 'pinterest_set_campaign_status', namespace: 'pinterest', provider: 'pinterest', kind: 'update', description: 'Pause or activate an existing Pinterest campaign.', payload: setStatusSchema }),
    guardedWriteTool({ name: 'pinterest_set_budget', namespace: 'pinterest', provider: 'pinterest', kind: 'update', description: 'Change an existing Pinterest CBO campaign budget in micros, preserving its daily/lifetime type.', payload: setBudgetSchema }),
  ];
}
