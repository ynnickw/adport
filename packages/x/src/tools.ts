import { z } from 'zod';
import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import type { XAdsProvider } from './provider.js';
import { createCampaignSchema, setBudgetSchema, setStatusSchema, xId } from './schemas.js';

export function xTools(provider: XAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'x_list_campaigns', namespace: 'x', description: 'List X Ads campaigns including inactive, deleted and draft campaigns.', input: z.object({ account_id: xId }), annotations: { readOnly: true }, handler: input => provider.listCampaigns(input.account_id) }),
    defineTool({ name: 'x_list_funding_instruments', namespace: 'x', description: 'List existing funding instruments for campaign creation; does not create or change billing.', input: z.object({ account_id: xId }), annotations: { readOnly: true }, handler: input => provider.listFundingInstruments(input.account_id) }),
    defineTool({ name: 'x_list_line_items', namespace: 'x', description: 'List X Ads line items (ad groups).', input: z.object({ account_id: xId }), annotations: { readOnly: true }, handler: input => provider.listLineItems(input.account_id) }),
    guardedWriteTool({ name: 'x_create_campaign', namespace: 'x', provider: 'x', kind: 'create', description: 'Create a paused X Ads campaign with an existing funding instrument and account-currency budgets in integer micros. Preview is local.', payload: createCampaignSchema }),
    guardedWriteTool({ name: 'x_set_campaign_status', namespace: 'x', provider: 'x', kind: 'update', description: 'Pause or activate an existing X Ads campaign.', payload: setStatusSchema }),
    guardedWriteTool({ name: 'x_set_budget', namespace: 'x', provider: 'x', kind: 'update', description: 'Change an existing X Ads daily or total campaign budget in integer micros, preserving the other cap.', payload: setBudgetSchema }),
  ];
}
