import { z } from 'zod';
import { xId } from './schemas.js';

export const prerollCtaValues = ['GO_TO', 'SEE_MORE', 'SHOP', 'VISIT_SITE', 'WATCH_NOW'] as const;
export const prerollCtaLabels: Record<typeof prerollCtaValues[number], string> = { GO_TO: 'Go to', SEE_MORE: 'See more', SHOP: 'Shop', VISIT_SITE: 'Visit site', WATCH_NOW: 'Watch now' };
const hash = z.string().regex(/^[a-f0-9]{64}$/), button = z.enum(prerollCtaValues);
const destination = z.string().url().max(4096).refine(value => { const url = new URL(value);return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\x00-\x1f\x7f]/.test(value); }, 'Use an HTTP(S) destination without embedded credentials or control characters');
export const nativePrerollCta = z.object({ id: xId, line_item_id: xId, call_to_action: z.string().min(1), call_to_action_url: z.string(), deleted: z.boolean(), account_id: xId.optional() });
export const prerollCtaList = z.object({ account_id: xId, line_item_id: xId.optional(), count: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(4096).optional(), with_deleted: z.boolean().default(false) }).strict();
export const prerollCtaSelection = z.object({ line_item_id: xId, call_to_action: button, call_to_action_url: destination }).strict();
export const createPrerollCta = prerollCtaSelection.extend({ expected_context_hash: hash, acknowledge_ad_group_scope: z.literal(true) }).strict();
export const updatePrerollCta = z.object({ preroll_call_to_action_id: xId, expected_context_hash: hash, acknowledge_ad_group_scope: z.literal(true), call_to_action: button.optional(), call_to_action_url: destination.optional() }).strict().refine(input => input.call_to_action !== undefined || input.call_to_action_url !== undefined, 'Provide a CTA button or destination change');
export const deletePrerollCta = z.object({ preroll_call_to_action_id: xId, expected_context_hash: hash, acknowledge_ad_group_scope: z.literal(true) }).strict();
export const prerollCtaWrites = new Set(['x_create_preroll_cta', 'x_update_preroll_cta', 'x_delete_preroll_cta']);
