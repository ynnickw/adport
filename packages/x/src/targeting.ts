import { AdportError, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import type { XParams } from './client.js';
import { XAdsEntities } from './entities.js';
import { addCriterion, criteriaInput, optionsInput, updateCriteria } from './targeting-tools.js';
import { xId as id } from './schemas.js';
import type { XWritePlan } from './writes.js';

type Row = Record<string, unknown>;
const rows = z.array(z.record(z.string(), z.unknown()));
const criterion = z.looseObject({ id, line_item_id: id, targeting_type: z.string(), targeting_value: z.string(), operator_type: z.string().optional(), deleted: z.boolean() });
const includedLocation = (value: { targeting_type: string; operator_type?: string }) => value.targeting_type === 'LOCATION' && value.operator_type !== 'NE';
const optionParams: Record<string, readonly string[]> = { app_store_categories: ['q', 'os_type'], conversations: ['conversation_type', 'count', 'cursor'], devices: ['count', 'q'], events: ['event_types', 'count', 'country_codes', 'cursor', 'end_time', 'start_time'], interests: ['count', 'cursor', 'q'], languages: ['count', 'cursor', 'q'], locations: ['count', 'country_code', 'cursor', 'location_type', 'q'], network_operators: ['count', 'country_code', 'cursor', 'q'], platform_versions: ['q'], platforms: ['count', 'q', 'lang'], tv_markets: [], tv_shows: ['locale', 'count', 'cursor', 'q'] };
type Collection = 'custom_audiences' | 'promotable_users' | 'app_lists';
export class XTargetingService {
  constructor(private readonly entities: XAdsEntities) {}
  async options(value: z.input<typeof optionsInput>) {
    const input = optionsInput.parse(value), allowed = optionParams[input.dimension]!;
    if (input.dimension === 'tv_shows' && (!input.locale || input.count > 50)) throw new AdportError('INVALID_INPUT', 'x: TV shows require locale and count <=50');
    const params: XParams = {};
    for (const [key, value] of Object.entries(input)) {
      if (['account_id', 'dimension'].includes(key) || value === undefined || (key === 'count' && !allowed.includes('count'))) continue;
      if (!allowed.includes(key)) throw new AdportError('INVALID_INPUT', `x: ${key} is not supported for targeting ${input.dimension}`);
      params[key] = Array.isArray(value) ? value.join(',') : value;
    }
    await this.entities.getAccount(input.account_id);
    const result = await this.entities.client.request('GET', `targeting_criteria/${input.dimension}`, z.object({ data: rows, next_cursor: z.string().nullable().optional() }), params), paged = allowed.includes('cursor'), next = paged ? result.next_cursor ?? undefined : undefined;
    if (next && next === input.cursor) throw new AdportError('PROVIDER_ERROR', 'x: targeting pagination repeated its cursor');
    if (paged && result.data.length > 1000) throw new AdportError('PROVIDER_ERROR', 'x: native targeting page exceeds its documented maximum');
    const limited = !paged && (result.data.length > input.count || Boolean(result.next_cursor) || (allowed.includes('count') && result.data.length >= input.count));
    return { items: paged ? result.data : result.data.slice(0, input.count), truncated: Boolean(next) || limited, ...(next ? { next_cursor: next } : {}), ...(limited ? { warning: 'Native endpoint has no documented usable continuation for this limit. Narrow the filter or increase count.' } : paged && result.data.length > input.count ? { warning: 'Native endpoint exceeded the requested count; the complete page is retained so continuation skips no choices.' } : {}) };
  }
  async criteria(value: z.input<typeof criteriaInput>) {
    const input = criteriaInput.parse(value), wanted = [...new Set(input.line_item_ids)]; let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => { while (index < wanted.length) await this.entities.getLineItem(input.account_id, wanted[index++]!); }));
    const page = await this.entities.client.request('GET', `accounts/${input.account_id}/targeting_criteria`, z.object({ data: z.array(criterion), next_cursor: z.string().nullable().optional() }), { line_item_ids: wanted.join(','), count: input.count, with_deleted: input.with_deleted, ...(input.cursor ? { cursor: input.cursor } : {}) });
    if (page.data.some(value => !wanted.includes(value.line_item_id) || (!input.with_deleted && value.deleted))) throw new AdportError('PROVIDER_ERROR', 'x: criteria list returned another line item or an excluded deleted row');
    if (new Set(page.data.map(value => value.id)).size !== page.data.length) throw new AdportError('PROVIDER_ERROR', 'x: criteria list repeated an entity');
    if (page.next_cursor && page.next_cursor === input.cursor) throw new AdportError('PROVIDER_ERROR', 'x: criteria pagination repeated its cursor');
    return { items: page.data, truncated: Boolean(page.next_cursor), ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) };
  }
  async owned(account: string, resource: string) {
    const { data } = await this.entities.client.request('GET', `accounts/${id.parse(account)}/targeting_criteria/${id.parse(resource)}`, z.object({ data: criterion }));
    if (data.id !== resource) throw new AdportError('PROVIDER_ERROR', 'x: criterion ID mismatch');
    await this.entities.getLineItem(account, data.line_item_id);
    return data;
  }
  private async current(account: string, line: string) {
    const items: Array<z.infer<typeof criterion>> = [], seen = new Set<string>(), ids = new Set<string>(); let cursor: string | undefined;
    while (true) {
      const page = await this.entities.client.request('GET', `accounts/${account}/targeting_criteria`, z.object({ data: z.array(criterion), next_cursor: z.string().nullable().optional() }), { line_item_ids: line, with_deleted: false, count: 1000, ...(cursor ? { cursor } : {}) });
      if (page.data.some(value => value.line_item_id !== line || value.deleted)) throw new AdportError('PROVIDER_ERROR', 'x: current criteria scope/deletion mismatch');
      if (page.data.length > 1000 || items.length + page.data.length > 5000) throw new AdportError('INVALID_INPUT', 'x: criteria context exceeds the safe mutation limit');
      for (const value of page.data) { if (ids.has(value.id)) throw new AdportError('PROVIDER_ERROR', 'x: criteria pagination repeated an entity'); ids.add(value.id); }
      items.push(...page.data);
      if (!page.next_cursor) return items;
      if (items.length >= 5000 || seen.has(page.next_cursor) || seen.size >= 25) throw new AdportError('INVALID_INPUT', 'x: criteria context exceeds the safe mutation limit or repeats pages');
      seen.add(page.next_cursor); cursor = page.next_cursor;
    }
  }
  private async available(account: string, collection: 'custom_audiences' | 'promotable_users' | 'app_lists', find: (row: Row) => boolean): Promise<Row> {
    const seen = new Set<string>(); let count = 0, cursor: string | undefined;
    while (true) {
      const page = await this.entities.client.request('GET', `accounts/${account}/${collection}`, z.object({ data: rows, next_cursor: z.string().nullable().optional() }), { count: 200, ...(cursor ? { cursor } : {}) });
      const found = page.data.find(find); if (found) return found;
      count += page.data.length;
      if (!page.next_cursor || count >= 5000 || seen.has(page.next_cursor) || seen.size >= 25) throw new AdportError('INVALID_INPUT', `x: reference is not in the account’s first 5,000 available ${collection}`);
      seen.add(page.next_cursor); cursor = page.next_cursor;
    }
  }
  private async source(account: string, input: z.infer<typeof addCriterion>, lookup: (collection: Collection, find: (row: Row) => boolean) => Promise<Row> = (collection, find) => this.available(account, collection, find)) {
    const type = input.targeting_type, value = input.targeting_value;
    if (type.startsWith('CUSTOM_AUDIENCE')) {
      const audience = await lookup('custom_audiences', row => row.id === value);
      if (audience.deleted !== false || audience.targetable !== true) throw new AdportError('INVALID_INPUT', 'x: audience is deleted or not targetable');
    } else if (type.startsWith('CAMPAIGN_ENGAGEMENT')) await this.entities.getCampaign(account, id.parse(value));
    else if (['USER_ENGAGEMENT', 'USER_ENGAGEMENT_LOOKALIKE', 'FOLLOWERS_OF_USER'].includes(type)) await lookup('promotable_users', row => row.user_id === value && row.promotable_user_type === 'FULL' && row.deleted === false);
    else if (type === 'APP_LIST') { if (input.operator_type !== 'NE') throw new AdportError('INVALID_INPUT', 'x: APP_LIST is exclusion-only (NE)'); const list = await lookup('app_lists', row => row.id === value); if (list.deleted === true) throw new AdportError('INVALID_INPUT', 'x: app list is deleted'); }
    else if (type === 'ENGAGEMENT_TYPE' && !['IMPRESSION', 'ENGAGEMENT'].includes(value)) throw new AdportError('INVALID_INPUT', 'x: ENGAGEMENT_TYPE must be IMPRESSION or ENGAGEMENT');
  }
  private finalState(values: Array<{ targeting_type: string; targeting_value: string; operator_type?: string }>) {
    const types = values.map(value => value.targeting_type), sources = ['CAMPAIGN_ENGAGEMENT', 'CAMPAIGN_ENGAGEMENT_LOOKALIKE', 'USER_ENGAGEMENT', 'USER_ENGAGEMENT_LOOKALIKE'];
    if (types.filter(type => type === 'AGE').length > 1) throw new AdportError('INVALID_INPUT', 'x: only one age bucket is allowed; use a batch replacement');
    if (types.includes('TV_SHOW') && !values.some(includedLocation)) throw new AdportError('INVALID_INPUT', 'x: TV shows require included location targeting; native provider also checks market compatibility');
    if (types.includes('ENGAGEMENT_TYPE') !== types.some(type => sources.includes(type))) throw new AdportError('INVALID_INPUT', 'x: engagement type and source must be configured together; use x_update_targeting for an atomic pair');
    const keys = values.map(value => JSON.stringify([value.targeting_type, value.operator_type ?? 'EQ', value.targeting_value]));
    if (new Set(keys).size !== keys.length) throw new AdportError('INVALID_INPUT', 'x: identical targeting criteria would be duplicated');
  }
  private async batch(op: WriteOperation): Promise<XWritePlan> {
    const account = id.parse(op.accountId), input = updateCriteria.parse(op.payload);
    if (op.provider !== 'x' || op.kind !== 'update') throw new AdportError('INVALID_INPUT', 'x: batch targeting operation kind/provider mismatch');
    const line = await this.entities.getLineItem(account, input.line_item_id);
    if (line.deleted || line.entity_status === 'DRAFT') throw new AdportError('INVALID_INPUT', 'x: deleted/draft line items cannot be changed');
    const current = await this.current(account, line.id), removed = input.remove.map(id => current.find(value => value.id === id));
    if (removed.some(value => !value)) throw new AdportError('INVALID_INPUT', 'x: every removed criterion must currently belong to the selected line item');
    const additions = input.add.map(value => ({ ...value, line_item_id: line.id })), final = [...current.filter(value => !input.remove.includes(value.id)), ...additions]; this.finalState(final);
    const books = new Map<Collection, Promise<Row[]>>(), lookup = async (collection: Collection, find: (row: Row) => boolean) => {
      let loaded = books.get(collection);
      if (!loaded) { loaded = (async () => { const all: Row[] = [], seen = new Set<string>(); let cursor: string | undefined; while (true) { const page = await this.entities.client.request('GET', `accounts/${account}/${collection}`, z.object({ data: rows, next_cursor: z.string().nullable().optional() }), { count: 200, ...(cursor ? { cursor } : {}) }); all.push(...page.data.slice(0, 5000 - all.length)); if (!page.next_cursor || all.length >= 5000) return all; if (seen.has(page.next_cursor) || seen.size >= 25) throw new AdportError('PROVIDER_ERROR', 'x: source availability pagination repeated'); seen.add(page.next_cursor); cursor = page.next_cursor; } })(); books.set(collection, loaded); }
      const found = (await loaded).find(find); if (!found) throw new AdportError('INVALID_INPUT', `x: reference is not in the account’s first 5,000 available ${collection}`); return found;
    };
    for (const value of additions) await this.source(account, value, lookup);
    const operations = [...input.remove.map(value => ({ operation_type: 'Delete', params: { targeting_criterion_id: value } })), ...additions.map(value => ({ operation_type: 'Create', params: value }))], expected = [...removed.map(value => ({ ...value!, deleted: true })), ...additions.map(value => ({ ...value, deleted: false }))];
    const lastLocation = current.some(includedLocation) && !final.some(includedLocation);
    return { summary: `Atomically update X targeting for ${line.id}`, changes: [`Remove existing criteria: ${JSON.stringify(removed.map(value => ({ id: value!.id, type: value!.targeting_type, value: value!.targeting_value, operator: value!.operator_type ?? 'unavailable' })))}`, `Native batch: ${input.remove.length} removals, ${additions.length} additions. Group status ${line.entity_status}. ${JSON.stringify(operations)}`, ...(lastLocation ? ['This removes the last LOCATION criterion and can broaden geographic delivery.'] : [])], coercions: [], budgetDeltas: [], execute: async () => {
      const response = await this.entities.client.request('POST', `batch/accounts/${account}/targeting_criteria`, z.object({ data: z.array(criterion) }), {}, operations), ids = response.data.map(value => value.id);
      if (response.data.length !== expected.length || new Set(ids).size !== ids.length || response.data.some((value, index) => { const wanted = expected[index]!; return value.line_item_id !== line.id || value.deleted !== wanted.deleted || value.targeting_type !== wanted.targeting_type || value.targeting_value !== wanted.targeting_value || ('id' in wanted && wanted.id !== value.id) || (!wanted.deleted && value.operator_type !== wanted.operator_type); })) throw new AdportError('PROVIDER_ERROR', 'x: ordered batch targeting receipts differ from the approved plan; reconcile before retrying', { resource_ids: ids });
      return ids;
    } };
  }
  async plan(op: WriteOperation, _guard: WriteGuard): Promise<XWritePlan> {
    if (op.tool === 'x_update_targeting') return this.batch(op);
    const account = id.parse(op.accountId), add = op.tool === 'x_add_targeting_criterion';
    if (op.provider !== 'x' || !['x_add_targeting_criterion', 'x_remove_targeting_criterion'].includes(op.tool) || op.kind !== (add ? 'create' : 'remove')) throw new AdportError('INVALID_INPUT', 'x: provider or targeting operation kind mismatch');
    const input = add ? addCriterion.parse(op.payload) : undefined, previous = add ? undefined : await this.owned(account, id.parse(op.payload.targeting_criterion_id)), line = await this.entities.getLineItem(account, input?.line_item_id ?? previous!.line_item_id);
    if (line.deleted || line.entity_status === 'DRAFT' || previous?.deleted) throw new AdportError('INVALID_INPUT', 'x: deleted/draft line items or deleted criteria cannot be changed');
    const current = await this.current(account, line.id);
    if (!add && !current.some(value => value.id === previous!.id)) throw new AdportError('INVALID_INPUT', 'x: criterion is no longer current on the selected line item');
    this.finalState(add ? [...current, input!] : current.filter(value => value.id !== previous!.id));
    if (input) {
      await this.source(account, input);
      if (current.some(value => value.targeting_type === input.targeting_type && value.targeting_value === input.targeting_value && (value.operator_type ?? 'EQ') === input.operator_type)) throw new AdportError('INVALID_INPUT', 'x: identical criterion already exists');
    }
    const item = input ?? previous!, lastLocation = !add && includedLocation(item) && current.filter(includedLocation).length === 1, changes = [`${add ? 'Add' : 'Remove'} ${JSON.stringify(item)}; line item ${line.id}, status ${line.entity_status}; ${current.length} current criteria. Active group audience can change immediately.`, ...(lastLocation ? ['This removes the last included LOCATION criterion and can broaden geographic delivery.'] : [])];
    return { summary: `${add ? 'Add' : 'Remove'} X targeting criterion`, changes, coercions: [], budgetDeltas: [], execute: async () => {
      const path = `accounts/${account}/targeting_criteria${add ? '' : `/${previous!.id}`}`, params: XParams = input ? { line_item_id: input.line_item_id, targeting_type: input.targeting_type, targeting_value: input.targeting_value, operator_type: input.operator_type } : {};
      const response = await this.entities.client.request(add ? 'POST' : 'DELETE', path, z.object({ data: criterion }), params), value = response.data;
      const expectedId = previous?.id ?? value.id;
      if (value.id !== expectedId || value.line_item_id !== line.id || value.targeting_type !== item.targeting_type || value.targeting_value !== item.targeting_value || value.deleted !== !add) throw new AdportError('PROVIDER_ERROR', 'x: criterion receipt differs from the approved plan; reconcile before retrying', { resource_ids: [value.id] });
      if (input) {
        let native = value;
        try { if (native.operator_type === undefined) native = (await this.entities.client.request('GET', `accounts/${account}/targeting_criteria/${value.id}`, z.object({ data: criterion }))).data; }
        catch { throw new AdportError('PROVIDER_ERROR', 'x: criterion operator readback failed; reconcile before retrying', { resource_ids: [value.id] }); }
        if (native.id !== value.id || native.line_item_id !== line.id || native.targeting_type !== input.targeting_type || native.targeting_value !== input.targeting_value || native.operator_type !== input.operator_type || native.deleted) throw new AdportError('PROVIDER_ERROR', 'x: criterion operator readback mismatch; reconcile before retrying', { resource_ids: [value.id] });
      }
      return [value.id];
    } };
  }
}
