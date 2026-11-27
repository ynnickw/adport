import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import {
  billingInputSchema, billingSchema, conversionPageSchema, createCampaignSchema, listAdGroupsSchema, listCampaignsSchema, listConversionsSchema,
  adSchema, conversionStatsInput, conversionStatsSchema, createAdGroupSchema, createAdSchema, createPixelSchema, getAdSchema, pixelSchema,
  setAdGroupStatusSchema, setAdStatusSchema, setBudgetSchema, setCampaignStatusSchema,
} from './schemas.js';
import type { GravityProvider } from './provider.js';

/** Follows `next_cursor` until `has_more` is false or `limit` rows were read. */
export async function listConversions(provider: GravityProvider, input: z.infer<typeof listConversionsSchema>) {
  await provider.assertAccount(input.account_id);
  const items: z.infer<typeof conversionPageSchema>['conversions'] = [];
  const seen = new Set<string>(), ids = new Set<string>();
  const totalKeys = ['total_conversions', 'total_click_through_conversions', 'total_view_through_conversions'] as const;
  const totals: Partial<Record<typeof totalKeys[number], number>> = {};
  let cursor: string | undefined;
  while (true) {
    const page = await provider.api.get('conversions', conversionPageSchema, {
      limit: String(Math.min(100, input.limit - items.length)), cursor,
      campaign_id: input.campaign_id, event_type: input.event_type, attribution_type: input.attribution_type,
    });
    for (const conversion of page.conversions) {
      if (ids.has(conversion.conversion_id)) throw new AdportError('PROVIDER_ERROR', 'gravity: conversion pagination returned overlapping rows');
      ids.add(conversion.conversion_id);
      items.push(conversion);
    }
    for (const key of totalKeys) if (page[key] !== undefined) totals[key] ??= page[key];
    if (items.length > input.limit || (items.length === input.limit && page.has_more)) return { items: items.slice(0, input.limit), truncated: true, ...totals };
    if (!page.has_more) return { items, ...totals };
    if (!page.conversions.length) throw new AdportError('PROVIDER_ERROR', 'gravity: conversion pagination returned an empty intermediate page');
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
    defineTool({ name: 'gravity_get_ad', namespace: 'gravity', description: 'Read a Gravity ad by ID, including creative, source, status and review status.',
      input: getAdSchema, annotations: { readOnly: true }, handler: async input => {
        await provider.assertAccount(input.account_id);
        const ad = await provider.api.get(`ads/${input.ad_id}`, adSchema);
        if (ad.id !== input.ad_id) throw new AdportError('PROVIDER_ERROR', 'gravity: ad response does not match the requested ad');
        return ad;
      } }),
    defineTool({ name: 'gravity_pixels', namespace: 'gravity', description: 'List conversion pixels and their installation status. A null status means verification is pending or unavailable.',
      input: billingInputSchema, annotations: { readOnly: true }, handler: async input => {
        await provider.assertAccount(input.account_id);
        return { items: await provider.api.get('pixels', z.array(pixelSchema)) };
      } }),
    defineTool({ name: 'gravity_conversion_stats', namespace: 'gravity', description: 'Read conversion totals by day and event type for a lookback or date range.',
      input: conversionStatsInput, annotations: { readOnly: true }, handler: async input => {
        await provider.assertAccount(input.account_id);
        return provider.api.get('events/conversion-stats', conversionStatsSchema, {
          days: input.days?.toString(), start_date: input.start_date, end_date: input.end_date, event_type: input.event_type,
        });
      } }),
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
    guardedWriteTool({ name: 'gravity_create_ad_group', namespace: 'gravity', provider: 'gravity', kind: 'create',
      description: 'Create a paused manual or generative ad group in a Gravity campaign. Generative groups need target context.', payload: createAdGroupSchema }),
    guardedWriteTool({ name: 'gravity_create_ad', namespace: 'gravity', provider: 'gravity', kind: 'create',
      description: 'Create an authored ad in a manual Gravity ad group. Defaults to paused.', payload: createAdSchema }),
    guardedWriteTool({ name: 'gravity_create_pixel', namespace: 'gravity', provider: 'gravity', kind: 'create',
      description: 'Register a site conversion pixel. Gravity checks the installation after creation.', payload: createPixelSchema }),
  ];
}
