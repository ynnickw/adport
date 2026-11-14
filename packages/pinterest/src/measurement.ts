import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { PinterestAdsClient } from './client.js';
import type { PinterestAdsProvider } from './provider.js';
import { pinterestId as id } from './schemas.js';

type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]>; resultDetails?(): unknown; resultWarnings?(): string[] };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(4096), decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const optionalText = text.nullable().optional(), integer = z.number().int().nonnegative().safe();
const aem = { aem_db_enabled: z.boolean().default(false), aem_enabled: z.boolean().default(false), aem_external_id_enabled: z.boolean().default(false), aem_fnln_enabled: z.boolean().default(false), aem_ge_enabled: z.boolean().default(false), aem_loc_enabled: z.boolean().default(false), aem_ph_enabled: z.boolean().default(false) };
const tag = z.looseObject({ id: id.optional(), ad_account_id: id, name: z.string(), status: z.string().optional(), configs: z.record(z.string(), z.unknown()).optional(), last_fired_time_ms: z.number().nullable().optional() });
const tagCreate = z.object({ name: z.string().trim().min(1).max(255), ...aem, md_frequency: z.number().default(1), expected_context_hash: hash, confirm_enhanced_match_consent: z.boolean().default(false) }).strict().refine(value => !Object.keys(aem).some(key => value[key as keyof typeof aem]) || value.confirm_enhanced_match_consent, 'Enabling enhanced match requires explicit consent confirmation');
const eventMetadata = z.looseObject({ ad_account_id: id.optional(), conversion_tag_id: id.optional(), conversion_event: z.string().optional(), created_time: z.number().int().optional(), reporting_conversion_event: z.string().optional() });
const sourcePlatform = z.enum(['WEB', 'MOBILE', 'MOBILE_ANDROID', 'MOBILE_IOS', 'OFFLINE', 'PINTEREST_WEB', 'PINTEREST_ANDROID', 'PINTEREST_IOS', 'POINT_OF_SALE']);
const ingestionSource = z.enum(['TAG', 'MMP', 'FILE_UPLOAD', 'CONVERSIONS_API', 'NATIVE']);
const qualityInput = z.object({ account_id: id, lookback_period: z.enum(['1d', '14d']), source_platform: sourcePlatform.optional(), ingestion_source: ingestionSource.optional() }).strict();
const component = z.looseObject({ coverage: z.number(), overlap: z.number().optional(), issues: z.array(z.looseObject({ id: z.string(), name: z.string(), reason: z.string() })).optional() });
const quality = z.looseObject({ overall_status: z.enum(['NEEDS_IMPROVEMENT', 'FAIR', 'GOOD']), quality_components: z.record(z.string(), z.record(z.string(), component)), ingestion_source: ingestionSource, source_platform: sourcePlatform, lookback_period: z.enum(['1d', '14d']) });
const hashedValues = z.array(hash).min(1).max(100);
const userData = z.object({ em: hashedValues.optional(), hashed_maids: hashedValues.optional(), ph: hashedValues.optional(), ge: hashedValues.optional(), db: hashedValues.optional(), ln: hashedValues.optional(), fn: hashedValues.optional(), ct: hashedValues.optional(), st: hashedValues.optional(), zp: hashedValues.optional(), country: hashedValues.optional(), external_id: hashedValues.optional(), client_ip_address: z.string().refine(value => isIP(value) !== 0 && !['0.0.0.0', '::'].includes(value), 'Use a valid, non-unspecified IP address').optional(), client_user_agent: z.string().min(1).max(16384).optional(), click_id: optionalText, partner_id: optionalText }).strict().refine(value => Boolean(value.em?.length || value.hashed_maids?.length || value.client_ip_address && value.client_user_agent), 'Provide SHA-256 email/MAID or both client IP address and user agent');
const product = z.object({ id: text.optional(), item_brand: text.optional(), item_brand_id: z.string().max(64).optional(), item_category: text.optional(), item_name: text.optional(), item_price: decimal.optional(), quantity: integer.optional() }).strict();
const customData = z.object({ content_brand: optionalText, content_category: optionalText, content_ids: z.array(text).max(1000).optional(), content_name: optionalText, contents: z.array(product).max(1000).optional(), currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(), external_measurement_id: optionalText, external_measurement_vendor_id: z.number().int().safe().nullable().optional(), np: optionalText, num_items: integer.optional(), opt_out_type: optionalText, order_id: optionalText, predicted_ltv: decimal.nullable().optional(), search_string: optionalText, value: decimal.nullable().optional() }).strict().refine(value => value.value == null && value.predicted_ltv == null || Boolean(value.currency), 'Provide explicit ISO currency with monetary values');
const appInfo = z.object({ app_id: z.string().max(200).optional(), app_name: z.string().max(200).optional(), app_package_name: z.string().max(200).optional(), app_store: z.string().max(100).optional(), app_version: z.string().max(100).optional(), install_time: integer.optional(), user_agent: z.string().max(16384).optional(), window_height: integer.max(30720).optional(), window_width: integer.max(30720).optional() }).strict();
const deviceInfo = z.object({ battery_level: integer.max(100).optional(), brand: z.string().max(100).optional(), carrier: z.string().max(100).optional(), cpu_cores: integer.max(1152).optional(), external_storage_free_space: integer.max(1048576).optional(), external_storage_size: integer.max(1048576).optional(), form_factor: z.enum(['desktop', 'laptop', 'cellphone', 'tablet', 'smartwatch', 'tv', 'vr', 'console', 'other']).optional(), kernel_version: z.string().max(100).optional(), languages: z.array(z.string()).max(100).optional(), locale: z.string().max(35).optional(), model: z.string().max(100).optional(), network_type: z.enum(['wifi', 'cellular_2g', 'cellular_3g', 'cellular_4g', 'cellular_5g', 'cellular_6g', 'ethernet', 'unknown']).optional(), os_family: z.enum(['ios', 'android', 'macos', 'windows', 'linux', 'bsd', 'other']).optional(), os_name: z.string().max(100).optional(), os_release_name: z.string().max(100).optional(), os_version: z.string().max(100).optional(), screen_density: integer.max(100000).optional(), screen_height: integer.max(30720).optional(), screen_width: integer.max(30720).optional(), storage_free_space: integer.max(1048576).optional(), storage_size: integer.max(1048576).optional(), timezone: z.string().max(40).optional(), timezone_abbr: z.string().max(5).optional(), type: z.string().max(100).optional() }).strict();
const sourceUrl = z.string().url().max(16384).refine(value => { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }, 'Use an HTTP(S) source URL without credentials');
const event = z.object({ action_source: z.enum(['web', 'app_android', 'app_ios', 'offline']), event_id: z.string().min(1).max(512), event_name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), event_time: integer.refine(value => value <= Math.floor(Date.now() / 1000) + 60, 'Event time must be Unix seconds and not in the future'), user_data: userData, app_id: optionalText, app_info: appInfo.optional(), app_name: optionalText, app_version: optionalText, custom_data: customData.optional(), device_brand: optionalText, device_carrier: optionalText, device_info: deviceInfo.optional(), device_model: optionalText, device_type: optionalText, event_source_url: sourceUrl.nullable().optional(), language: optionalText, opt_out: z.boolean().optional(), os_version: optionalText, partner_name: optionalText, wifi: z.boolean().optional() }).strict();
const sendEvents = z.object({ expected_context_hash: hash, test: z.boolean().default(true), confirm_data_rights: z.literal(true), confirm_live_events: z.boolean().default(false), data: z.array(event).min(1).max(1000) }).strict().refine(value => value.test || value.confirm_live_events, 'Live event submission requires confirm_live_events').refine(value => new Set(value.data.map(item => item.event_id)).size === value.data.length, 'Use unique stable event IDs within the batch');
const eventResponse = z.object({ num_events_received: integer, num_events_processed: integer, events: z.array(z.object({ status: z.enum(['failed', 'processed']), error_message: z.string().nullable().optional(), warning_message: z.string().nullable().optional() })) });
const writes = new Set(['pinterest_create_conversion_tag', 'pinterest_send_conversion_events']);

/** Native wire contracts: Pinterest-owned v5 OpenAPI5.28.0 and Conversions API guide, checked2026-11-04. */
export class PinterestMeasurementService {
  constructor(private readonly client: PinterestAdsClient) {}
  supports(tool: string) { return writes.has(tool); }
  private base(account: string) { return `ad_accounts/${id.parse(account)}`; }
  private owned<T extends { ad_account_id?: string }>(account: string, row: T): T {
    if (row.ad_account_id !== undefined && row.ad_account_id !== account) throw new AdportError('PROVIDER_ERROR', 'pinterest: measurement response belongs to another advertiser');
    return row;
  }
  async tags(account: string, filterDeleted = false) {
    const result = await this.client.get(`${this.base(account)}/conversion_tags`, z.object({ items: z.array(tag) }), new URLSearchParams({ filter_deleted: String(filterDeleted) }));
    result.items.forEach(row => this.owned(account, row));
    const ids = result.items.flatMap(row => row.id ? [row.id] : []);
    if (new Set(ids).size !== ids.length) throw new AdportError('PROVIDER_ERROR', 'pinterest: duplicate conversion-tag IDs');
    return { ...result, account_id: account, truncated: false };
  }
  async context(account: string) {
    const advertiser = await this.client.get(this.base(account), z.looseObject({ id, name: z.string().optional(), currency: z.string().optional() }));
    if (advertiser.id !== account) throw new AdportError('PROVIDER_ERROR', 'pinterest: measurement account ID mismatch');
    const tags = await this.tags(account);
    const configuration = tags.items.map(row => ({ id: row.id ?? null, name: row.name, status: row.status ?? null, configs: row.configs ?? null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { account_id: account, advertiser, tags: tags.items, snapshot_hash: digest({ account_id: account, currency: advertiser.currency ?? null, tags: configuration }), notes: ['Tag creation does not install tracking. Event uploads are separate guarded operations and default to test mode.', 'The native API exposes tag creation and reads; no tag edit/delete endpoint is exposed here.'] };
  }
  async getTag(account: string, tagId: string) {
    const row = await this.client.get(`${this.base(account)}/conversion_tags/${id.parse(tagId)}`, tag);
    this.owned(account, row);
    if (row.id !== tagId) throw new AdportError('PROVIDER_ERROR', 'pinterest: conversion-tag ID mismatch');
    return row;
  }
  async eligible(account: string) {
    const result = await this.client.get(`${this.base(account)}/conversion_tags/ocpm_eligible`, z.record(z.string(), z.array(eventMetadata)));
    if (Object.keys(result).some(key => key !== account)) throw new AdportError('PROVIDER_ERROR', 'pinterest: eligible-event mapping belongs to another advertiser');
    return { account_id: account, events: (result[account] ?? []).map(row => this.owned(account, row)) };
  }
  async visits(input: { account_id: string; page_size: number; bookmark?: string; order: 'ASCENDING' | 'DESCENDING' }) {
    const params = new URLSearchParams({ page_size: String(input.page_size), order: input.order });
    if (input.bookmark) params.set('bookmark', input.bookmark);
    const result = await this.client.get(`${this.base(input.account_id)}/conversion_tags/page_visit`, z.object({ items: z.array(eventMetadata), bookmark: z.string().nullable().optional() }), params);
    if (result.items.length > input.page_size || result.bookmark && (!result.items.length || result.bookmark === input.bookmark)) throw new AdportError('PROVIDER_ERROR', 'pinterest: page-visit pagination did not advance');
    result.items.forEach(row => this.owned(input.account_id, row));
    return { ...result, account_id: input.account_id, truncated: Boolean(result.bookmark), ...(result.bookmark ? { next_cursor: result.bookmark } : {}) };
  }
  async quality(input: z.infer<typeof qualityInput>) {
    const parsed = qualityInput.parse(input), params = new URLSearchParams({ lookback_period: parsed.lookback_period });
    if (parsed.source_platform) params.set('source_platform', parsed.source_platform);
    if (parsed.ingestion_source) params.set('ingestion_source', parsed.ingestion_source);
    const result = await this.client.get(`${this.base(parsed.account_id)}/conversion_eqs`, z.array(quality), params);
    if (result.some(row => row.lookback_period !== parsed.lookback_period || parsed.source_platform && row.source_platform !== parsed.source_platform || parsed.ingestion_source && row.ingestion_source !== parsed.ingestion_source)) throw new AdportError('PROVIDER_ERROR', 'pinterest: event-quality response ignored the selected filters');
    return { account_id: parsed.account_id, items: result };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.kind !== 'create') throw new AdportError('INVALID_INPUT', 'pinterest: measurement writes require create kind');
    if (op.tool === 'pinterest_create_conversion_tag') {
      const input = tagCreate.parse(op.payload), context = await this.context(op.accountId);
      this.checkContext(input.expected_context_hash, context.snapshot_hash);
      if (context.tags.some(row => !row.id) || context.tags.some(row => row.name.toLowerCase() === input.name.toLowerCase())) throw new AdportError('INVALID_INPUT', 'pinterest: conversion tag already exists or tag identity is incomplete; inspect existing tags');
      const { expected_context_hash: _hash, confirm_enhanced_match_consent: _consent, ...body } = input;
      return { summary: `Create Pinterest conversion tag "${input.name}"`, changes: [`+ Conversion tag metadata for advertiser ${op.accountId}. Enhanced-match flags are explicitly supplied.`], notes: ['This creates tag metadata only. It does not install the returned code, send events or change ad delivery.', 'No native tag delete endpoint is available. Inspect existing tags before creating another.'], coercions: [], budgetDeltas: [], execute: async () => {
        const row = await this.client.mutate(`${this.base(op.accountId)}/conversion_tags`, 'POST', body, tag);
        const resourceIds = row.id ? [row.id] : [];
        if (row.ad_account_id !== op.accountId || !row.id || row.name !== input.name || row.configs && Object.entries(body).some(([key, value]) => key !== 'name' && row.configs![key] !== undefined && row.configs![key] !== value)) throw new AdportError('PROVIDER_ERROR', 'pinterest: conversion-tag creation not confirmed; inspect before any retry', { resource_ids: resourceIds });
        return resourceIds;
      } };
    }
    if (op.tool !== 'pinterest_send_conversion_events') throw new AdportError('INVALID_INPUT', 'pinterest: unsupported measurement write');
    const input = sendEvents.parse(op.payload), context = await this.context(op.accountId);
    this.checkContext(input.expected_context_hash, context.snapshot_hash);
    const count = input.data.length, batchHash = digest(input.data), mode = input.test ? 'TEST' : 'LIVE';
    let details: unknown, warnings: string[] = [];
    const notices = [input.test ? 'Pinterest test mode: events are not recorded for reporting or ad optimization.' : 'Live events can affect attribution, reported revenue, audiences and automated bidding.', 'Preview sends no event data. Applying sends this exact batch; event IDs must remain stable for deduplication.', 'Customer data, source URLs, order IDs and device details are omitted from this review and receipts. Inspect per-row outcomes before any new submission; no automatic retry.'];
    return { summary: `Send ${count} Pinterest conversion events (${mode})`, changes: [`+ ${count} events; batch SHA-256 ${batchHash}; mode ${mode}.`], notes: notices, coercions: [], budgetDeltas: [], review: { provider: 'pinterest', accountId: op.accountId, kind: 'create', title: 'Send conversion events', fields: [{ label: 'Mode', after: mode }, { label: 'Events', after: count }, { label: 'Batch SHA-256', after: batchHash }], notices }, resultDetails: () => details, resultWarnings: () => warnings, execute: async () => {
      let result: z.infer<typeof eventResponse>;
      try { result = await this.client.mutate(`${this.base(op.accountId)}/events`, 'POST', { data: input.data }, eventResponse, new URLSearchParams({ test: String(input.test) })); }
      catch (error) {
        const native = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
        throw new AdportError('PROVIDER_ERROR', 'pinterest: conversion-event submission unconfirmed; inspect native diagnostics before any new submission. No automatic retry.', { status: 'UNCONFIRMED', mode, batch_sha256: batchHash, record_count: count, ...(typeof native.http_status === 'number' ? { http_status: native.http_status } : {}), ...(typeof native.api_code === 'number' || typeof native.api_code === 'string' && /^-?\d{1,12}$/.test(native.api_code) ? { api_code: native.api_code } : {}) });
      }
      const rows = result.events.map((row, index) => ({ index, status: row.status, has_error: Boolean(row.error_message), has_warning: Boolean(row.warning_message) }));
      const processed = rows.filter(row => row.status === 'processed').length;
      if (result.num_events_received !== count || result.events.length !== count || result.num_events_processed !== processed) throw new AdportError('PROVIDER_ERROR', 'pinterest: conversion-event receipt counts disagree; no automatic retry', { status: 'UNCONFIRMED', mode, batch_sha256: batchHash, record_count: count, num_events_received: result.num_events_received, num_events_processed: result.num_events_processed, rows });
      const complete = processed === count && rows.every(row => !row.has_error);
      details = { status: complete ? 'COMPLETE' : 'PARTIAL_OR_UNCONFIRMED', mode, batch_sha256: batchHash, record_count: count, num_events_received: result.num_events_received, num_events_processed: result.num_events_processed, failed_count: count - processed, rows };
      if (!processed) throw new AdportError('PROVIDER_ERROR', 'pinterest: no conversion events were processed; inspect row outcomes before any new submission', details);
      if (!complete || rows.some(row => row.has_warning)) warnings.push(`${processed} of ${count} events processed; ${count - processed} failed. Inspect result.details and native diagnostics before submitting again.`);
      if (input.test) warnings.push('Test-mode validation only; these events were not recorded for reporting or optimization.');
      return [];
    } };
  }
  private checkContext(expected: string, actual: string) {
    if (expected !== actual) throw new AdportError('INVALID_INPUT', 'pinterest: measurement context changed; read it again before requesting a new preview');
  }
}

export function pinterestMeasurementTools(provider: PinterestAdsProvider): AnyToolDefinition[] {
  const read = <T extends z.ZodRawShape>(name: string, description: string, input: z.ZodObject<T>, handler: (input: z.output<z.ZodObject<T>>) => Promise<unknown>) => defineTool({ name, namespace: 'pinterest', description, input, annotations: { readOnly: true }, handler });
  return [
    read('pinterest_measurement_context', 'Read advertiser identity, conversion tags and a stable snapshot_hash for guarded measurement writes.', z.object({ account_id: id }), input => provider.measurement.context(input.account_id)),
    read('pinterest_conversion_tags', 'Read advertiser-owned conversion tags and code snippets as data. Unpaged native collection; does not install tracking or send events.', z.object({ account_id: id, filter_deleted: z.boolean().default(false) }), input => provider.measurement.tags(input.account_id, input.filter_deleted)),
    read('pinterest_get_conversion_tag', 'Read one advertiser-owned conversion tag by ID. Code snippets are returned as text only.', z.object({ account_id: id, conversion_tag_id: id }), input => provider.measurement.getTag(input.account_id, input.conversion_tag_id)),
    read('pinterest_conversion_tag_eligible_events', 'Read the advertiser’s native OCPM-eligible conversion-tag events without changing optimization.', z.object({ account_id: id }), input => provider.measurement.eligible(input.account_id)),
    defineTool({ name: 'pinterest_conversion_tag_page_visits', namespace: 'pinterest', description: 'Read native conversion-tag page-visit metadata with bookmark pagination.', input: z.object({ account_id: id, page_size: z.number().int().min(1).max(250).default(25), bookmark: z.string().min(1).max(4096).optional(), order: z.enum(['ASCENDING', 'DESCENDING']).default('ASCENDING') }), annotations: { readOnly: true }, pagination: { cursorInput: 'bookmark' }, handler: input => provider.measurement.visits(input) }),
    read('pinterest_event_quality', 'Read Pinterest’s native conversion-event quality diagnostics for explicit lookback/source filters. No derived score or delivery change.', qualityInput, input => provider.measurement.quality(input)),
    guardedWriteTool({ name: 'pinterest_create_conversion_tag', namespace: 'pinterest', provider: 'pinterest', kind: 'create', destructive: false, description: 'Create conversion-tag metadata using expected_context_hash. Enhanced match defaults off and requires consent when enabled. Does not install code or send events; no native tag delete endpoint.', payload: tagCreate }),
    guardedWriteTool({ name: 'pinterest_send_conversion_events', namespace: 'pinterest', provider: 'pinterest', kind: 'create', description: 'Send 1–1000 conversion events using expected_context_hash. Defaults test=true; all applies send data. Requires data-rights confirmation; live requires confirm_live_events. Use stable event IDs, prehashed SHA-256 matching fields and explicit currency with decimal values. Per-index outcomes; no automatic retry.', payload: sendEvents }),
  ];
}
