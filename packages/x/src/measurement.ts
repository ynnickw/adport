import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { XAdsEntities } from './entities.js';
import { XAdsAnalytics, xAccountMidnight } from './analytics.js';
import { appTag, appTags, conversionStats, createTrackingTag, deleteTrackingTag, trackingTag, trackingTags, updateTrackingTag, webTag, webTags } from './measurement-tools.js';
import { campaignSchema, lineItemSchema, promotedTweetSchema, xId as id } from './schemas.js';
import type { XParams } from './client.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const web = z.looseObject({ id, name: z.string(), type: z.string(), deleted: z.boolean() });
type Web = z.infer<typeof web>;
const app = z.looseObject({ id, app_store_identifier: z.string(), os_type: z.string(), conversion_type: z.string(), post_view_attribution_window: z.number().int().nonnegative(), post_engagement_attribution_window: z.number().int().nonnegative(), deleted: z.boolean() });
const tracking = z.looseObject({ id, line_item_id: id, tracking_tag_type: z.string(), tracking_tag_url: z.string(), deleted: z.boolean() });
type Tracking = z.infer<typeof tracking>;
const request = z.object({ params: z.record(z.string(), z.unknown()).optional() }).optional();
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const configuration = (value: Tracking) => Object.fromEntries(Object.entries(value).filter(([key]) => !['created_at', 'updated_at', 'configuration_hash'].includes(key)));
const snapshot = (account: string, value: Tracking) => createHash('sha256').update(canonical({ account_id: account, configuration: configuration(value) })).digest('hex');
const webSnapshot = (account: string, value: Web) => createHash('sha256').update(canonical({ account_id: account, configuration: Object.fromEntries(['id', 'name', 'type', 'retargeting_enabled', 'click_window', 'view_through_window', 'deleted'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) })).digest('hex');
const day = 86_400_000;
const notes = ['Local preview only; X has no server dry run or conditional update for this workflow.', 'Measurement on active ads may change immediately. No events are sent by this tool, no ads are activated and no budget or bid is changed.', 'No automatic write retry. Reconcile known IDs after an uncertain result.'];
const rejection = (error: unknown) => error instanceof AdportError && error.details !== null && typeof error.details === 'object' && 'http_status' in error.details && [401, 403, 429].includes(Number(error.details.http_status));

/** Provider-owned v12 tracking/app references and MCP route map, commit 4e8f626. */
export class XMeasurementService {
  constructor(private readonly entities: XAdsEntities, private readonly analytics: XAdsAnalytics) {}
  private base(account: string, kind: string) { return `accounts/${id.parse(account)}/${kind}`; }
  private scope(value: { request?: { params?: Row } }, account: string, kind: string, resource?: string) {
    const params = value.request?.params;
    if (params && (params.account_id !== undefined && params.account_id !== account || resource && params[`${kind.slice(0, -1)}_id`] !== undefined && params[`${kind.slice(0, -1)}_id`] !== resource)) throw new AdportError('PROVIDER_ERROR', 'x: measurement response scope differs from the selected account/ID');
  }
  private rowScope(value: Row, account: string) {
    if (value.account_id !== undefined && value.account_id !== account) throw new AdportError('PROVIDER_ERROR', 'x: measurement resource belongs to a different account');
  }
  private async page<S extends z.ZodType<{ id: string; deleted: boolean } & Row>>(account: string, kind: string, schema: S, params: XParams, filters?: string[], lineIds?: string[]) {
    await this.entities.getAccount(account);
    const result = await this.entities.client.request('GET', this.base(account, kind), z.looseObject({ data: z.array(schema).max(5000), next_cursor: z.string().min(1).max(4096).nullable().optional(), total_count: z.number().int().nonnegative().safe().optional(), request }), params);
    this.scope(result, account, kind);
    if (result.next_cursor && result.next_cursor === params.cursor || new Set(result.data.map(value => value.id)).size !== result.data.length) throw new AdportError('PROVIDER_ERROR', 'x: measurement page repeats a cursor or resource ID');
    for (const value of result.data) {
      this.rowScope(value, account);
      if (filters && !filters.includes(value.id) || !params.with_deleted && value.deleted || lineIds && !lineIds.includes(String(value.line_item_id))) throw new AdportError('PROVIDER_ERROR', 'x: measurement page differs from requested filters');
    }
    return { ...result, complete: result.next_cursor === null ? true : result.next_cursor === undefined ? null : false, ...(result.data.length > Number(params.count) ? { warnings: ['X returned more records than requested; the complete native page is retained.'] } : {}) };
  }
  private async get<S extends z.ZodType<{ id: string; deleted: boolean } & Row>>(account: string, kind: string, resource: string, schema: S, withDeleted: boolean) {
    await this.entities.getAccount(account);
    const result = await this.entities.client.request('GET', `${this.base(account, kind)}/${id.parse(resource)}`, z.looseObject({ data: z.unknown(), request }), { with_deleted: withDeleted });
    const parsed = schema.safeParse(result.data);
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'x: unexpected measurement resource schema');
    this.scope(result, account, kind, resource);this.rowScope(parsed.data, account);
    if (parsed.data.id !== resource || !withDeleted && parsed.data.deleted) throw new AdportError('PROVIDER_ERROR', 'x: measurement resource ID/deletion state differs from the request');
    return { ...result, data: parsed.data };
  }
  async listWeb(value: unknown) {
    const { account_id, ...params } = webTags.parse(value), result = await this.page(account_id, 'web_event_tags', web, params);
    const data = result.data.map((value): Web & { configuration_hash: string } => ({ ...value, configuration_hash: webSnapshot(account_id, value) }));
    return { ...result, data, records: data.map(value => ({ id: value.id, name: value.name, type: value.type, status: value.deleted ? 'Deleted' : value.status ?? 'Not reported', ...(value.click_window !== undefined ? { click_window_days: value.click_window } : {}), ...(value.view_through_window !== undefined ? { view_through_window_days: value.view_through_window } : {}) })) };
  }
  async getWeb(value: unknown) {
    const input = webTag.parse(value), result = await this.get(input.account_id, 'web_event_tags', input.web_event_tag_id, web, input.with_deleted);
    const data: Web & { configuration_hash: string } = { ...result.data, configuration_hash: webSnapshot(input.account_id, result.data) };
    return { ...result, data, records: [data], notes: ['Embed code is returned as inert data. This read does not install a pixel or send an event.'] };
  }
  async listApp(value: unknown) {
    const { account_id, app_event_tag_ids, ...input } = appTags.parse(value), params = this.pageParams(input, { app_event_tag_ids });
    const result = await this.page(account_id, 'app_event_tags', app, params, app_event_tag_ids);
    return { ...result, records: result.data.map(value => ({ id: value.id, name: `${value.conversion_type} · ${value.app_store_identifier}`, status: value.deleted ? 'Deleted' : value.status ?? 'Not reported', os_type: value.os_type, post_view_window_days: value.post_view_attribution_window, post_engagement_window_days: value.post_engagement_attribution_window })) };
  }
  async getApp(value: unknown) {
    const input = appTag.parse(value), result = await this.get(input.account_id, 'app_event_tags', input.app_event_tag_id, app, input.with_deleted);
    return { ...result, records: [result.data] };
  }
  private pageParams(value: { cursor?: string; count: number; with_deleted: boolean; with_total_count: boolean }, filters: Record<string, string[] | undefined>): XParams {
    const { with_total_count, ...params } = value;
    return { ...params, ...(!params.cursor && with_total_count ? { with_total_count: true } : {}), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined).map(([key, value]) => [key, value!.join(',')])) };
  }
  async listTracking(value: unknown) {
    const { account_id, tracking_tag_ids, line_item_ids, ...input } = trackingTags.parse(value), params = this.pageParams(input, { tracking_tag_ids, line_item_ids });
    const result = await this.page(account_id, 'tracking_tags', tracking, params, tracking_tag_ids, line_item_ids);
    if (result.data.length) {
      const lineIds = [...new Set(result.data.map(value => value.line_item_id))];
      const lines = new Map((await this.selectedParents(account_id, 'line_items', 'line_item_ids', lineItemSchema, lineIds)).map(value => [value.id, value]));
      const campaignIds = [...new Set([...lines.values()].map(value => value.campaign_id))];
      const campaigns = new Map((await this.selectedParents(account_id, 'campaigns', 'campaign_ids', campaignSchema, campaignIds)).map(value => [value.id, value]));
      for (const tag of result.data) {
        const line = lines.get(tag.line_item_id), campaign = line && campaigns.get(line.campaign_id);
        if (!line || !campaign || campaign.currency !== line.currency) throw new AdportError('PROVIDER_ERROR', 'x: tracking-tag parent hierarchy is not verified in the selected account');
      }
    }
    const data = result.data.map(value => ({ ...value, configuration_hash: snapshot(account_id, value) }));
    return { ...result, data, records: data.map(value => this.trackingRecord(value)) };
  }
  private async selectedParents<S extends z.ZodType<{ id: string }>>(account: string, kind: string, filter: string, schema: S, ids: string[]) {
    const rows: z.output<S>[] = [];
    for (let offset = 0; offset < ids.length; offset += 200) {
      const selected = ids.slice(offset, offset + 200), result = await this.entities.client.request('GET', this.base(account, kind), z.looseObject({ data: z.array(schema).max(1000), request }), { [filter]: selected.join(','), count: 1000, with_deleted: true, with_draft: true });
      this.scope(result, account, kind);
      if (new Set(result.data.map(value => value.id)).size !== result.data.length || result.data.some(value => !selected.includes(value.id)) || selected.some(value => !result.data.some(row => row.id === value))) throw new AdportError('PROVIDER_ERROR', 'x: tracking-tag parent hierarchy is incomplete or differs from requested IDs');
      rows.push(...result.data);
    }
    return rows;
  }
  async getTracking(value: unknown) {
    const input = trackingTag.parse(value), result = await this.get(input.account_id, 'tracking_tags', input.tracking_tag_id, tracking, input.with_deleted);
    await this.entities.getLineItem(input.account_id, result.data.line_item_id);
    const tag = { ...result.data, configuration_hash: snapshot(input.account_id, result.data) };
    return { ...result, data: tag, records: [this.trackingRecord(tag)] };
  }
  private trackingRecord(value: Tracking) {
    return { id: value.id, name: value.tracking_tag_type === 'IMPRESSION_TAG' ? 'Impression tracker' : value.tracking_tag_type === 'CLICK_TRACKER' ? 'Click tracker' : value.tracking_tag_type, status: value.deleted ? 'Deleted' : 'Associated', line_item_id: value.line_item_id, tracking_url: value.tracking_tag_url };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const create = op.tool === 'x_create_tracking_tag', remove = op.tool === 'x_delete_tracking_tag';
    if (op.provider !== 'x' || op.kind !== (create ? 'create' : remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'x: tracking-tag provider/operation kind mismatch');
    const account = id.parse(op.accountId);
    await this.entities.getAccount(account);
    const input = create ? createTrackingTag.parse(op.payload) : remove ? deleteTrackingTag.parse(op.payload) : op.tool === 'x_update_tracking_tag' ? updateTrackingTag.parse(op.payload) : undefined;
    if (!input) throw new AdportError('INVALID_INPUT', 'x: unsupported measurement mutation');
    const current = 'tracking_tag_id' in input ? (await this.getTracking({ account_id: account, tracking_tag_id: input.tracking_tag_id })).data : undefined;
    if (current && ('expected_configuration_hash' in input && current.configuration_hash !== input.expected_configuration_hash || current.deleted)) throw new AdportError('INVALID_INPUT', 'x: tracking-tag configuration changed; read and preview it again');
    const line = await this.entities.getLineItem(account, 'line_item_id' in input ? input.line_item_id : current!.line_item_id), campaign = await this.entities.getCampaign(account, line.campaign_id);
    if (line.deleted || campaign.deleted || line.entity_status === 'DRAFT' || campaign.entity_status === 'DRAFT') throw new AdportError('INVALID_INPUT', 'x: tracking-tag writes require a non-deleted, non-draft line item and campaign');
    const params: XParams = create ? { line_item_id: line.id, tracking_tag_type: (input as z.infer<typeof createTrackingTag>).tracking_tag_type, tracking_tag_url: (input as z.infer<typeof createTrackingTag>).tracking_tag_url } : 'tracking_tag_url' in input ? { tracking_tag_url: input.tracking_tag_url } : {};
    const title = `${create ? 'Associate' : remove ? 'Remove' : 'Update'} ${create ? params.tracking_tag_type === 'IMPRESSION_TAG' ? 'impression' : 'click' : current!.tracking_tag_type === 'IMPRESSION_TAG' ? 'impression' : 'click'} tracker`;
    const fields = [{ label: 'Ad group', after: line.name ?? line.id }, { label: 'Tracking URL', ...(current ? { before: current.tracking_tag_url } : {}), after: remove ? null : params.tracking_tag_url }];
    return { summary: `${title} · ${line.name ?? line.id}`, changes: [`${remove ? '-' : create ? '+' : '~'} ${JSON.stringify(params)}${current ? ` · tag ${current.id}` : ''}`], notes, coercions: [], budgetDeltas: [], review: { provider: 'x', accountId: account, kind: op.kind, title, subject: line.name ?? line.id, fields, notices: notes }, execute: async () => {
      let resource = current?.id, accepted = false;
      try {
        const receipt = await this.entities.client.request(create ? 'POST' : remove ? 'DELETE' : 'PUT', `${this.base(account, 'tracking_tags')}${current ? `/${current.id}` : ''}`, z.looseObject({ data: z.looseObject({ id }), request }), params);
        accepted = true;
        const expectedId = resource;resource = receipt.data.id;
        if (expectedId && resource !== expectedId) throw new Error('ID differs');
        this.scope(receipt, account, 'tracking_tags', resource);
        const actual = (await this.getTracking({ account_id: account, tracking_tag_id: resource, with_deleted: remove })).data;
        const expected = create ? { ...params, id: resource, deleted: false } : { ...configuration(current!), ...params, deleted: remove };
        if (Object.entries(expected).some(([key, value]) => canonical((actual as Row)[key]) !== canonical(value))) throw new Error('Configuration differs');
        return { applied: true, resourceIds: [resource] };
      } catch (error) {
        if (!accepted && rejection(error)) throw error;
        const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Row : {};
        const ids = [...new Set([current?.id, resource, ...(Array.isArray(details.resource_ids) ? details.resource_ids.filter(value => typeof value === 'string' && id.safeParse(value).success) as string[] : [])].filter((value): value is string => !!value))];
        throw new AdportError('PROVIDER_ERROR', 'x: tracking-tag mutation outcome unconfirmed; inspect the selected account before another write; do not replay automatically', { resource_ids: ids });
      }
    } };
  }
  async conversions(value: unknown) {
    const input = conversionStats.parse(value), account = await this.entities.getAccount(input.account_id);
    const start = xAccountMidnight(input.start_date, account.timezone), endDate = new Date(Date.parse(`${input.end_date}T00:00:00Z`) + day).toISOString().slice(0, 10), end = xAccountMidnight(endDate, account.timezone);
    if (account.timezone_switch_at && (!Number.isFinite(Date.parse(account.timezone_switch_at)) || start < Date.parse(account.timezone_switch_at))) throw new AdportError('INVALID_INPUT', 'x: requested dates predate the account timezone switch; previous reporting timezone is unknown');
    for (const resource of input.entity_ids) {
      if (input.entity === 'CAMPAIGN') await this.entities.getCampaign(input.account_id, resource);
      else if (input.entity === 'LINE_ITEM') await this.entities.getLineItem(input.account_id, resource);
      else {
        const { data } = await this.entities.client.request('GET', `accounts/${input.account_id}/promoted_tweets/${resource}`, z.object({ data: promotedTweetSchema }));
        if (data.id !== resource) throw new AdportError('PROVIDER_ERROR', 'x: conversion entity ID mismatch');
        await this.entities.getLineItem(input.account_id, data.line_item_id);
      }
    }
    const asynchronous = end - start > 7 * day || end < Date.now() - 7 * day;
    const result = await this.analytics.totals(input.account_id, { entity: input.entity, entity_ids: input.entity_ids.join(','), start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), granularity: 'TOTAL', placement: input.placement, metric_groups: input.metric_group }, asynchronous);
    const prefix = input.metric_group === 'WEB_CONVERSION' ? 'conversion_' : 'mobile_conversion_';
    const data = result.data.map(row => ({ ...row, id_data: row.id_data.map(value => ({ ...value, metrics: Object.fromEntries(Object.entries(value.metrics).filter(([key]) => key.startsWith(prefix))) })) }));
    return { ...result, data, records: data.map(value => ({ id: value.id, name: `${input.entity} ${value.id}`, metric_group: input.metric_group, placement: input.placement, native_metrics: value.id_data[0]!.metrics })), normalized: false, placement: input.placement, metric_group: input.metric_group, notes: ['Native conversion objects are preserved without summing event types, attribution buckets or order quantities. Sale-amount currency/units are not normalized to revenue, CPA or ROAS.', 'This report covers only the selected placement and provider attribution settings. It does not send events or change tracking configuration.'] };
  }
}
