import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { XAdsProvider } from './provider.js';
import { xId as id } from './schemas.js';

export const micros = z.number().int().positive().safe(), objective = z.enum(['APP_ENGAGEMENTS', 'APP_INSTALLS', 'REACH', 'FOLLOWERS', 'ENGAGEMENTS', 'VIDEO_VIEWS', 'PREROLL_VIEWS', 'WEBSITE_CLICKS']);
const placement = z.enum(['ALL_ON_TWITTER', 'PUBLISHER_NETWORK', 'TAP_BANNER', 'TAP_FULL', 'TAP_FULL_LANDSCAPE', 'TAP_NATIVE', 'TAP_MRECT', 'TWITTER_PROFILE', 'TWITTER_REPLIES', 'TWITTER_SEARCH', 'TWITTER_TIMELINE']);
const time = z.iso.datetime({ offset: true }), name = z.string().min(1).max(255);
export const createLine = z.object({ campaign_id: id, name, objective, product_type: z.enum(['MEDIA', 'PROMOTED_ACCOUNT', 'PROMOTED_TWEETS']), placements: z.array(placement).min(1).max(10).refine(v => new Set(v).size === v.length, 'Use unique placements'), start_time: time, end_time: time, status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'), bid_strategy: z.enum(['AUTO', 'MAX', 'TARGET']).default('AUTO'), bid_micros: micros.optional(), daily_budget_micros: micros.optional(), total_budget_micros: micros.optional(), android_app_store_identifier: z.string().min(1).optional(), ios_app_store_identifier: z.string().regex(/^\d+$/).optional(), advertiser_domain: z.string().regex(/^(?![.-])[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/).optional(), categories: z.array(z.string().min(1)).optional(), standard_delivery: z.boolean().default(true) }).refine(v => Date.parse(v.end_time) > Date.parse(v.start_time), 'End must follow start').refine(v => v.daily_budget_micros === undefined || v.total_budget_micros === undefined || v.daily_budget_micros <= v.total_budget_micros, 'Daily budget cannot exceed total');
export const updateLine = z.object({ line_item_id: id, name: name.optional(), start_time: time.optional(), end_time: time.optional() }).refine(v => Object.keys(v).length > 1, 'Provide line-item changes');
export const setLineBid = z.object({ line_item_id: id, bid_strategy: z.enum(['AUTO', 'MAX', 'TARGET']).optional(), bid_micros: micros.optional() }).refine(v => v.bid_strategy !== undefined || v.bid_micros !== undefined, 'Provide bid settings');

export function xManagementTools(provider: XAdsProvider): AnyToolDefinition[] {
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove' = 'update') => guardedWriteTool({ name, namespace: 'x', provider: 'x', description, payload, kind });
  return [
    defineTool({ name: 'x_line_item_placements', namespace: 'x', description: 'Read current native placement combinations by product type after verifying access to the selected account.', input: z.object({ account_id: id }), annotations: { readOnly: true }, handler: async v => { await provider.getAccount(v.account_id); return provider.lineItemPlacements(); } }),
    write('x_create_line_item', 'Create a paused X ad group with explicit objective, product, placements and flight. Budgets/bids use micros; AUTO cannot claim a monetary bid cap. Parent currency and sibling format are checked.', createLine, 'create'),
    write('x_update_line_item', 'Edit supplied line-item name/start/end fields, preserving omitted schedule bounds and delivery status.', updateLine),
    write('x_set_line_item_status', 'Pause or activate a verified line item using native PUT. Draft/deleted line items are rejected.', z.object({ line_item_id: id, status: z.enum(['PAUSED', 'ACTIVE']) })),
    write('x_set_line_item_budget', 'Change an existing line-item daily or total cap in integer micros, preserving the other cap and using current values for policy checks.', z.object({ line_item_id: id, budget_type: z.enum(['DAILY', 'TOTAL']), budget_micros: micros })),
    write('x_set_line_item_bidding', 'Change native AUTO/MAX/TARGET bidding with current monetary values. Removing a bounded bid via AUTO is rejected because policy cannot represent an unbounded change.', setLineBid),
    write('x_delete_line_item', 'Delete a verified line item only after its promoted posts/accounts/media creatives are removed. Native receipt must confirm deletion.', z.object({ line_item_id: id }), 'remove'),
  ];
}
