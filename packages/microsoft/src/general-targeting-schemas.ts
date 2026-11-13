import { z } from 'zod';
import { microsoftId as id } from './native.js';
import { bidType, criterionType, deviceAdjustment, intent, target, validateTargetBatch } from './targeting-schemas.js';

export const targetSelection = z.discriminatedUnion('type', [z.object({ type: z.literal('Campaign'), campaign_id: id }).strict(), z.object({ type: z.literal('AdGroup'), campaign_id: id, ad_group_id: id }).strict()]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const targetingRead = z.object({ account_id: id, target: targetSelection, criterion_types: z.array(criterionType).min(1).max(7).refine(values => new Set(values).size === values.length, 'Use unique types').default([...criterionType.options]), page_size: z.number().int().min(1).max(200).default(50), cursor: z.string().max(2048).optional() }).strict();
const change = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), targets: z.array(target).min(1).max(1000) }).strict().superRefine(validateTargetBatch),
  z.object({ action: z.literal('set_bid'), criterion_id: id, criterion_type: bidType, bid_adjustment_percent: deviceAdjustment }).strict().refine(value => value.criterion_type === 'Device' || value.bid_adjustment_percent >= -90, 'Only devices support adjustments below -90 percent'),
  z.object({ action: z.literal('remove'), criterion_ids: z.array(id).min(1).max(1000).refine(values => new Set(values).size === values.length, 'Use unique IDs') }).strict(),
  z.object({ action: z.literal('set_location_intent'), criterion_id: id, intent_option: intent }).strict(),
  z.object({ action: z.literal('set_schedule_clock'), use_searcher_time_zone: z.boolean() }).strict(),
]);
export const targetingWrite = z.object({ target: targetSelection, expected_context_hash: hash, acknowledge_delivery_effects: z.literal(true), change }).strict();
