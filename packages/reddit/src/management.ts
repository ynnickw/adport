import { createHash } from 'node:crypto';
import { AdportError, type WriteGuard, type WriteOperation, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { RedditAdsClient } from './client.js';
import type { RedditCreativePlan, RedditCreativeService } from './creatives.js';
import { audienceUsers, createSaved, customAudience, savedTargeting, sendEvents, updateSaved } from './management-tools.js';
import { redditId as id } from './schemas.js';

type Row = Record<string, unknown>;
type Collection = 'custom_audiences' | 'saved_audiences' | 'pixels';
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class RedditManagementService {
  constructor(private readonly client: RedditAdsClient, private readonly creatives: RedditCreativeService) {}
  async list(input: { account_id: string; page_size: number; cursor?: string; name?: string }, collection: Collection) {
    const path = `ad_accounts/${id.parse(input.account_id)}/${collection}`, url = input.cursor ? this.client.nextUrl(input.cursor, path) : path;
    const response = await this.client.get<unknown>(url, input.cursor ? {} : { 'page.size': input.page_size, ...(input.name !== undefined ? { name: input.name } : {}) });
    if (!Array.isArray(response.data) || response.data.some(value => !id.safeParse(row(value).id).success)) throw new AdportError('PROVIDER_ERROR', 'reddit: malformed audience/Pixel collection');
    const next = response.pagination?.next_url ? this.client.nextUrl(response.pagination.next_url, path) : undefined;
    if (next === this.client.nextUrl(url, path)) throw new AdportError('PROVIDER_ERROR', 'reddit: pagination repeated the current page');
    return { items: response.data as Row[], truncated: Boolean(next), ...(next ? { next_cursor: next } : {}) };
  }
  private async available(account: string, collection: Collection, resource: string) {
    id.parse(account); id.parse(resource);
    const rows = await this.client.getPaged<unknown>(`ad_accounts/${account}/${collection}`, { 'page.size': 1000 }, 5000);
    const found = rows.map(row).find(value => value.id === resource);
    if (!found) throw new AdportError('INVALID_INPUT', 'reddit: resource is not in the account’s first 5,000 available audience/Pixel entries');
    return found;
  }
  async audience(account: string, resource: string, requireOwned = false) {
    await this.available(account, 'custom_audiences', resource);
    const value = row((await this.client.get<unknown>(`custom_audiences/${resource}`)).data);
    if (value.id !== resource || (requireOwned && value.ad_account_id !== account)) throw new AdportError('INVALID_INPUT', 'reddit: audience ownership mismatch; shared audiences cannot be mutated');
    return value;
  }
  async saved(account: string, resource: string) {
    id.parse(account); id.parse(resource);
    const value = row((await this.client.get<unknown>(`saved_audiences/${resource}`)).data);
    if (value.id !== resource || value.ad_account_id !== account) throw new AdportError('INVALID_INPUT', 'reddit: saved-audience ownership mismatch');
    return value;
  }
  async lastFired(account: string, pixel: string) {
    await this.available(account, 'pixels', pixel);
    const value = (await this.client.get<unknown>(`pixels/${pixel}/last_fired_at`)).data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdportError('PROVIDER_ERROR', 'reddit: malformed Pixel activity response');
    return { pixel_id: pixel, last_fired_at: value };
  }
  async validateAudienceSource(account: string, payload: unknown) {
    const data = customAudience.parse(payload);
    if (data.type === 'PIXEL_RETARGETING') for (const pixel of data.pixel_audience_config.pixel_ids) await this.available(account, 'pixels', pixel);
    if (data.type === 'ENGAGEMENT_RETARGETING') for (const campaign of data.engagement_audience_config.campaign_ids) await this.creatives.owned(account, 'campaigns', campaign);
    return data;
  }
  private async receipt(path: string, method: 'POST' | 'PATCH', fields: Row, account: string, resource?: string): Promise<WriteResult> {
    const result = method === 'POST' ? await this.client.post<unknown>(path, { data: fields }) : await this.client.patch<unknown>(path, { data: fields }), value = row(result.data);
    const ids = id.safeParse(value.id).success ? [String(value.id)] : [];
    if (ids.length !== 1 || (resource && value.id !== resource) || value.ad_account_id !== account || Object.entries(fields).some(([key, expected]) => !matches(value[key], expected))) throw new AdportError('PROVIDER_ERROR', 'reddit: audience receipt ID/account/settings mismatch; reconcile before retrying', { resource_ids: ids });
    return { applied: true, resourceIds: ids };
  }
  private empty(value: unknown, resource: string): WriteResult {
    if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)) throw new AdportError('PROVIDER_ERROR', 'reddit: unexpected empty mutation receipt; reconcile before retrying', { resource_ids: [resource] });
    return { applied: true, resourceIds: [resource] };
  }
  async plan(op: WriteOperation, _guard: WriteGuard): Promise<RedditCreativePlan> {
    const account = id.parse(op.accountId), p = op.payload, type = op.tool;
    const create = ['reddit_create_customer_audience', 'reddit_create_pixel_audience', 'reddit_create_engagement_audience', 'reddit_create_saved_audience', 'reddit_send_conversion_events'].includes(type);
    const remove = ['reddit_delete_audience', 'reddit_delete_saved_audience'].includes(type);
    if (op.provider !== 'reddit' || op.kind !== (create ? 'create' : remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'reddit: provider or operation kind mismatch');
    const plan = (summary: string, changes: string[], execute: () => Promise<WriteResult>): RedditCreativePlan => ({ summary, changes, coercions: [], budgetDeltas: [], execute });
    switch (type) {
      case 'reddit_create_customer_audience':
      case 'reddit_create_pixel_audience':
      case 'reddit_create_engagement_audience': {
        const nativeType = type === 'reddit_create_customer_audience' ? 'CUSTOMER_LIST' : type === 'reddit_create_pixel_audience' ? 'PIXEL_RETARGETING' : 'ENGAGEMENT_RETARGETING';
        const data = await this.validateAudienceSource(account, { ...p, type: nativeType });
        return plan(`Create Reddit ${nativeType} audience`, [JSON.stringify(data), 'Does not create an ad or change existing targeting.'], () => this.receipt(`ad_accounts/${account}/custom_audiences`, 'POST', data, account));
      }
      case 'reddit_update_audience_users': {
        const { audience_id, ...data } = audienceUsers.parse(p), audience = await this.audience(account, audience_id, true);
        if (audience.type !== 'CUSTOMER_LIST' || audience.customer_list_config) throw new AdportError('INVALID_INPUT', 'reddit: direct membership changes require an owned customer list without an external data-provider configuration');
        const sha256 = digest(data);
        return plan(`${data.action_type} ${data.user_data.length} Reddit audience rows`, [`Audience ${audience_id}; columns ${data.column_order.join(',')}; payload SHA-256 ${sha256}. Changes affect targeting using this audience; identifiers are omitted from preview.`], async () => { const result = this.empty((await this.client.patch(`custom_audiences/${audience_id}/users`, { data })).data, audience_id); return { ...result, details: { submitted_rows: data.user_data.length, action_type: data.action_type, payload_sha256: sha256 } }; });
      }
      case 'reddit_delete_audience': {
        const audience = await this.audience(account, id.parse(p.audience_id), true);
        return plan(`Permanently delete Reddit audience ${audience.id}`, [`${audience.name}; type ${audience.type}; targeting using this shared resource can lose eligibility.`], async () => this.empty((await this.client.delete(`custom_audiences/${audience.id}`)).data, String(audience.id)));
      }
      case 'reddit_create_saved_audience': {
        const input = createSaved.parse(p), data = { ...input, type: 'REDDIT_AUDIENCE', targeting: { expand_targeting: false, ...input.targeting } };
        await this.creatives.assertTargetingAvailable(account, data.targeting);
        return plan('Create Reddit saved targeting audience', [JSON.stringify(data)], () => this.receipt(`ad_accounts/${account}/saved_audiences`, 'POST', data, account));
      }
      case 'reddit_update_saved_audience':
      case 'reddit_delete_saved_audience': {
        const input = remove ? { saved_audience_id: id.parse(p.saved_audience_id) } : updateSaved.parse(p), current = await this.saved(account, input.saved_audience_id);
        if (current.status === 'DELETED') throw new AdportError('INVALID_INPUT', 'reddit: saved audience is already deleted');
        const data: Row = remove ? { status: 'DELETED' } : { ...('name' in input && input.name !== undefined ? { name: input.name } : {}) };
        if ('targeting' in input && input.targeting !== undefined) {
          const previous = savedTargeting.safeParse(current.targeting);
          if (!previous.success) throw new AdportError('INVALID_INPUT', 'reddit: current saved targeting contains unsupported fields; refusing a partial reset');
          data.targeting = { ...previous.data, ...input.targeting }; await this.creatives.assertTargetingAvailable(account, data.targeting);
        }
        return plan(`${remove ? 'Delete' : 'Update'} Reddit saved audience ${current.id}`, [`Active ad groups: ${current.active_ad_groups_count ?? 'unavailable'}; changes affect all users of this audience. ${JSON.stringify(data)}`], () => this.receipt(`saved_audiences/${current.id}`, 'PATCH', data, account, String(current.id)));
      }
      case 'reddit_send_conversion_events': {
        const input = sendEvents.parse(p); await this.available(account, 'pixels', input.pixel_id);
        const data = { ...(input.test_id ? { test_id: input.test_id } : {}), events: input.events }, sha256 = digest(data), counts: Record<string, number> = {};
        for (const event of input.events) counts[event.type.tracking_type] = (counts[event.type.tracking_type] ?? 0) + 1;
        return plan(`Submit ${input.events.length} ${input.mode} Reddit conversion events`, [`Pixel ${input.pixel_id}; event types ${JSON.stringify(counts)}; payload SHA-256 ${sha256}. ${input.mode === 'LIVE' ? 'Real measurement submission can affect attribution and optimization.' : 'Uses the supplied Events Manager test ID.'} Event identifiers, match keys and source URLs are omitted from preview.`], async () => {
          const result = row((await this.client.post(`pixels/${input.pixel_id}/conversion_events`, { data })).data);
          if (typeof result.message !== 'string' || !result.message.trim()) throw new AdportError('PROVIDER_ERROR', 'reddit: conversion receipt has no processing message; reconcile deduplicated IDs before retrying', { resource_ids: [input.pixel_id] });
          return { applied: true, resourceIds: [input.pixel_id], details: { mode: input.mode, submitted_events: input.events.length, payload_sha256: sha256, message: this.client.diagnostic(result.message), note: 'Native acceptance does not prove attribution or final processing.' } };
        });
      }
      default: throw new AdportError('INVALID_INPUT', `reddit: unsupported management write ${type}`);
    }
  }
}

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every(value => actual.some(candidate => matches(candidate, value)));
  if (expected && typeof expected === 'object') return actual !== null && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => matches((actual as Row)[key], value));
  return actual === expected;
}
