import { AdportError, creativeStatusAction, type Creative, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { PinterestAdsClient } from './client.js';
import { createAd, createGroup, updateAd, updateGroup } from './creative-tools.js';
import { campaignSchema, pinterestId } from './schemas.js';

type Row = Record<string, unknown>;
interface Page { account_id: string; page_size: number; bookmark?: string }
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<string[]> }
const object = z.record(z.string(), z.unknown());
const response = z.looseObject({ id: pinterestId, ad_account_id: pinterestId.optional() });
function record(value: unknown): Row { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function query(input: Row) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, Array.isArray(value) ? value.map(String).join(',') : String(value)); return params; }
function safeUrl(value: unknown): string[] { if (typeof value !== 'string') return []; try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? [value] : []; } catch { return []; } }

/** Native batch and targeting contracts from Pinterest-owned v5 OpenAPI5.28.0. */
export class PinterestCreativeService {
  constructor(private readonly client: PinterestAdsClient, private readonly campaign: (account: string, id: string) => Promise<z.infer<typeof campaignSchema>>) {}
  private base(account: string) { return `ad_accounts/${pinterestId.parse(account)}`; }
  async read(account: string, path: string) { return this.client.get(`${this.base(account)}/${path}`, object); }
  async getEntity(account: string, entity: 'campaigns' | 'ad_groups' | 'ads', id: string) { return this.owned(account, entity, id); }
  async page(input: Page & Row, collection: 'ad_groups' | 'ads' | 'audiences') {
    const { account_id, ...params } = input;
    const data = await this.client.get(`${this.base(account_id)}/${collection}`, z.looseObject({ items: z.array(response), bookmark: z.string().nullable().optional() }), query({ ...params, ...(collection !== 'audiences' && !params.entity_statuses ? { entity_statuses: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DRAFT', 'DELETED_DRAFT'] } : {}) }));
    if (data.items.some(row => row.ad_account_id !== undefined && row.ad_account_id !== account_id)) throw new AdportError('PROVIDER_ERROR', 'pinterest: collection returned a foreign account');
    if (data.bookmark && data.bookmark === input.bookmark) throw new AdportError('PROVIDER_ERROR', 'pinterest: pagination repeated a bookmark');
    return { ...data, truncated: Boolean(data.bookmark), ...(data.bookmark ? { next_cursor: data.bookmark } : {}) };
  }
  async ads(input: Page & Row) {
    const { include_pin_details, ...filters } = input;
    const data = await this.page(filters, 'ads');
    const pins = new Map<string, Row>(), warnings: Array<{ provider: string; message: string }> = [];
    if (include_pin_details) {
      const ids = [...new Set(data.items.map(ad => typeof ad.pin_id === 'string' && /^\d{1,30}$/.test(ad.pin_id) ? ad.pin_id : '').filter(Boolean))];
      let cursor = 0, denied = false;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (cursor < ids.length && !denied) {
          const id = ids[cursor++]!;
          try {
            const pin = await this.client.get(`pins/${id}`, z.looseObject({ id: z.string().regex(/^\d+$/) }), query({ ad_account_id: input.account_id }));
            if (pin.id !== id) throw new AdportError('PROVIDER_ERROR', 'pinterest: referenced Pin response ID mismatch');
            pins.set(id, pin);
          } catch (error) {
            const forbidden = error instanceof AdportError && record(error.details).http_status === 403;
            if (forbidden) denied = true;
            const message = forbidden ? 'Pinterest denied a Pin preview. Check boards:read, pins:read and access to the referenced Pin.' : `Pin preview unavailable: ${error instanceof Error ? error.message : 'Pinterest read failed'}`;
            if (!warnings.some(warning => warning.message === message)) warnings.push({ provider: 'pinterest', message });
          }
        }
      }));
    }
    const creatives: Creative[] = data.items.map(ad => {
      const status = typeof ad.status === 'string' ? ad.status : '', args = { account_id: input.account_id, ad_id: ad.id };
      const pin = pins.get(String(ad.pin_id));
      return { id: ad.id, provider: 'pinterest', account_id: input.account_id, name: String(ad.name ?? ad.id), type: String(ad.creative_type ?? 'PIN_AD'), ...(status ? { status } : {}), ...(typeof ad.campaign_id === 'string' ? { campaign_id: ad.campaign_id } : {}), ...(typeof ad.ad_group_id === 'string' ? { ad_group_id: ad.ad_group_id } : {}), headlines: typeof pin?.title === 'string' ? [pin.title] : [], descriptions: typeof pin?.description === 'string' ? [pin.description] : [], landing_urls: safeUrl(ad.destination_url).length ? safeUrl(ad.destination_url) : safeUrl(pin?.link), media: pinMedia(pin?.media), actions: ['ARCHIVED', 'DELETED_DRAFT'].includes(status) ? [] : [
        ...(['ACTIVE', 'PAUSED'].includes(status) ? [creativeStatusAction('pinterest_set_ad_status', args, status, ['ACTIVE', 'PAUSED'])] : []),
        { label: 'Edit ad settings', tool: 'pinterest_update_ad', arguments: args, fields: [{ key: 'name', label: 'Ad name', type: 'text', value: String(ad.name ?? ''), max_length: 255 }, ...(typeof ad.destination_url === 'string' ? [{ key: 'destination_url', label: 'Destination URL', type: 'text' as const, value: ad.destination_url, max_length: 2048 }] : [])] },
      ] };
    });
    return { ...data, creatives, warnings };
  }
  async targetingOptions(account: string, type: string) { return this.client.get(`resources/targeting/${type}`, z.array(object), query({ ad_account_id: pinterestId.parse(account) })); }
  async estimate(input: { account_id: string } & Row) { const { account_id, ...body } = input; return this.client.mutate(`${this.base(account_id)}/ad_groups/audience_sizing`, 'POST', body, object); }

  private async owned(account: string, collection: 'campaigns' | 'ad_groups' | 'ads', id: string): Promise<Row> {
    if (collection === 'campaigns') return this.campaign(account, id);
    const row = await this.client.get(`${this.base(account)}/${collection}/${pinterestId.parse(id)}`, response);
    if (row.id !== id || (row.ad_account_id !== undefined && row.ad_account_id !== account)) throw new AdportError('PROVIDER_ERROR', 'pinterest: resource ID/account mismatch');
    if (collection === 'ad_groups') await this.campaign(account, pinterestId.parse(row.campaign_id));
    else {
      const parent = await this.owned(account, 'ad_groups', pinterestId.parse(row.ad_group_id));
      if (row.campaign_id !== undefined && row.campaign_id !== parent.campaign_id) throw new AdportError('PROVIDER_ERROR', 'pinterest: ad campaign hierarchy mismatch');
    }
    return row;
  }

  private async batch(account: string, collection: string, method: 'POST' | 'PATCH', body: Row) {
    const data = await this.client.mutate(`${this.base(account)}/${collection}`, method, [body], z.object({ items: z.array(z.object({ data: object.nullable().optional(), exceptions: z.array(z.unknown()).optional() })) }));
    const item = data.items[0], parsed = response.safeParse(item?.data);
    const ids = parsed.success ? [parsed.data.id] : [];
    if (data.items.length !== 1 || !parsed.success || item?.exceptions?.length) throw new AdportError('PROVIDER_ERROR', 'pinterest: native batch item failed or returned incomplete data; reconcile before retrying', { resource_ids: ids });
    if ((parsed.data.ad_account_id !== undefined && parsed.data.ad_account_id !== account) || (body.id && parsed.data.id !== body.id) || (body.status !== undefined && parsed.data.status !== body.status)) throw new AdportError('PROVIDER_ERROR', 'pinterest: mutation receipt ID/account/status mismatch; reconcile before retrying', { resource_ids: ids });
    if (['campaign_id', 'ad_group_id', 'budget_in_micro_currency', 'bid_in_micro_currency'].some(key => body[key] !== undefined && parsed.data[key] !== body[key])) throw new AdportError('PROVIDER_ERROR', 'pinterest: mutation receipt parent/money mismatch; read configuration before retrying', { resource_ids: ids });
    const goals = record(body.optimization_goal_metadata), returnedGoals = record(parsed.data.optimization_goal_metadata);
    for (const [key, field] of [['conversion_tag_v3_goal_metadata', 'cpa_goal_value_in_micro_currency'], ['scrollup_goal_metadata', 'scrollup_goal_value_in_micro_currency']]) {
      const expected = record(goals[key!])[field!], returned = record(returnedGoals[key!])[field!];
      if (expected !== undefined && (returned == null || !/^\d+$/.test(String(returned)) || Number(returned) !== Number(expected))) throw new AdportError('PROVIDER_ERROR', 'pinterest: monetary optimization receipt mismatch; read configuration before retrying', { resource_ids: ids });
    }
    return ids;
  }

  private async verifyOptimization(account: string, input: unknown) {
    const tag = record(record(input).conversion_tag_v3_goal_metadata).conversion_tag_id;
    if (tag === undefined) return;
    const result = await this.client.get(`${this.base(account)}/conversion_tags/${pinterestId.parse(tag)}`, z.looseObject({ id: pinterestId, ad_account_id: pinterestId }));
    if (result.id !== tag || result.ad_account_id !== account) throw new AdportError('INVALID_INPUT', 'pinterest: conversion tag is not owned by the selected advertiser');
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const p = op.payload, account = op.accountId, coercions: string[] = [], budgetDeltas: WritePreview['budgetDeltas'] = [];
    let collection: 'campaigns' | 'ad_groups' | 'ads', body: Row, method: 'POST' | 'PATCH' = 'PATCH';
    const paused = (status: string) => { if (guard.forcePausedCreation && status !== 'PAUSED') { coercions.push('status coerced to PAUSED by policy (paused_creation)'); return 'PAUSED'; } return status; };
    switch (op.tool) {
      case 'pinterest_create_ad_group': {
        const input = createGroup.parse(p), parent = await this.campaign(account, input.campaign_id);
        if (typeof parent.is_campaign_budget_optimization !== 'boolean') throw new AdportError('INVALID_INPUT', 'pinterest: campaign CBO mode is unavailable; cannot determine budget ownership');
        if (parent.is_campaign_budget_optimization && input.budget_in_micro_currency !== undefined) throw new AdportError('INVALID_INPUT', 'pinterest: CBO campaigns own the budget; omit an ad-group budget');
        if (!parent.is_campaign_budget_optimization && input.budget_in_micro_currency === undefined) throw new AdportError('INVALID_INPUT', 'pinterest: non-CBO campaigns require an ad-group budget');
        if (parent.is_campaign_budget_optimization && input.pacing_delivery_type !== 'STANDARD') throw new AdportError('INVALID_INPUT', 'pinterest: CBO permits only STANDARD pacing');
        if (input.budget_type === 'LIFETIME' && !input.end_time) throw new AdportError('INVALID_INPUT', 'pinterest: lifetime budgets require end_time');
        if (input.lifetime_frequency_cap && !input.end_time) throw new AdportError('INVALID_INPUT', 'pinterest: a frequency cap requires end_time');
        checkTargeting(input.targeting_spec);
        await this.verifyOptimization(account, input.optimization_goal_metadata);
        body = { ...input, status: paused(input.status), ...(input.budget_in_micro_currency !== undefined ? { budget_type: input.budget_type ?? 'DAILY' } : {}) };
        collection = 'ad_groups'; method = 'POST'; moneyDeltas(body, {}, `new ad group ${input.name}`, budgetDeltas); break;
      }
      case 'pinterest_create_ad': {
        const input = createAd.parse(p); await this.owned(account, 'ad_groups', input.ad_group_id);
        collection = 'ads'; method = 'POST'; body = { ...input, status: paused(input.status) }; break;
      }
      case 'pinterest_update_ad_group': {
        const input = updateGroup.parse(p), { ad_group_id, ...fields } = input, current = await this.owned(account, 'ad_groups', ad_group_id);
        body = { id: ad_group_id, ...fields };
        if (fields.targeting_spec) { body.targeting_spec = { ...record(current.targeting_spec), ...fields.targeting_spec }; checkTargeting(body.targeting_spec); }
        if (fields.optimization_goal_metadata) {
          await this.verifyOptimization(account, fields.optimization_goal_metadata);
          const previous = record(current.optimization_goal_metadata), merged: Row = { ...previous, ...fields.optimization_goal_metadata };
          for (const [key, value] of Object.entries(fields.optimization_goal_metadata)) merged[key] = { ...record(previous[key]), ...record(value) };
          body.optimization_goal_metadata = merged;
        }
        const effective = { ...current, ...body };
        if (effective.start_time && effective.end_time && Number(effective.end_time) <= Number(effective.start_time)) throw new AdportError('INVALID_INPUT', 'pinterest: end_time must follow start_time');
        moneyDeltas(body, current, `ad group ${ad_group_id}`, budgetDeltas); collection = 'ad_groups'; break;
      }
      case 'pinterest_update_ad': {
        const input = updateAd.parse(p), { ad_id, ...fields } = input, current = await this.owned(account, 'ads', ad_id);
        if (input.pin_id !== undefined && current.status !== 'DRAFT') throw new AdportError('INVALID_INPUT', 'pinterest: pin_id can only be replaced on DRAFT ads. Create a new paused ad for a different Pin.');
        collection = 'ads'; body = { id: ad_id, ...fields }; break;
      }
      case 'pinterest_set_ad_status':
      case 'pinterest_set_ad_group_status': {
        collection = op.tool === 'pinterest_set_ad_status' ? 'ads' : 'ad_groups';
        const id = pinterestId.parse(p[collection === 'ads' ? 'ad_id' : 'ad_group_id']); await this.owned(account, collection, id);
        body = { id, status: z.enum(['ACTIVE', 'PAUSED']).parse(p.status) }; break;
      }
      case 'pinterest_set_ad_group_budget': {
        const id = pinterestId.parse(p.ad_group_id), current = await this.owned(account, 'ad_groups', id), parent = await this.campaign(account, String(current.campaign_id));
        if (parent.is_campaign_budget_optimization) throw new AdportError('INVALID_INPUT', 'pinterest: this ad group uses the campaign’s CBO budget');
        if (!['DAILY', 'LIFETIME'].includes(String(current.budget_type)) || typeof current.budget_in_micro_currency !== 'number') throw new AdportError('INVALID_INPUT', 'pinterest: current ad-group budget/type is unavailable');
        collection = 'ad_groups'; body = { id, budget_in_micro_currency: z.number().int().positive().safe().parse(p.budget_micros) }; moneyDeltas(body, current, `ad group ${id}`, budgetDeltas); break;
      }
      case 'pinterest_set_ad_group_bidding': {
        const id = pinterestId.parse(p.ad_group_id), current = await this.owned(account, 'ad_groups', id);
        body = { id, ...(p.bid_strategy_type !== undefined ? { bid_strategy_type: p.bid_strategy_type } : {}), ...(p.bid_micros !== undefined ? { bid_in_micro_currency: p.bid_micros } : {}) };
        if ((body.bid_strategy_type ?? current.bid_strategy_type) === 'MAX_BID' && !(body.bid_in_micro_currency ?? current.bid_in_micro_currency)) throw new AdportError('INVALID_INPUT', 'pinterest: MAX_BID requires a monetary bid');
        moneyDeltas(body, current, `ad group ${id}`, budgetDeltas); collection = 'ad_groups'; break;
      }
      case 'pinterest_archive_entity': {
        collection = z.enum(['campaigns', 'ad_groups', 'ads']).parse(p.entity); const id = pinterestId.parse(p.resource_id); await this.owned(account, collection, id); body = { id, status: 'ARCHIVED' }; break;
      }
      default: throw new AdportError('INVALID_INPUT', `pinterest: unsupported write ${op.tool}`);
    }
    return { summary: `Pinterest ${op.tool.replace(/^pinterest_/, '').replaceAll('_', ' ')}`, changes: [`${method} ${collection}: ${JSON.stringify(body)}`], coercions, budgetDeltas, execute: () => this.batch(account, collection, method, body) };
  }
}

function checkTargeting(input: unknown) {
  if (!input) return;
  const target = record(input);
  if (!(Array.isArray(target.GEO) && target.GEO.length) && !(Array.isArray(target.LOCATION) && target.LOCATION.length)) throw new AdportError('INVALID_INPUT', 'pinterest: targeting requires GEO or LOCATION');
  if (Array.isArray(target.AGE_BUCKET) && target.AGE_BUCKET.length && (target.MINIMUM_AGE || target.MAXIMUM_AGE)) throw new AdportError('INVALID_INPUT', 'pinterest: choose AGE_BUCKET or minimum/maximum age');
  if (Boolean(target.MINIMUM_AGE) !== Boolean(target.MAXIMUM_AGE) || (target.MINIMUM_AGE && Number.parseInt(String(target.MINIMUM_AGE)) > Number.parseInt(String(target.MAXIMUM_AGE)))) throw new AdportError('INVALID_INPUT', 'pinterest: minimum and maximum age must be supplied together and ordered');
}
function pinMedia(input: unknown, depth = 0): Creative['media'] {
  if (depth > 2) return [];
  const media = record(input), result: Creative['media'] = [];
  const variants = (value: unknown) => Object.values(record(value)).map(record).sort((a, b) => Number(b.width ?? 0) * Number(b.height ?? 0) - Number(a.width ?? 0) * Number(a.height ?? 0));
  const video = variants(media.video_list).find(item => safeUrl(item.url).some(url => url.startsWith('https:')));
  if (video) result.push({ type: 'video', url: String(video.url) });
  else {
    const image = variants(media.images).find(item => safeUrl(item.url).some(url => url.startsWith('https:')));
    if (image) result.push({ type: 'image', url: String(image.url) });
  }
  for (const item of (Array.isArray(media.items) ? media.items : []).slice(0, 10)) result.push(...pinMedia(item, depth + 1));
  return result.slice(0, 10);
}
function moneyDeltas(next: Row, current: Row, target: string, deltas: WritePreview['budgetDeltas']) {
  const amount = (label: string, value: unknown, old: unknown) => {
    const parse = (input: unknown) => { const n = typeof input === 'number' ? input : typeof input === 'string' && /^\d+$/.test(input) ? Number(input) : NaN; if (!Number.isSafeInteger(n) || n < 0) throw new AdportError('PROVIDER_ERROR', `pinterest: invalid ${label} money value`); return n; };
    const to = parse(value);
    if (old !== undefined && old !== null) deltas.push({ target: `${target} ${label}`, fromMicros: parse(old), toMicros: to });
    else deltas.push({ target: `${target} ${label}`, toMicros: to });
  };
  for (const key of ['budget_in_micro_currency', 'bid_in_micro_currency']) if (next[key] !== undefined) amount(key, next[key], current[key]);
  const goals = record(next.optimization_goal_metadata), previous = record(current.optimization_goal_metadata);
  for (const [key, field] of [['conversion_tag_v3_goal_metadata', 'cpa_goal_value_in_micro_currency'], ['scrollup_goal_metadata', 'scrollup_goal_value_in_micro_currency']]) if (record(goals[key!])[field!] !== undefined) amount(field!, record(goals[key!])[field!], record(previous[key!])[field!]);
}
