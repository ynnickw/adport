import { z } from 'zod';
import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import type { XAdsProvider } from './provider.js';
import { createCampaignSchema, setBudgetSchema, setStatusSchema, xId } from './schemas.js';
import { xManagementTools } from './management-tools.js';
import { xTargetingTools } from './targeting-tools.js';
import { xCreativeTools } from './creative-tools.js';
import { xMediaTools } from './media-tools.js';
import { xCardTools } from './card-tools.js';
import { xAudienceTools } from './audience-tools.js';
import { xMeasurementTools } from './measurement-tools.js';
import { xPostTools } from './post-tools.js';
import { xScheduledTools } from './scheduled-tools.js';
import { xDirectMediaTools } from './direct-media-tools.js';
import { xPrerollCtaTools } from './preroll-cta-tools.js';

export function xTools(provider: XAdsProvider): AnyToolDefinition[] {
  return [
    ...xManagementTools(provider),
    ...xTargetingTools(provider),
    ...xCreativeTools(provider),
    ...xMediaTools(provider),
    ...xCardTools(provider),
    ...xAudienceTools(provider),
    ...xMeasurementTools(provider),
    ...xPostTools(provider),
    ...xScheduledTools(provider),
    ...xDirectMediaTools(provider),
    ...xPrerollCtaTools(provider),
    defineTool({ name: 'x_get_campaign', namespace: 'x', description: 'Read one campaign’s native budget, funding, currency and delivery configuration within the selected account.', input: z.object({ account_id: xId, campaign_id: xId }), annotations: { readOnly: true }, handler: input => provider.getCampaign(input.account_id, input.campaign_id) }),
    defineTool({ name: 'x_get_line_item', namespace: 'x', description: 'Read native line-item bid, budgets, schedule and other configuration, verifying its ID and account-scoped campaign/currency.', input: z.object({ account_id: xId, line_item_id: xId }), annotations: { readOnly: true }, handler: input => provider.getLineItem(input.account_id, input.line_item_id) }),
    defineTool({ name: 'x_list_campaigns', namespace: 'x', description: 'List X Ads campaigns including inactive, deleted and draft campaigns.', input: z.object({ account_id: xId }), annotations: { readOnly: true }, handler: input => provider.listCampaigns(input.account_id) }),
    defineTool({ name: 'x_list_funding_instruments', namespace: 'x', description: 'List existing funding instruments for campaign creation; does not create or change billing.', input: z.object({ account_id: xId }), annotations: { readOnly: true }, handler: input => provider.listFundingInstruments(input.account_id) }),
    defineTool({ name: 'x_list_line_items', namespace: 'x', description: 'List X Ads line items (ad groups).', input: z.object({ account_id: xId }), annotations: { readOnly: true }, handler: input => provider.listLineItems(input.account_id) }),
    guardedWriteTool({ name: 'x_create_campaign', namespace: 'x', provider: 'x', kind: 'create', description: 'Create a paused X Ads campaign with an existing funding instrument and account-currency budgets in integer micros. Preview is local.', payload: createCampaignSchema }),
    guardedWriteTool({ name: 'x_set_campaign_status', namespace: 'x', provider: 'x', kind: 'update', description: 'Pause or activate an existing X Ads campaign.', payload: setStatusSchema }),
    guardedWriteTool({ name: 'x_set_budget', namespace: 'x', provider: 'x', kind: 'update', description: 'Change an existing X Ads daily or total campaign budget in integer micros, preserving the other cap.', payload: setBudgetSchema }),
  ];
}
