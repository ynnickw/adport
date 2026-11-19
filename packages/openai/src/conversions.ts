import { AdportError, defineTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { OpenAIAdsProvider } from './provider.js';
import { openaiId } from './schemas.js';

// Conversions API reads, OpenAPI 2.3.0 (reviewed 2026-11-17). Raw event payloads are never returned.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const sourceSchema = z.looseObject({ id: z.string(), name: z.string(), client_type: z.string(), pixel_id: z.string() });
export const eventSettingSchema = z.looseObject({
  id: z.string(), name: z.string(), event_type: z.string(), custom_event_name: z.string().nullable(), attribution_window_days: z.number().int(),
  source_ids: z.array(z.string()), campaigns: z.array(z.looseObject({ id: z.string(), name: z.string() })), archived: z.boolean(),
});
export const receivedEventSchema = z.object({
  data_source_id: z.string(), event_type: z.string(), custom_event_name: z.string().nullable(), action_source: z.string().nullable(),
  event_timestamp_ms: z.number().int(), received_at_ms: z.number().int(), api_channel: z.string(),
});
export const conversionRowSchema = z.looseObject({
  entity_id: z.string(), conversions: z.number().int(), date: z.string().optional(), country: z.string().optional(), device: z.string().optional(),
  click_through_conversions: z.number().int().optional(), view_through_conversions: z.number().int().optional(),
  order_created_attributed_sales: z.string().nullable().optional(), order_created_attributed_sales_currency: z.string().optional(),
  attributed_events: z.array(z.looseObject({ entity_id: z.string(), event_name: z.string(), event_kind: z.string(), attributed_event_count: z.number().int() })).optional(),
});
const insightsSchema = z.looseObject({ data: z.array(conversionRowSchema), count: z.number().int(), account_currency: z.string().optional() });

export const conversionInsightsInput = z.object({
  account_id: openaiId,
  since: isoDate.describe('First day, account time zone'),
  until: isoDate.describe('Last day, inclusive, account time zone'),
  aggregation_level: z.enum(['campaign', 'ad_group', 'ad']).default('campaign'),
  entity_ids: z.array(openaiId).min(1).max(500).optional().describe('Report per entity; omit for account totals'),
  time_granularity: z.enum(['none', 'daily']).default('none'),
  breakdown: z.enum(['device', 'country']).optional(),
  attribution_window_days: z.union([z.literal(7), z.literal(14), z.literal(30)]).optional(),
  view_through_attribution_window_days: z.union([z.literal(0), z.literal(1)]).optional(),
  include_events: z.boolean().default(false).describe('Add attributed standard and custom events per row'),
  event_names: z.array(z.string().min(1).max(256)).min(1).max(500).optional().describe('Requires include_events'),
}).refine(input => input.since <= input.until, 'since must not be after until')
  .refine(input => !input.event_names || input.include_events, 'event_names requires include_events');

export async function conversionInsights(provider: OpenAIAdsProvider, input: z.infer<typeof conversionInsightsInput>) {
  await provider.accountMetadata(input.account_id);
  const body = {
    aggregation_level: input.aggregation_level, time_granularity: input.time_granularity,
    time_ranges: [JSON.stringify({ type: 'date_range', since: input.since, until: input.until })],
    ...(input.entity_ids ? { entity_ids: input.entity_ids, group_by_entity: true } : { group_by_entity: false }),
    ...(input.breakdown ? { breakdown: input.breakdown } : {}),
    ...(input.attribution_window_days !== undefined ? { attribution_window_days: input.attribution_window_days } : {}),
    ...(input.view_through_attribution_window_days !== undefined ? { view_through_attribution_window_days: input.view_through_attribution_window_days } : {}),
    ...(input.include_events ? { include: ['attributed_events'] } : {}),
    ...(input.event_names ? { event_names: input.event_names } : {}),
  };
  const result = await provider.api.post('conversions/insights', insightsSchema, body);
  if (result.count !== result.data.length) throw new AdportError('PROVIDER_ERROR', 'openai: conversion insights count does not match the returned rows');
  return result;
}

export function openaiConversionTools(provider: OpenAIAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'openai_conversion_sources', namespace: 'openai', description: 'List OpenAI Ads conversion data sources (pixel and Conversions API) with their pixel_id.',
      input: z.object({ account_id: openaiId }), annotations: { readOnly: true },
      handler: async input => { await provider.accountMetadata(input.account_id); return provider.api.list('conversions/pixels', sourceSchema, { limit: '500' }); } }),
    defineTool({ name: 'openai_conversion_event_settings', namespace: 'openai', description: 'List OpenAI Ads conversion events (goals): event type, attribution window, sources and the campaigns optimizing on each.',
      input: z.object({ account_id: openaiId }), annotations: { readOnly: true },
      handler: async input => { await provider.accountMetadata(input.account_id); return provider.api.list('conversions/event_settings', eventSettingSchema, { limit: '500' }); } }),
    defineTool({ name: 'openai_conversion_events', namespace: 'openai', description: 'Show the latest events received by one conversion source (type, channel, event and receipt times) to check that browser or server tracking arrives. Event payloads are not returned.',
      input: z.object({ account_id: openaiId, pixel_id: z.string().min(1).max(256).describe('pixel_id from openai_conversion_sources'), limit: z.number().int().min(1).max(50).default(50) }), annotations: { readOnly: true },
      handler: async input => {
        await provider.accountMetadata(input.account_id);
        const result = await provider.api.get('conversions/events', z.looseObject({ data: z.array(receivedEventSchema) }), { pid: input.pixel_id, limit: String(input.limit) });
        return { pixel_id: input.pixel_id, events: result.data.map(event => ({
          ...event, event_time: new Date(event.event_timestamp_ms).toISOString(), received_at: new Date(event.received_at_ms).toISOString(),
        })) };
      } }),
    defineTool({ name: 'openai_conversion_insights', namespace: 'openai', description: 'OpenAI Ads goal conversions (click-through and view-through), attributed sales and optional per-event counts for a date range, per entity or for the whole account.',
      input: conversionInsightsInput, annotations: { readOnly: true }, handler: input => conversionInsights(provider, input) }),
  ];
}
