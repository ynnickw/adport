import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AdportError } from '@adport/core';
import type { TikTokClient } from './client.js';
import { audienceNativeId } from './custom-audience-schemas.js';
import { audienceSourceList, audienceIdentityList, audienceRuleContext, ruleSelection } from './audience-authoring-schemas.js';
import { nativeListComplete } from './pagination.js';
import { audienceOperationFailure } from './custom-audiences.js';

type Input = z.infer<typeof audienceSourceList>;
type Source = { id: string; name: string; eligible: boolean; configuration: Record<string, unknown> };
const opaque = z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/), native = z.union([opaque, z.number().int().positive().safe()]).transform(String);
const pageInfo = z.object({ page: z.number().int().positive().safe(), page_size: z.number().int().positive().safe(), total_page: z.number().int().nonnegative().safe().optional(), total_number: z.number().int().nonnegative().safe().optional() });
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const invalid = () => new AdportError('PROVIDER_ERROR', 'TikTok audience source scope, identity, response or pagination could not be verified.');
const cursorSchema = z.object({ selection: z.string(), page: z.number().int().positive().safe().optional(), timestamp: z.string().regex(/^\d+$/).optional(), offset: z.number().int().nonnegative().max(5000).optional(), snapshot: z.string().optional() }).strict();
const encode = (value: z.infer<typeof cursorSchema>) => Buffer.from(JSON.stringify(value)).toString('base64url');
const timestamp = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()]).transform(String);

/** Native advertiser-scoped reads; no account/BC sharing or grant mutation. */
export class TikTokAudienceSources {
  constructor(private readonly client: TikTokClient, private readonly requireAdvertiser: (account: string) => Promise<void>) {}
  private async get(path: string, params: Record<string, unknown>) { try { return await this.client.get<unknown>(path, params); } catch (error) { throw audienceOperationFailure(error); } }
  private async account(account: string) { try { await this.requireAdvertiser(account); } catch (error) { throw audienceOperationFailure(error); } }
  async identities(value: unknown) {
    const input = audienceIdentityList.parse(value), { account_id, ...params } = input;
    try {
    const data = z.object({ identity_list: z.array(z.object({ identity_id: opaque, identity_type: z.string(), identity_authorized_bc_id: audienceNativeId.optional(), display_name: z.string().optional(), username: z.string().optional(), available_status: z.string().optional() })).max(100), page_info: pageInfo.optional() }).parse(await this.get('identity/get', { advertiser_id: account_id, ...params }));
    if (new Set(data.identity_list.map(row => `${row.identity_type}:${row.identity_id}:${row.identity_authorized_bc_id ?? ''}`)).size !== data.identity_list.length || data.identity_list.length > input.page_size || data.page_info && (data.page_info.page !== input.page || data.page_info.page_size !== input.page_size)) throw invalid();
    const complete = input.identity_type ? nativeListComplete(data.page_info, data.identity_list.length) : null;
    return { ...data, records: data.identity_list.map(row => ({ id: `${row.identity_type}:${row.identity_id}:${row.identity_authorized_bc_id ?? ''}`, name: row.display_name ?? row.username ?? row.identity_id, identity_id: row.identity_id, identity_type: row.identity_type, business_center: row.identity_authorized_bc_id, availability: row.available_status })), complete, truncated: complete !== true, ...(complete === false ? { next_page: input.page + 1 } : {}), notes: ['Native identity pagination is reliable only when identity_type is specified. A BC query may return all identities linked to the advertiser; returned BC references are preserved. Exact video source selection rechecks identity/info.'] };
    } catch (error) { if (error instanceof AdportError) throw error;throw invalid(); }
  }
  private async identity(input: Input) {
    const raw = await this.get('identity/info', { advertiser_id: input.account_id, identity_id: input.identity_id, identity_type: input.identity_type, ...(input.identity_authorized_bc_id ? { identity_authorized_bc_id: input.identity_authorized_bc_id } : {}) });
    const row = z.object({ identity_info: z.object({ identity_id: opaque, identity_type: z.string(), identity_authorized_bc_id: audienceNativeId.optional(), available_status: z.string(), can_pull_video: z.boolean().optional(), can_use_live_ads: z.boolean().optional() }) }).parse(raw).identity_info;
    if (row.identity_id !== input.identity_id || row.identity_type !== input.identity_type || row.available_status !== 'AVAILABLE' || input.identity_type === 'BC_AUTH_TT' && row.identity_authorized_bc_id !== input.identity_authorized_bc_id) throw invalid();return row;
  }
  async list(value: unknown) {
    const input = audienceSourceList.parse(value);
    try {
    const { cursor, ...selection } = input, key = digest({ ...selection, source_ids: input.source_ids ? [...input.source_ids].sort() : undefined });let navigation: z.infer<typeof cursorSchema> = { selection: key };
    if (cursor) { try { navigation = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); } catch { throw new AdportError('INVALID_INPUT', 'Invalid source cursor; restart this selection.'); }if (navigation.selection !== key) throw new AdportError('PENDING_MISMATCH', 'Audience source selection changed; restart its first page.'); }
    const page = navigation.page ?? 1, offset = navigation.offset ?? 0, params = { advertiser_id: input.account_id }, type = input.source_type;let rows: Source[], next: string | undefined, complete: boolean | null = true;
    if (['ENGAGEMENT_LIVE_VIDEO', 'ENGAGEMENT_ORGANIC_VIDEO'].includes(type)) {
      const identity = await this.identity(input), current = navigation.timestamp ?? '0';if (!Number.isSafeInteger(Number(current))) throw invalid();
      const raw = await this.get(type === 'ENGAGEMENT_LIVE_VIDEO' ? 'identity/live/get' : 'identity/video/get', { ...params, identity_id: input.identity_id, identity_type: input.identity_type, ...(input.identity_authorized_bc_id ? { identity_authorized_bc_id: input.identity_authorized_bc_id } : {}), cursor: Number(current), ...(type === 'ENGAGEMENT_ORGANIC_VIDEO' ? { count: input.page_size, item_type: 'VIDEO', exclude_adsonly: true } : {}) });
      const data = z.object({ cursor: timestamp, has_more: z.boolean(), video_list: z.array(z.object({ item_id: native, item_type: z.string(), status: z.string(), text: z.string().max(100_000).optional() })).max(20).optional(), live_list: z.array(z.object({ live_id: native, finish_timestamp: z.string().optional() })).max(5000).optional() }).parse(raw);
      if (type === 'ENGAGEMENT_LIVE_VIDEO') { if (!data.live_list) throw invalid();rows = data.live_list.map(row => ({ id: row.live_id, name: 'Live video ' + row.live_id, eligible: true, configuration: { identity, finish_timestamp: row.finish_timestamp } })); }
      else { if (!data.video_list) throw invalid();rows = data.video_list.map(row => ({ id: row.item_id, name: row.text?.slice(0, 240) || 'Video ' + row.item_id, eligible: row.item_type === 'VIDEO' && row.status === 'ITEM_STATUS_HESITATE_RECOMMEND', configuration: { identity, item_type: row.item_type, status: row.status } })); }
      this.unique(rows);if (data.has_more && (!rows.length || data.cursor === current)) throw invalid();const fingerprint = digest(rows);
      if (offset && navigation.snapshot !== fingerprint) throw new AdportError('PENDING_MISMATCH', 'Native video page changed; restart its first page.');
      const total = rows.length;rows = rows.slice(offset, offset + input.page_size);
      if (offset && offset >= total) throw invalid();
      if (offset + rows.length < total) next = encode({ selection: key, timestamp: current, offset: offset + rows.length, snapshot: fingerprint });else if (data.has_more) next = encode({ selection: key, timestamp: data.cursor });complete = !next;
    } else if (type === 'ENGAGEMENT' || type === 'PIXEL') {
      const adgroup = type === 'ENGAGEMENT', raw = await this.get(adgroup ? 'adgroup/get' : 'pixel/list', { ...params, page, page_size: input.page_size, ...(adgroup ? { fields: ['advertiser_id', 'adgroup_id', 'adgroup_name', 'campaign_id'], ...(input.source_ids ? { filtering: { adgroup_ids: input.source_ids } } : {}) } : input.source_ids?.length === 1 ? { pixel_id: input.source_ids[0] } : {}) });
      const data = z.object({ list: z.array(z.object({ adgroup_id: native, advertiser_id: audienceNativeId, campaign_id: audienceNativeId, adgroup_name: z.string() })).max(20).optional(), pixels: z.array(z.object({ pixel_id: native, advertiser_id: audienceNativeId.optional(), pixel_name: z.string() })).max(20).optional(), page_info: pageInfo.optional() }).parse(raw);
      if (data.page_info && (data.page_info.page !== page || data.page_info.page_size !== input.page_size)) throw invalid();
      if (adgroup) { if (!data.list || data.list.some(row => row.advertiser_id !== input.account_id || input.source_ids && !input.source_ids.includes(row.adgroup_id))) throw invalid();rows = data.list.map(row => ({ id: row.adgroup_id, name: row.adgroup_name, eligible: true, configuration: { advertiser_id: row.advertiser_id, campaign_id: row.campaign_id } })); }
      else { if (!data.pixels || data.pixels.some(row => row.advertiser_id !== undefined && row.advertiser_id !== input.account_id || input.source_ids?.length === 1 && row.pixel_id !== input.source_ids[0])) throw invalid();rows = data.pixels.map(row => ({ id: row.pixel_id, name: row.pixel_name, eligible: true, configuration: { advertiser_id: input.account_id } })); }
      this.unique(rows);complete = nativeListComplete(data.page_info, rows.length);if (complete === false) next = encode({ selection: key, page: page + 1 });
    } else {
      if (type === 'LEAD_GENERATION' || type === 'BUSINESS_ACCOUNT') await this.account(input.account_id);
      if (type === 'LEAD_GENERATION') rows = [{ id: 'ALL_LEAD_EVENTS:' + input.account_id, name: 'All available lead-generation form events', eligible: true, configuration: { advertiser_id: input.account_id, includes_future_available_sources: true } }];
      else if (type === 'BUSINESS_ACCOUNT') {
        // v1.3 renamed old numeric id to core_user_id. Never substitute the old example.
        const row = z.object({ core_user_id: audienceNativeId }).parse(await this.get('user/info', {}));rows = [{ id: row.core_user_id, name: 'Authorized TikTok for Business user', eligible: true, configuration: { advertiser_id: input.account_id, core_user_id: row.core_user_id } }];
      } else if (type === 'APP') {
        const data = z.object({ apps: z.array(z.object({ app_id: native, advertiser_id: audienceNativeId, app_name: z.string(), platform: z.string().optional(), app_platform_id: native.optional() })).max(5000) }).parse(await this.get('app/list', params));if (data.apps.some(row => row.advertiser_id !== input.account_id)) throw invalid();rows = data.apps.map(row => ({ id: row.app_id, name: row.app_name, eligible: true, configuration: { advertiser_id: row.advertiser_id, platform: row.platform, app_platform_id: row.app_platform_id } }));
      } else if (type === 'OFFLINE') {
        const data = z.object({ event_set_list: z.array(z.object({ event_set_id: native, advertiser_id: audienceNativeId, name: z.string() })).max(5000) }).parse(await this.get('offline/get', { ...params, ...(input.source_ids ? { event_set_ids: input.source_ids } : {}) }));if (data.event_set_list.some(row => row.advertiser_id !== input.account_id || input.source_ids && !input.source_ids.includes(row.event_set_id))) throw invalid();rows = data.event_set_list.map(row => ({ id: row.event_set_id, name: row.name, eligible: true, configuration: { advertiser_id: row.advertiser_id } }));
      } else {
        const data = z.object({ stores: z.array(z.object({ store_id: native, store_type: z.literal('TIKTOK_SHOP'), store_name: z.string(), store_authorized_bc_id: audienceNativeId.optional() })).max(5000) }).parse(await this.get('store/list', { ...params, store_type: 'TIKTOK_SHOP', ...(input.source_ids?.length === 1 ? { store_id: input.source_ids[0] } : {}) }));
        const stores = new Map<string, Source>();for (const row of data.stores) { if (input.source_ids?.length === 1 && row.store_id !== input.source_ids[0]) throw invalid();const prior = stores.get(row.store_id);if (prior && prior.name !== row.store_name) throw invalid();const bcs = new Set((prior?.configuration.authorized_business_centers ?? []) as string[]);if (row.store_authorized_bc_id) bcs.add(row.store_authorized_bc_id);stores.set(row.store_id, { id: row.store_id, name: row.store_name, eligible: true, configuration: { advertiser_id: input.account_id, store_type: row.store_type, authorized_business_centers: [...bcs].sort() } }); }rows = [...stores.values()];
      }
      this.unique(rows);rows.sort((a, b) => a.id.localeCompare(b.id));if (input.source_ids) rows = rows.filter(row => input.source_ids!.includes(row.id));const fingerprint = digest(rows);
      if (offset && navigation.snapshot !== fingerprint) throw new AdportError('PENDING_MISMATCH', 'Native source inventory changed; restart its first page.');const count = rows.length;if (offset && offset >= count) throw invalid();rows = rows.slice(offset, offset + input.page_size);if (offset + rows.length < count) next = encode({ selection: key, offset: offset + rows.length, snapshot: fingerprint });complete = !next;
    }
    if (input.source_ids) rows = rows.filter(row => input.source_ids!.includes(row.id));
    return { sources: rows, records: rows.map(row => ({ id: row.id, name: row.name, type, eligible: row.eligible })), complete, truncated: complete !== true, ...(next ? { next_cursor: next } : {}), notes: [type === 'ENGAGEMENT_ORGANIC_VIDEO' ? 'Native organic discovery covers at most 500 most recent public organic posts; it is not all historic posts.' : 'Completeness describes the native selected read window, not a frozen account inventory.', 'Source IDs, advertiser scope and exact identity are rechecked for rule creation. Missing pagination cannot prove absence. No source, sharing permission or tracking event is modified.'] };
    } catch (error) { if (error instanceof AdportError) throw error;throw invalid(); }
  }
  private unique(rows: Source[]) { if (new Set(rows.map(row => row.id)).size !== rows.length) throw invalid(); }
  async context(value: unknown) {
    const input = audienceRuleContext.parse(value), selection = ruleSelection(input), rules = [...input.rule_spec.inclusion_rule_set.rules, ...(input.rule_spec.exclusion_rule_set?.rules ?? [])], ids = [...new Set(rules.flatMap(row => row.event_source_ids ?? []))], all = rules.some(row => !row.event_source_ids), selected = new Map<string, Source>();
    if (all) { await this.account(input.account_id);selected.set('ALL:' + input.account_id, { id: 'ALL:' + input.account_id, name: 'All current/future available advertiser ' + (input.audience_type === 'LEAD_GENERATION' ? 'lead-form events' : 'ad-group events'), eligible: true, configuration: { advertiser_id: input.account_id, audience_type: input.audience_type, includes_future_available_sources: true } }); }
    if (ids.length) {
      let cursor: string | undefined;const seenCursors = new Set<string>(), seenIds = new Set<string>();let complete = false;
      for (let page = 0; page < 100; page++) {
        const result = await this.list({ account_id: input.account_id, source_type: input.audience_type, source_ids: ids, identity_id: input.identity_id, identity_type: input.identity_type, identity_authorized_bc_id: input.identity_authorized_bc_id, page_size: 20, cursor });
        for (const row of result.sources) { if (seenIds.has(row.id)) throw invalid();seenIds.add(row.id);if (ids.includes(row.id)) { if (!row.eligible) throw new AdportError('INVALID_INPUT', 'A selected event source is not eligible in this advertiser/identity.');selected.set(row.id, row); } }
        if (ids.every(id => selected.has(id))) { complete = true;break; }
        if (!result.next_cursor || result.complete === true) break;if (seenCursors.has(result.next_cursor)) throw invalid();seenCursors.add(result.next_cursor);cursor = result.next_cursor;
      }
      if (!complete) throw new AdportError('INVALID_INPUT', 'Every selected event source must be positively verified within the native visible window and 100-page Adport bound. No absence or cross-account authority is inferred.');
    }
    const sources = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));return { context_hash: digest({ account_id: input.account_id, selection, sources }), sources, records: sources.map(row => ({ id: row.id, name: row.name, eligible: row.eligible })), selected_sources_verified: true, notes: ['The hash binds exact rule selection and positively verified source metadata. It does not freeze event history or matched users.', ...(all ? ['All-source rules intentionally include current and future sources available to the advertiser.'] : [])] };
  }
}
