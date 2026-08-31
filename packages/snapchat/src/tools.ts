import { z } from 'zod';
import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { createCampaignSchema, setBudgetSchema, setStatusSchema, snapchatId } from './schemas.js';
import type { SnapchatAdsProvider } from './provider.js';

export function snapchatTools(provider: SnapchatAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'snapchat_list_campaigns', namespace: 'snapchat', description: 'List Snapchat campaigns in the selected ad account.',
      input: z.object({ account_id: snapchatId }), annotations: { readOnly: true }, handler: input => provider.listCampaigns(input.account_id) }),
    guardedWriteTool({ name: 'snapchat_create_campaign', namespace: 'snapchat', provider: 'snapchat', kind: 'create',
      description: 'Create a Snapchat campaign, paused by default. Budget fields use integer micro-currency. Preview is local, not server validation.', payload: createCampaignSchema }),
    guardedWriteTool({ name: 'snapchat_set_campaign_status', namespace: 'snapchat', provider: 'snapchat', kind: 'update',
      description: 'Pause or activate a Snapchat campaign after verifying account ownership.', payload: setStatusSchema }),
    guardedWriteTool({ name: 'snapchat_set_budget', namespace: 'snapchat', provider: 'snapchat', kind: 'update',
      description: 'Set a Snapchat campaign daily budget or lifetime cap in integer micros; reads the existing value for policy checks.', payload: setBudgetSchema }),
  ];
}
