import { z } from 'zod';
import { microsoftId } from './native.js';

// Preserve Microsoft's dateTime precision (100ns) rather than truncating identities to JS milliseconds.
export const offlineTime = z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/, 'Use a UTC timestamp with seconds and at most seven fractional digits');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(512).regex(/^[^\s\x00-\x1f\x7f]+$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const identity = z.object({
  microsoft_click_id: identifier.optional(),
  hashed_email_address: hash.optional(),
  hashed_phone_number: hash.optional(),
  conversion_time: offlineTime,
}).strict();
const identified = (value: z.infer<typeof identity>) => !!(value.microsoft_click_id || value.hashed_email_address || value.hashed_phone_number);
export const offlineConversion = identity.extend({
  conversion_value: z.number().finite().optional(),
  conversion_currency_code: currency.optional(),
  external_attribution_credit: z.number().finite().gt(0).max(1).optional(),
  external_attribution_model: z.string().min(1).max(512).optional(),
}).strict().refine(identified, 'Supply a Microsoft click ID or an already hashed email/phone identifier');
const adjustment = identity.extend({ adjustment_time: offlineTime });
export const offlineAdjustment = z.discriminatedUnion('adjustment_type', [
  adjustment.extend({ adjustment_type: z.literal('Restate'), adjustment_value: z.number().finite(), adjustment_currency_code: currency }).strict(),
  adjustment.extend({ adjustment_type: z.literal('Retract') }).strict(),
]).refine(identified, 'Supply the original Microsoft click ID or already hashed email/phone identifiers');
const binding = z.object({
  goal_id: microsoftId,
  expected_goal_hash: hash,
  acknowledge_measurement_effects: z.literal(true),
}).strict();
export const offlineUpload = binding.extend({ conversions: z.array(offlineConversion).min(1).max(1000) }).strict();
export const offlineAdjustments = binding.extend({ adjustments: z.array(offlineAdjustment).min(1).max(1000) }).strict();

export function offlineTimeTicks(value: string): bigint {
  const [whole, fraction = ''] = value.slice(0, -1).split('.');
  return BigInt(Date.parse(`${whole}Z`)) * 10_000n + BigInt(fraction.padEnd(7, '0'));
}
