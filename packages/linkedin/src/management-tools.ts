import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { LinkedInAdsProvider } from './provider.js';
import { linkedinId as id, NON_DISCRIMINATION_NOTICE, NON_POLITICAL_CONSENT, targetingSchema } from './schemas.js';

const micros = z.number().int().positive().safe(), time = z.number().int().positive().safe();
const name = z.string().trim().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 200, 'Name must fit 200 UTF-8 bytes');
export const groupCreate = z.object({ name, start_time: time, end_time: time.optional(), total_budget_micros: micros.optional(), status: z.enum(['DRAFT', 'ACTIVE']).default('DRAFT'), non_political_consent: z.literal(true).optional().describe(`Required for ACTIVE creation: ${NON_POLITICAL_CONSENT}`) }).refine(v => !v.end_time || v.end_time > v.start_time, 'End must follow start').refine(v => !v.total_budget_micros || Boolean(v.end_time), 'Group total budget requires end_time');
export const metadata = { name: name.optional(), start_time: time.optional(), end_time: time.optional() };
export const updateCampaign = z.object({ campaign_id: id, ...metadata }).refine(v => Object.keys(v).length > 1, 'Provide campaign changes');
export const updateGroup = z.object({ campaign_group_id: id, ...metadata }).refine(v => Object.keys(v).length > 1, 'Provide campaign-group changes');
export const targetingUpdate = z.object({ campaign_id: id, targeting_criteria: targetingSchema.optional(), audience_expansion_enabled: z.boolean().optional() }).refine(v => v.targeting_criteria !== undefined || v.audience_expansion_enabled !== undefined, 'Provide targeting or explicit expansion settings');

export function linkedinManagementTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  const account = { account_id: id };
  const read = <T extends z.ZodRawShape>(name: string, description: string, input: z.ZodObject<T>, handler: (input: z.output<z.ZodObject<T>>) => Promise<unknown>) => defineTool({ name, namespace: 'linkedin', description, input, annotations: { readOnly: true }, handler });
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove' = 'update') => guardedWriteTool({ name, namespace: 'linkedin', provider: 'linkedin', description, payload, kind });
  return [
    read('linkedin_get_campaign', 'Read exact account-owned campaign settings, native targeting, bid, budgets and schedule.', z.object({ ...account, campaign_id: id }), v => provider.getCampaign(v.account_id, v.campaign_id)),
    read('linkedin_get_campaign_group', 'Read one account-owned campaign group, including shared/dynamic budget settings and schedule.', z.object({ ...account, campaign_group_id: id }), v => provider.management.group(v.account_id, v.campaign_group_id)),
    read('linkedin_targeting_facets', `Read available native targeting facets and supported entity finders. ${NON_DISCRIMINATION_NOTICE}`, z.object(account), v => provider.management.facets(v.account_id)),
    read('linkedin_targeting_entities', 'Read the native adTargetingFacet finder for a selected facet and locale, using offset pagination. Typeahead/similar-entity finders remain separate.', z.object({ ...account, facet: z.string().regex(/^urn:li:adTargetingFacet:[A-Za-z]+$/), locale: z.object({ language: z.string().regex(/^[a-z]{2}$/), country: z.string().regex(/^[A-Z]{2}$/) }).optional(), start: z.number().int().nonnegative().default(0), count: z.number().int().min(1).max(100).default(50) }), v => provider.management.entities(v)),
    write('linkedin_create_campaign_group', 'Create a native DRAFT campaign group. paused_creation coerces requested ACTIVE to non-serving DRAFT because LinkedIn does not create groups as PAUSED. Optional total cap uses micros.', groupCreate, 'create'),
    write('linkedin_update_campaign_group', 'Edit supplied group name/start/end fields, preserving the existing schedule. Does not change status or budgeting mode.', updateGroup),
    write('linkedin_set_campaign_group_status', 'Pause, activate or archive an owned group. Activation requires explicit advertiser confirmation; affects eligibility of all contained campaigns.', z.object({ campaign_group_id: id, status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']), non_political_consent: z.literal(true).optional() })),
    write('linkedin_set_campaign_group_budget', 'Change an existing ordinary group lifetime cap in micros, preserving currency and end time. Dynamic group-budget mode is rejected.', z.object({ campaign_group_id: id, budget_micros: micros })),
    write('linkedin_delete_campaign_group', 'Delete an empty draft group or request PENDING_DELETION for other states. Rejects groups containing non-removed campaigns; clean children first.', z.object({ campaign_group_id: id }), 'remove'),
    write('linkedin_update_campaign', 'Edit supplied campaign name/start/end fields, preserving omitted settings and status.', updateCampaign),
    write('linkedin_update_targeting', `Replace supplied include clauses while preserving an omitted exclusion clause. Expansion changes must be explicit. ${NON_DISCRIMINATION_NOTICE}`, targetingUpdate),
    write('linkedin_set_bid', 'Change an existing campaign unitCost in integer micros, preserving its currency, pricing model and bidding strategy. Current value is required for policy checks.', z.object({ campaign_id: id, bid_micros: micros })),
    write('linkedin_delete_campaign', 'Delete a draft campaign or request PENDING_DELETION for a non-draft. Rejects campaigns with non-removed creatives; clean children first.', z.object({ campaign_id: id }), 'remove'),
  ];
}
