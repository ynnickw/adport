import { z } from 'zod';
import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { createCampaignSchema, pinterestId, setBudgetSchema, setStatusSchema } from './schemas.js';
import type { PinterestAdsProvider } from './provider.js';
import { pinterestCreativeTools } from './creative-tools.js';
import { pinterestAssetTools } from './assets.js';
import { pinterestKeywordTools } from './keywords.js';
import { pinterestAudienceTools } from './audiences.js';
import { pinterestMeasurementTools } from './measurement.js';
import { pinterestCatalogTools } from './catalogs.js';
import { pinterestProductGroupTools } from './product-group-tools.js';
import { pinterestCatalogItemTools } from './catalog-item-tools.js';

export function pinterestTools(provider: PinterestAdsProvider): AnyToolDefinition[] {
  return [
    ...pinterestAssetTools(provider),
    ...pinterestKeywordTools(provider),
    ...pinterestAudienceTools(provider),
    ...pinterestMeasurementTools(provider),
    ...pinterestCatalogTools(provider),
    ...pinterestProductGroupTools(provider),
    ...pinterestCatalogItemTools(provider),
    ...pinterestCreativeTools(provider),
    defineTool({ name: 'pinterest_list_campaigns', namespace: 'pinterest', description: 'List Pinterest campaigns, including archived and draft entities.', input: z.object({ account_id: pinterestId }), annotations: { readOnly: true }, handler: input => provider.listCampaigns(input.account_id) }),
    guardedWriteTool({ name: 'pinterest_create_campaign', namespace: 'pinterest', provider: 'pinterest', kind: 'create', description: 'Create a Pinterest CBO campaign, paused by policy. Budgets are account-currency micros; lifetime budgets require an end time. Preview is local.', payload: createCampaignSchema }),
    guardedWriteTool({ name: 'pinterest_set_campaign_status', namespace: 'pinterest', provider: 'pinterest', kind: 'update', description: 'Pause or activate an existing Pinterest campaign.', payload: setStatusSchema }),
    guardedWriteTool({ name: 'pinterest_set_budget', namespace: 'pinterest', provider: 'pinterest', kind: 'update', description: 'Change an existing Pinterest CBO campaign budget in micros, preserving its daily/lifetime type.', payload: setBudgetSchema }),
  ];
}
