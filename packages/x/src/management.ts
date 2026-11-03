import { AdportError, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import type { XParams } from './client.js';
import { XAdsEntities } from './entities.js';
import { createLine, micros, setLineBid, updateLine } from './management-tools.js';
import { lineItemSchema, xId as id } from './schemas.js';
import type { XWritePlan } from './writes.js';

type Line = z.infer<typeof lineItemSchema>;
export class XManagementService {
  constructor(private readonly entities: XAdsEntities) {}
  private bid(objective: string, strategy: string, amount: unknown, create: boolean) {
    if (strategy === 'AUTO' && amount !== undefined) throw new AdportError('INVALID_INPUT', 'x: AUTO ignores bid amounts; do not supply a purported monetary cap');
    if (strategy !== 'AUTO' && !micros.safeParse(amount).success) throw new AdportError('INVALID_INPUT', 'x: MAX/TARGET require a positive safe integer bid in micros');
    if (strategy === 'MAX' && ['REACH', 'FOLLOWERS'].includes(objective)) throw new AdportError('INVALID_INPUT', 'x: MAX is unavailable for REACH/FOLLOWERS');
    if (strategy === 'TARGET' && !(create ? ['REACH', 'FOLLOWERS', 'WEBSITE_CLICKS'] : ['REACH', 'WEBSITE_CLICKS']).includes(objective)) throw new AdportError('INVALID_INPUT', 'x: TARGET is not documented for this objective/operation');
  }
  private async receipt(method: 'POST' | 'PUT' | 'DELETE', path: string, params: XParams, currency: string, expected: Record<string, unknown>) {
    const { data } = await this.entities.client.request(method, path, z.object({ data: lineItemSchema }), params);
    const matches = (key: string, value: unknown) => value === null ? data[key] === null : ['placements', 'categories'].includes(key) ? Array.isArray(data[key]) && [...data[key]].sort().join(',') === String(value).split(',').sort().join(',') : ['start_time', 'end_time'].includes(key) ? Date.parse(String(data[key])) === Date.parse(String(value)) : data[key] === value;
    if (data.currency !== currency || Object.entries(expected).some(([key, value]) => !matches(key, value))) throw new AdportError('PROVIDER_ERROR', 'x: line-item receipt ID/parent/status/money mismatch; reconcile before retrying', { resource_ids: [data.id] });
    return [data.id];
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<XWritePlan> {
    const account = id.parse(op.accountId), create = op.tool === 'x_create_line_item', remove = op.tool === 'x_delete_line_item';
    if (op.provider !== 'x' || op.kind !== (create ? 'create' : remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'x: provider or line-item operation kind mismatch');
    const base = `accounts/${account}/line_items`, coercions: string[] = [], budgetDeltas: XWritePlan['budgetDeltas'] = [];
    let current: Line | undefined, params: XParams = {}, expected: Record<string, unknown>, path = base, method: 'POST' | 'PUT' | 'DELETE' = create ? 'POST' : 'PUT';
    if (create) {
      const input = createLine.parse(op.payload), campaign = await this.entities.getCampaign(account, input.campaign_id);
      if (campaign.deleted || campaign.entity_status === 'DRAFT' || campaign.budget_optimization !== 'LINE_ITEM') throw new AdportError('INVALID_INPUT', 'x: creation requires an existing non-deleted/non-draft LINE_ITEM-budget campaign');
      const choices = await this.entities.lineItemPlacements(), selected = [...input.placements].sort().join(',');
      if (!choices.data.some(value => value.product_type === input.product_type && value.placements.some(placements => [...placements].sort().join(',') === selected))) throw new AdportError('INVALID_INPUT', 'x: placement combination is unavailable for this product; inspect x_line_item_placements');
      const siblings = (await this.entities.listLineItems(account)).filter(value => value.campaign_id === input.campaign_id && !value.deleted);
      if (siblings.some(value => value.objective !== input.objective || value.product_type !== input.product_type)) throw new AdportError('INVALID_INPUT', 'x: all campaign line items must share product_type and objective');
      this.bid(input.objective, input.bid_strategy, input.bid_micros, true);
      if (['APP_INSTALLS', 'APP_ENGAGEMENTS'].includes(input.objective) && !input.android_app_store_identifier && !input.ios_app_store_identifier) throw new AdportError('INVALID_INPUT', 'x: app objectives need an explicit app-store identifier; native platform targeting is added automatically');
      if (input.placements.includes('PUBLISHER_NETWORK') && (!input.advertiser_domain || !input.categories?.length)) throw new AdportError('INVALID_INPUT', 'x: publisher placement needs advertiser_domain and IAB categories');
      const status = guard.forcePausedCreation ? 'PAUSED' : input.status;
      if (status !== input.status) coercions.push('entity_status coerced to PAUSED by policy (paused_creation)');
      params = { campaign_id: input.campaign_id, name: input.name, objective: input.objective, product_type: input.product_type, placements: input.placements.join(','), start_time: input.start_time, end_time: input.end_time, entity_status: status, bid_strategy: input.bid_strategy, standard_delivery: input.standard_delivery };
      for (const key of ['android_app_store_identifier', 'ios_app_store_identifier', 'advertiser_domain'] as const) if (input[key] !== undefined) params[key] = input[key];
      if (input.categories) params.categories = input.categories.join(',');
      for (const [source, target] of [['bid_micros', 'bid_amount_local_micro'], ['daily_budget_micros', 'daily_budget_amount_local_micro'], ['total_budget_micros', 'total_budget_amount_local_micro']] as const) if (input[source] !== undefined) { params[target] = input[source]; budgetDeltas.push({ target: `new line item ${target}`, toMicros: input[source] }); }
      expected = { ...params, deleted: false };
      return { summary: `Create X line item ${input.name}`, changes: [`Native POST ${base}: ${JSON.stringify(params)}; currency ${campaign.currency}. ${input.android_app_store_identifier || input.ios_app_store_identifier ? 'Native app-store parameters add platform targeting.' : ''}`], coercions, budgetDeltas, execute: () => this.receipt('POST', base, params, campaign.currency, expected) };
    }
    current = await this.entities.getLineItem(account, id.parse(op.payload.line_item_id));
    if (current.deleted || current.entity_status === 'DRAFT') throw new AdportError('INVALID_INPUT', 'x: deleted/draft line items are not editable through this workflow');
    const parent = await this.entities.getCampaign(account, current.campaign_id);
    if (!remove && (parent.deleted || parent.entity_status === 'DRAFT')) throw new AdportError('INVALID_INPUT', 'x: parent campaign is deleted or draft');
    path = `${base}/${current.id}`;
    if (remove) {
      if (!['PROMOTED_TWEETS', 'PROMOTED_ACCOUNT', 'MEDIA'].includes(current.product_type)) throw new AdportError('INVALID_INPUT', 'x: unsupported product type; child ownership cannot be proven for deletion');
      const [posts, media, users] = await Promise.all([current.product_type !== 'MEDIA' ? this.entities.listPromotedTweets(account) : [], current.product_type === 'MEDIA' ? this.entities.listMediaCreatives(account) : [], current.product_type === 'PROMOTED_ACCOUNT' ? this.entities.listPromotedAccounts(account) : []]);
      if ([...posts, ...media, ...users].some(value => value.line_item_id === current!.id && !value.deleted)) throw new AdportError('INVALID_INPUT', 'x: remove line-item promotions/media before deleting their parent');
      method = 'DELETE'; expected = { id: current.id, campaign_id: current.campaign_id, deleted: true };
    } else {
      switch (op.tool) {
        case 'x_update_line_item': { const { line_item_id: _id, ...input } = updateLine.parse(op.payload); params = input; const start = String(input.start_time ?? current.start_time ?? ''), end = String(input.end_time ?? current.end_time ?? ''); if (end && (!start || Date.parse(end) <= Date.parse(start))) throw new AdportError('INVALID_INPUT', 'x: merged end time must follow start'); break; }
        case 'x_set_line_item_status': params = { entity_status: z.enum(['ACTIVE', 'PAUSED']).parse(op.payload.status) }; break;
        case 'x_set_line_item_budget': {
          const key = z.enum(['DAILY', 'TOTAL']).parse(op.payload.budget_type) === 'DAILY' ? 'daily_budget_amount_local_micro' : 'total_budget_amount_local_micro', previous = current[key], target = micros.parse(op.payload.budget_micros);
          if (!Number.isSafeInteger(previous) || previous === null || previous === undefined) throw new AdportError('INVALID_INPUT', 'x: an existing budget of the same type is required');
          if (parent.budget_optimization !== 'LINE_ITEM') throw new AdportError('INVALID_INPUT', 'x: line-item budgets require LINE_ITEM parent budget optimization');
          const daily = key === 'daily_budget_amount_local_micro' ? target : current.daily_budget_amount_local_micro, total = key === 'total_budget_amount_local_micro' ? target : current.total_budget_amount_local_micro;
          if (daily !== null && daily !== undefined && total !== null && total !== undefined && daily > total) throw new AdportError('INVALID_INPUT', 'x: daily budget cannot exceed total');
          params = { [key]: target }; budgetDeltas.push({ target: `line item ${current.id} ${key}`, fromMicros: previous, toMicros: target }); break;
        }
        case 'x_set_line_item_bidding': {
          const input = setLineBid.parse(op.payload), strategy = input.bid_strategy ?? current.bid_strategy;
          if (!strategy || !['AUTO', 'MAX', 'TARGET'].includes(strategy)) throw new AdportError('INVALID_INPUT', 'x: current bidding strategy is unavailable');
          if (strategy === 'AUTO' && current.bid_strategy !== 'AUTO') throw new AdportError('INVALID_INPUT', 'x: removing a monetary bid cap via AUTO cannot be represented by current policy');
          const previous = current.bid_strategy === 'AUTO' ? undefined : current.bid_amount_local_micro, amount = input.bid_micros ?? previous;
          if (current.bid_strategy !== 'AUTO' && (previous === undefined || previous === null)) throw new AdportError('INVALID_INPUT', 'x: current monetary bid is unavailable');
          this.bid(current.objective, strategy, amount, false); params = { ...(input.bid_strategy ? { bid_strategy: strategy } : {}), ...(input.bid_micros !== undefined ? { bid_amount_local_micro: input.bid_micros } : {}) };
          if (input.bid_micros !== undefined) budgetDeltas.push({ target: `line item ${current.id} bid`, ...(previous !== undefined && previous !== null ? { fromMicros: previous } : {}), toMicros: input.bid_micros }); break;
        }
        default: throw new AdportError('INVALID_INPUT', `x: unsupported management write ${op.tool}`);
      }
      const preserved = Object.fromEntries(['id', 'campaign_id', 'deleted', 'entity_status', 'name', 'objective', 'product_type', 'placements', 'bid_strategy', 'bid_amount_local_micro', 'daily_budget_amount_local_micro', 'total_budget_amount_local_micro', 'start_time', 'end_time', 'standard_delivery'].filter(key => current![key] !== undefined).map(key => [key, current![key]]));
      expected = { ...preserved, ...params };
    }
    const value = current;
    return { summary: `${remove ? 'Delete' : 'Update'} X line item ${value.name ?? value.id}`, changes: [`Native ${method} ${path}: ${JSON.stringify(params)}`], coercions, budgetDeltas, execute: () => this.receipt(method, path, params, value.currency, expected) };
  }
}
