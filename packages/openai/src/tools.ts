import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import {
  createCampaignSchema, listAdGroupsSchema, listAdsSchema, listCampaignsSchema,
  setAdGroupStatusSchema, setAdStatusSchema, setBudgetSchema, setCampaignStatusSchema,
} from './schemas.js';
import type { OpenAIAdsProvider } from './provider.js';
import { openaiConversionTools } from './conversions.js';

export function openaiTools(provider: OpenAIAdsProvider): AnyToolDefinition[] {
  return [
    ...openaiConversionTools(provider),
    defineTool({ name: 'openai_list_campaigns', namespace: 'openai', description: 'List OpenAI Ads (ChatGPT ads) campaigns in the connected ad account, with status and budgets in micros.',
      input: listCampaignsSchema, annotations: { readOnly: true }, handler: input => provider.listCampaigns(input.account_id) }),
    defineTool({ name: 'openai_ad_groups', namespace: 'openai', description: 'List OpenAI Ads ad groups, optionally for one campaign.',
      input: listAdGroupsSchema, annotations: { readOnly: true }, handler: input => provider.listAdGroups(input.account_id, input.campaign_id) }),
    defineTool({ name: 'openai_ads', namespace: 'openai', description: 'List OpenAI Ads ads with status and review status, optionally for one ad group.',
      input: listAdsSchema, annotations: { readOnly: true }, handler: input => provider.listAds(input.account_id, input.ad_group_id) }),
    guardedWriteTool({ name: 'openai_create_campaign', namespace: 'openai', provider: 'openai', kind: 'create',
      description: 'Create an OpenAI Ads campaign, paused by default. Spend limits use integer micros (minimum 1,000,000); targeting accepts countries or location IDs. Conversion bidding requires one event setting. Preview is local, not server validation.', payload: createCampaignSchema }),
    guardedWriteTool({ name: 'openai_set_campaign_status', namespace: 'openai', provider: 'openai', kind: 'update',
      description: 'Pause or activate an OpenAI Ads campaign; reads its current status first.', payload: setCampaignStatusSchema }),
    guardedWriteTool({ name: 'openai_set_ad_group_status', namespace: 'openai', provider: 'openai', kind: 'update',
      description: 'Pause or activate an OpenAI Ads ad group; reads its current status first.', payload: setAdGroupStatusSchema }),
    guardedWriteTool({ name: 'openai_set_ad_status', namespace: 'openai', provider: 'openai', kind: 'update',
      description: 'Pause or activate an OpenAI Ads ad; reads its current status first.', payload: setAdStatusSchema }),
    guardedWriteTool({ name: 'openai_set_budget', namespace: 'openai', provider: 'openai', kind: 'update',
      description: 'Set an OpenAI Ads campaign daily or lifetime spend limit in integer micros; reads the existing value for policy checks and keeps the other limit.', payload: setBudgetSchema }),
  ];
}
