import { z } from 'zod';
import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import type { LinkedInAdsProvider } from './provider.js';
import { createCampaignSchema, linkedinId, NON_DISCRIMINATION_NOTICE, setBudgetSchema, setStatusSchema } from './schemas.js';

export function linkedinTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'linkedin_list_campaigns', namespace: 'linkedin', description: 'List LinkedIn campaigns, including inactive campaigns.', input: z.object({ account_id: linkedinId }), annotations: { readOnly: true }, handler: input => provider.listCampaigns(input.account_id) }),
    defineTool({ name: 'linkedin_list_campaign_groups', namespace: 'linkedin', description: 'List LinkedIn campaign groups to select a parent for campaign creation.', input: z.object({ account_id: linkedinId }), annotations: { readOnly: true }, handler: input => provider.listCampaignGroups(input.account_id) }),
    guardedWriteTool({ name: 'linkedin_create_campaign', namespace: 'linkedin', provider: 'linkedin', kind: 'create', description: `Create a paused LinkedIn campaign with account-currency budgets in micros. Explicit non-political advertiser consent required. Preview is local. ${NON_DISCRIMINATION_NOTICE}`, payload: createCampaignSchema }),
    guardedWriteTool({ name: 'linkedin_set_campaign_status', namespace: 'linkedin', provider: 'linkedin', kind: 'update', description: 'Pause or activate a LinkedIn campaign. Activation requires explicit non-political advertiser consent.', payload: setStatusSchema }),
    guardedWriteTool({ name: 'linkedin_set_budget', namespace: 'linkedin', provider: 'linkedin', kind: 'update', description: 'Change an existing daily or total LinkedIn campaign budget in integer micros, preserving currency and other budget fields.', payload: setBudgetSchema }),
  ];
}
