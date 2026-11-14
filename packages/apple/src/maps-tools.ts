import { guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import { appleId } from './native-tools.js';
import type { AppleAdsProvider } from './provider.js';

const resourceId = z.string().regex(/^[A-Za-z0-9-]+$/);
const name = z.string().trim().min(1).max(255);
const status = z.enum(['PAUSED', 'ENABLED']).default('PAUSED');
const rule = z.object({ field: z.enum(['adminArea', 'locality', 'postalCode', 'locationId']), operator: z.enum(['EQUALS', 'NOT_EQUALS', 'IN', 'NOT_IN']), value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }).strict();
export const brandCampaignPayload = z.object({ name, brand_id: resourceId, countries_or_regions: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1), placement: z.enum(['MAPS_SEARCH_RESULTS', 'MAPS_SEARCH_HOME']).optional(), strategy: z.enum(['MAX_ENGAGEMENTS', 'MANUAL_CPT', 'MANUAL_CPM']).default('MAX_ENGAGEMENTS'), daily_budget: z.number().positive(), currency: z.string().regex(/^[A-Z]{3}$/), status });
export const brandGroupPayload = z.object({ name, campaign_id: appleId, location_group_ids: z.array(resourceId).min(1).max(100), start_time: z.iso.datetime({ precision: 3 }), bid: z.number().positive().optional(), status });
export const brandCreativePayload = z.object({ name, brand_id: resourceId, subtype: z.enum(['BUSINESS_LOGO', 'BUSINESS_ASSET']), asset_ids: z.array(resourceId).min(1).max(20), localized_text: z.record(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/), z.object({ promoText: z.string().trim().min(1) }).strict()), default_locale: z.string().min(1) }).refine(value => Object.hasOwn(value.localized_text, value.default_locale), 'default_locale must have localized promotional copy');
const members = { group_type: z.enum(['STATIC', 'DYNAMIC']), location_ids: z.array(resourceId).min(1).max(1000).optional(), rules: z.array(rule).min(1).max(100).optional() };
export const locationGroupPayload = z.object({ name, brand_id: resourceId, ...members, description: z.string().optional() }).refine(value => value.group_type === 'STATIC' ? Boolean(value.location_ids) && !value.rules : Boolean(value.rules) && !value.location_ids, 'STATIC groups require location_ids; DYNAMIC groups require rules');
export const updateLocationGroupPayload = z.object({ location_group_id: resourceId, name: name.optional(), description: z.string().optional(), location_ids: members.location_ids, rules: members.rules }).refine(value => ['name', 'description', 'location_ids', 'rules'].some(key => value[key as keyof typeof value] !== undefined), 'Provide a field to update').refine(value => !(value.location_ids && value.rules), 'Choose location_ids or rules');

export function appleMapsTools(_provider: AppleAdsProvider): AnyToolDefinition[] {
  return [
    guardedWriteTool({ name: 'apple_create_brand_campaign', namespace: 'apple', provider: 'apple', kind: 'create', description: 'Create a Maps campaign for an accessible Business Brand. Requires Apple Business Brand permissions. Choose MAX_ENGAGEMENTS, MANUAL_CPT or MANUAL_CPM; policy may force PAUSED. Omit placement for both Maps placements.', payload: brandCampaignPayload }),
    guardedWriteTool({ name: 'apple_create_brand_ad_group', namespace: 'apple', provider: 'apple', kind: 'create', description: 'Create a Maps ad group with validated location groups. Inherits campaign bidding/pricing; manual bidding requires bid in whole account-currency units. Policy may force PAUSED.', payload: brandGroupPayload }),
    guardedWriteTool({ name: 'apple_create_brand_creative', namespace: 'apple', provider: 'apple', kind: 'create', description: 'Create a Maps logo/asset creative from account-accessible brand assets and localized promo copy. Destination is the Maps place card. Wait for VALID before linking an ad.', payload: brandCreativePayload }),
    guardedWriteTool({ name: 'apple_create_location_group', namespace: 'apple', provider: 'apple', kind: 'create', description: 'Create a STATIC location-ID group or a DYNAMIC rule group for an accessible brand. Dynamic groups can remain PENDING until Apple finishes evaluation.', payload: locationGroupPayload }),
    guardedWriteTool({ name: 'apple_update_location_group', namespace: 'apple', provider: 'apple', kind: 'update', description: 'Rename a location group or replace its membership/rules within its current STATIC/DYNAMIC type. Omitted fields remain unchanged. Membership edits affect ad groups using this group.', payload: updateLocationGroupPayload }),
  ];
}
