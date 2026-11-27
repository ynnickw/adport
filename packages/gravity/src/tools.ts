import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import type { z } from 'zod';
import {
  billingInputSchema, billingSchema, conversionPageSchema, createCampaignSchema, listAdGroupsSchema, listCampaignsSchema, listConversionsSchema,
  setAdGroupStatusSchema, setAdStatusSchema, setBudgetSchema, setCampaignStatusSchema,
} from './schemas.js';
import type { GravityProvider } from './provider.js';

/** Follows `next_cursor` until `has_more` is false or `limit` rows were read. */
export async function listConversions(provider: GravityProvider, input: z.infer<typeof listConversionsSchema>) {
  await provider.assertAccount(input.account_id);
  const items: z.infer<typeof conversionPageSchema>['conversions'] = [], seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await provider.api.get('conversions', conversionPageSchema, {
      limit: String(Math.min(100, input.limit - items.length)), cursor,
      campaign_id: input.campaign_id, event_type: input.event_type, attribution_type: input.attribution_type,
    });
    items.push(...page.conversions);
    const totals = {
      ...(page.total_conversions !== undefined ? { total_conversions: page.total_conversions } : {}),
      ...(page.total_click_through_conversions !== undefined ? { total_click_through_conversions: page.total_click_through_conversions } : {}),
      ...(page.total_view_through_conversions !== undefined ? { total_view_through_conversions: page.total_view_through_conversions } : {}),
    };
    if (!page.has_more) return { items, ...totals };
    if (items.length >= input.limit) return { items: items.slice(0, input.limit), truncated: true, ...totals };
    const next = page.next_cursor ?? undefined;
    if (!next || seen.has(next) || seen.size >= 1000) throw new AdportError('PROVIDER_ERROR', 'gravity: pagination did not terminate; refusing incomplete results');
    seen.add(next);
    cursor = next;
  }
}

export function gravityTools(provider: GravityProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'gravity_list_campaigns', namespace: 'gravity', description: 'List Gravity campaigns (ads in AI assistants) with status, delivery status, budgets in dollars and lifetime totals.',
      input: listCampaignsSchema, annotations: { readOnly: true }, handler: input => provider.listCampaigns(input.account_id, input.status) }),
    defineTool({ name: 'gravity_ad_groups', namespace: 'gravity', description: 'List Gravity ad groups (generative or manual) with up to 100 ads each, optionally for one campaign.',
      input: listAdGroupsSchema, annotations: { readOnly: true }, handler: input => provider.listAdGroups(input.account_id, input.campaign_id, input.include_archived) }),
    defineTool({ name: 'gravity_conversions', namespace: 'gravity', description: 'List recent Gravity conversions (event type, value in cents, source, click- or view-through attribution) to check that pixel or server tracking arrives.',
      input: listConversionsSchema, annotations: { readOnly: true }, handler: input => listConversions(provider, input) }),
    defineTool({ name: 'gravity_billing', namespace: 'gravity', description: 'Show the Gravity billing summary: total spend, billed, unbilled and credits in dollars.',
      input: billingInputSchema, annotations: { readOnly: true },
      handler: async input => { await provider.assertAccount(input.account_id); return provider.api.get('billing', billingSchema); } }),
    guardedWriteTool({ name: 'gravity_create_campaign', namespace: 'gravity', provider: 'gravity', kind: 'create',
      description: 'Create a draft or paused Gravity campaign with one generative ad group built from a target context. Exactly one daily or total budget in micros (whole cents); total budgets need end_time. Conversions campaigns need conversion_type. Preview is local.', payload: createCampaignSchema }),
    guardedWriteTool({ name: 'gravity_set_campaign_status', namespace: 'gravity', provider: 'gravity', kind: 'update',
      description: 'Pause or activate a Gravity campaign; reads its current status first. Activation can fail on billing or the conversion event check.', payload: setCampaignStatusSchema }),
    guardedWriteTool({ name: 'gravity_set_ad_group_status', namespace: 'gravity', provider: 'gravity', kind: 'update',
      description: 'Pause or activate a Gravity ad group; reads its current status first.', payload: setAdGroupStatusSchema }),
    guardedWriteTool({ name: 'gravity_set_ad_status', namespace: 'gravity', provider: 'gravity', kind: 'update',
      description: 'Pause or activate a manual Gravity ad; generated ads are refused. Reads its current status first.', payload: setAdStatusSchema }),
    guardedWriteTool({ name: 'gravity_set_budget', namespace: 'gravity', provider: 'gravity', kind: 'update',
      description: 'Update a Gravity campaign’s existing daily or total budget, in micros (whole cents); reads the current value for policy checks. Budget-type changes are not supported.', payload: setBudgetSchema }),
  ];
}
