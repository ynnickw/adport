import { AdportError, LocalMediaResolver, type Creative, type MediaResolver, type WriteGuard, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { SnapchatAdsClient, snapchatUploadPath } from './client.js';
import { createAd, createCreative, createGroup, targeting, updateAd, updateCreative, updateGroup, uploadMedia } from './creative-tools.js';
import { snapchatId as id, snapchatMicros as micros } from './schemas.js';

type Row = Record<string, unknown>;
type Entity = 'campaigns' | 'adsquads' | 'ads' | 'creatives' | 'media';
export interface SnapchatPlan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<WriteResult> }
const rowSchema = z.looseObject({ id }), singular = { campaigns: 'campaign', adsquads: 'adsquad', ads: 'ad', creatives: 'creative', media: 'media' } as const;
const record = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const safeUrl = (v: unknown) => { if (!nonempty(v)) return undefined; try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? v : undefined; } catch { return undefined; } };
const moneyFields = ['daily_budget_micro', 'lifetime_budget_micro', 'bid_micro'] as const;
const formats: Record<string, string> = { SNAP_AD: 'SNAP_AD', APP_INSTALL: 'APP_INSTALL', REMOTE_WEBPAGE: 'WEB_VIEW', DEEP_LINK: 'DEEP_LINK', STORY: 'COMPOSITE', AD_TO_LENS: 'AD_TO_LENS', AD_TO_CALL: 'AD_TO_CALL', AD_TO_MESSAGE: 'AD_TO_MESSAGE', LENS: 'LENS', LENS_WEB_VIEW: 'LENS_WEB_VIEW', LENS_APP_INSTALL: 'LENS_APP_INSTALL', LENS_DEEP_LINK: 'LENS_DEEP_LINK', COLLECTION: 'COLLECTION', LEAD_GENERATION: 'LEAD_GENERATION', REMINDER: 'REMINDER' };
const ctas: Record<string, string[]> = {
  WEB_VIEW: ['APPLY_NOW', 'MORE', 'ORDER_NOW', 'PLAY', 'READ', 'SHOP_NOW', 'SHOW', 'SIGN_UP', 'VIEW', 'WATCH', 'DONATE', 'DOWNLOAD', 'RESPOND', 'BUY_TICKETS', 'SHOWTIMES', 'BOOK_NOW', 'GET_NOW', 'LISTEN', 'TRY', 'VOTE', 'VIEW_MENU', 'PRE_REGISTER', 'PLAY_GAME'],
  APP_INSTALL: ['BOOK_NOW', 'DONATE', 'DOWNLOAD', 'GET_NOW', 'INSTALL_NOW', 'ORDER_NOW', 'PLAY', 'SHOP_NOW', 'SIGN_UP', 'TRY', 'USE_APP', 'WATCH', 'VOTE', 'DIRECTIONS', 'PLAY_GAME'],
  DEEP_LINK: ['DONATE', 'PLAY', 'SHOP_NOW', 'SIGN_UP', 'USE_APP', 'MORE', 'OPEN_APP', 'TRY', 'WATCH', 'VIEW_PROFILE', 'VOTE', 'DIRECTIONS', 'PRE_REGISTER', 'PLAY_GAME', 'DOWNLOAD'],
  AD_TO_LENS: ['PLAY', 'TRY', 'SHOP_NOW', 'VOTE'],
};
function creativeFields(type: string, fields: Row) {
  for (const [key, types] of [['web_view_properties', ['WEB_VIEW', 'LENS_WEB_VIEW']], ['app_install_properties', ['APP_INSTALL', 'LENS_APP_INSTALL']], ['deep_link_properties', ['DEEP_LINK', 'LENS_DEEP_LINK']]] as const) if (fields[key] !== undefined && !(types as readonly string[]).includes(type)) throw new AdportError('INVALID_INPUT', `snapchat: ${key} does not match creative type`);
  if (fields.call_to_action !== undefined && ctas[type] && !ctas[type]!.includes(String(fields.call_to_action))) throw new AdportError('INVALID_INPUT', 'snapchat: CTA is not supported by this creative type');
}

/** Snap-owned v1 docs reviewed 2026-11-03; no SDK defaults or full-object PUTs. */
export class SnapchatCreativeService {
  constructor(private readonly client: SnapchatAdsClient, private readonly media: MediaResolver = new LocalMediaResolver()) {}
  async owned(account: string, entity: Entity, resourceId: string): Promise<Row> {
    id.parse(account); id.parse(resourceId);
    const rows = await this.client.collection(`${entity}/${resourceId}`, entity, singular[entity], rowSchema);
    const row = rows.find(row => row.id === resourceId);
    if (rows.length !== 1 || !row || (row.ad_account_id !== undefined && row.ad_account_id !== account)) throw new AdportError('INVALID_INPUT', 'snapchat: entity ID or account ownership mismatch');
    if (entity === 'adsquads') await this.owned(account, 'campaigns', id.parse(row.campaign_id));
    else if (entity === 'ads') await this.owned(account, 'adsquads', id.parse(row.ad_squad_id));
    else if (row.ad_account_id !== account) throw new AdportError('INVALID_INPUT', 'snapchat: entity does not belong to selected account');
    return row;
  }
  async shared(account: string, type: 'public_profiles' | 'pixels' | 'mobile_apps') { return { items: await this.client.sharingPolicies(id.parse(account), type), truncated: false }; }
  private async available(account: string, type: 'public_profiles' | 'pixels' | 'mobile_apps', value: string) {
    if (type === 'pixels') {
      if (!(await this.client.collection(`adaccounts/${account}/pixels`, 'pixels', 'pixel', rowSchema)).some(row => row.id === value)) throw new AdportError('INVALID_INPUT', 'snapchat: Pixel is not available to the selected account');
      return;
    }
    if (!(await this.client.sharingPolicies(account, type)).some(row => row.source.resource_id === value)) throw new AdportError('INVALID_INPUT', `snapchat: ${type} ID is not available to the selected account`);
  }
  async page(input: { account_id: string; limit: number; cursor?: string; campaign_id?: string; ad_squad_id?: string }, entity: Entity) {
    const account = id.parse(input.account_id);
    let parent = `adaccounts/${account}`;
    if (input.campaign_id) { await this.owned(account, 'campaigns', input.campaign_id); parent = `campaigns/${input.campaign_id}`; }
    if (input.ad_squad_id) { await this.owned(account, 'adsquads', input.ad_squad_id); parent = `adsquads/${input.ad_squad_id}`; }
    const data = await this.client.page(`${parent}/${entity}`, entity, singular[entity], rowSchema, { limit: String(input.limit), ...(input.cursor ? { cursor: input.cursor } : {}) });
    if (data.items.some(row => (row.ad_account_id !== undefined && row.ad_account_id !== account) || (input.campaign_id && row.campaign_id !== input.campaign_id) || (input.ad_squad_id && row.ad_squad_id !== input.ad_squad_id))) throw new AdportError('PROVIDER_ERROR', 'snapchat: collection returned a foreign account or parent');
    return data;
  }
  async targetingOptions(input: { account_id: string; dimension: string; country_code?: string; is_hec?: boolean; os_type?: string; limit: number; cursor?: string }) {
    // Global choices require a scoped account input but never expose other accounts.
    id.parse(input.account_id);
    let path: string;
    if (['region', 'metro', 'postal_code'].includes(input.dimension)) {
      if (!input.country_code) throw new AdportError('INVALID_INPUT', 'snapchat: this dimension requires country_code');
      path = `targeting/geo/${input.country_code.toLowerCase()}/${input.dimension}`;
    } else if (input.dimension === 'os_version') {
      if (!input.os_type) throw new AdportError('INVALID_INPUT', 'snapchat: os_version requires os_type');
      path = `targeting/device/${input.os_type}/os_version`;
    } else {
      const paths: Record<string, string> = { country: 'geo/country', gender: 'demographics/gender', language: 'demographics/languages', age_group: 'demographics/age_group', connection_type: 'device/connection_type', os_type: 'device/os_type', carrier: 'device/carrier', marketing_name: 'device/marketing_name', scls: 'v1/interests/scls' };
      if (!paths[input.dimension]) throw new AdportError('INVALID_INPUT', 'snapchat: unsupported targeting dimension');
      path = `targeting/${paths[input.dimension]}`;
    }
    if (input.dimension === 'scls' && (!input.country_code || input.limit < 50)) throw new AdportError('INVALID_INPUT', 'snapchat: SCLS requires country_code and limit of at least 50');
    const params = new URLSearchParams({ limit: String(input.limit), ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.dimension === 'scls' && input.country_code ? { country_code: input.country_code.toLowerCase(), ...(input.is_hec !== undefined ? { is_hec: String(input.is_hec) } : {}) } : {}) });
    const data = await this.client.request(`${path}?${params}`, 'GET', z.looseObject({ targeting_dimensions: z.array(z.looseObject({ sub_request_status: z.string() })), paging: z.object({ next_link: z.string().optional() }).optional() }));
    if (data.targeting_dimensions.some(row => row.sub_request_status.toUpperCase() !== 'SUCCESS')) throw new AdportError('PROVIDER_ERROR', 'snapchat: targeting dimension sub-request failed');
    let cursor: string | undefined;
    if (data.paging?.next_link) {
      const next = new URL(data.paging.next_link, 'https://adsapi.snapchat.com/v1/');
      if (next.origin !== 'https://adsapi.snapchat.com' || next.pathname !== `/v1/${path}` || next.username || next.password || next.hash || !(cursor = next.searchParams.get('cursor') ?? undefined) || cursor === input.cursor) throw new AdportError('PROVIDER_ERROR', 'snapchat: targeting pagination changed scope');
    }
    return { items: data.targeting_dimensions, truncated: Boolean(cursor), ...(cursor ? { next_cursor: cursor } : {}) };
  }
  async gallery(input: { account_id: string; limit: number; cursor?: string }) {
    const data = await this.page(input, 'creatives'), warnings: Array<{ provider: string; message: string }> = data.warnings.map(message => ({ provider: 'snapchat', message }));
    const mediaIds = [...new Set(data.items.flatMap(row => [row.top_snap_media_id, record(row.preview_properties).preview_media_id, record(row.app_install_properties).icon_media_id, record(row.deep_link_properties).icon_media_id]).filter(nonempty))];
    const media = new Map<string, Row>();
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, mediaIds.length) }, async () => {
      while (cursor < mediaIds.length) {
        const value = mediaIds[cursor++]!;
        try { media.set(value, await this.owned(input.account_id, 'media', value)); }
        catch (error) { warnings.push({ provider: 'snapchat', message: `Media ${value} unavailable: ${error instanceof Error ? error.message : 'provider read failed'}` }); }
      }
    }));
    const creatives: Creative[] = data.items.map(row => {
      const native = media.get(String(row.top_snap_media_id)) ?? media.get(String(record(row.preview_properties).preview_media_id));
      const url = ['IMAGE', 'VIDEO'].includes(String(native?.type)) ? safeUrl(native?.download_link) : undefined, type = native?.type === 'VIDEO' ? 'video' : 'image';
      const editable = row.type !== 'PREVIEW' && row.type !== 'COMPOSITE';
      return { id: row.id, provider: 'snapchat', account_id: input.account_id, name: String(row.name ?? row.id), type: String(row.type ?? 'CREATIVE'), ...(nonempty(row.review_status) ? { status: row.review_status } : {}), headlines: nonempty(row.headline) ? [row.headline] : nonempty(record(row.preview_properties).preview_headline) ? [String(record(row.preview_properties).preview_headline)] : [], descriptions: nonempty(row.brand_name) ? [row.brand_name] : [], landing_urls: [safeUrl(record(row.web_view_properties).url), safeUrl(record(row.deep_link_properties).web_view_fallback_url)].filter(nonempty), media: url ? [{ type, url }] : [], actions: editable ? [{ label: 'Edit shared creative (all linked ads)', tool: 'snapchat_update_creative', arguments: { account_id: input.account_id, creative_id: row.id }, fields: [{ key: 'name', label: 'Creative name', type: 'text', value: String(row.name ?? ''), max_length: 375 }, ...(nonempty(row.headline) ? [{ key: 'headline', label: 'Headline', type: 'text' as const, value: row.headline, max_length: 34 }] : []), ...(nonempty(row.brand_name) ? [{ key: 'brand_name', label: 'Brand override', type: 'text' as const, value: row.brand_name, max_length: 32 }] : [])] }] : [] };
    });
    return { ...data, creatives, warnings };
  }
  private async readyMedia(account: string, value: string, type?: string) {
    const media = await this.owned(account, 'media', value);
    if (media.media_status !== 'READY' || (type && media.type !== type)) throw new AdportError('INVALID_INPUT', 'snapchat: referenced media is not READY or has the wrong type');
    return media;
  }
  private async topMedia(account: string, value: string) {
    const media = await this.readyMedia(account, value);
    if (!['IMAGE', 'VIDEO'].includes(String(media.type))) throw new AdportError('INVALID_INPUT', 'snapchat: Top Snap must use IMAGE or VIDEO media');
  }
  private async checkTargeting(account: string, value: Row) {
    if (!Array.isArray(value.geos) || !value.geos.length) throw new AdportError('INVALID_INPUT', 'snapchat: targeting requires at least one country');
    const geos = value.geos.map(record), countries = new Set(geos.filter(geo => geo.operation !== 'EXCLUDE').map(geo => String(geo.country_code).toUpperCase()));
    if (!countries.size) throw new AdportError('INVALID_INPUT', 'snapchat: targeting requires an included country');
    const demographics = Array.isArray(value.demographics) ? value.demographics.map(record) : [];
    if (countries.size > 1 && !demographics.some(row => Array.isArray(row.languages) && row.languages.length === 1)) throw new AdportError('INVALID_INPUT', 'snapchat: multi-country targeting requires a single-language demographic entry');
    if (demographics.some(row => row.min_age && row.max_age && Number(row.min_age) > Number(row.max_age))) throw new AdportError('INVALID_INPUT', 'snapchat: minimum age exceeds maximum age');
    if (Array.isArray(value.segments) && value.segments.length) {
      const segments = await this.client.collection(`adaccounts/${account}/segments`, 'segments', 'segment', rowSchema), known = new Set(segments.map(row => row.id));
      if (segments.some(row => row.ad_account_id !== undefined && row.ad_account_id !== account)) throw new AdportError('PROVIDER_ERROR', 'snapchat: segment collection returned a foreign account');
      for (const target of value.segments.map(record)) for (const segment of Array.isArray(target.segment_id) ? target.segment_id : [target.segment_id]) if (!known.has(String(segment))) throw new AdportError('INVALID_INPUT', 'snapchat: targeting segment is not available to this account');
    }
  }
  private async mutate(account: string, entity: Entity, path: string, method: 'POST' | 'PATCH', body: unknown, expected: Row): Promise<WriteResult> {
    const data = await this.client.mutation(path, method, body, entity, singular[entity], rowSchema), ids = data.items.map(row => row.id), row = data.items[0];
    if (data.items.length !== 1 || !row || (row.ad_account_id !== undefined && row.ad_account_id !== account) || Object.entries(expected).some(([key, value]) => value !== undefined && String(row[key]) !== String(value))) throw new AdportError('PROVIDER_ERROR', 'snapchat: mutation receipt ID/account/status/money mismatch; reconcile before retrying', { resource_ids: ids, warnings: data.warnings });
    if (['campaigns', 'creatives', 'media'].includes(entity) && row.ad_account_id !== account) throw new AdportError('PROVIDER_ERROR', 'snapchat: mutation receipt missing account ownership', { resource_ids: ids });
    return { applied: true, resourceIds: ids, ...(data.warnings.length ? { details: { warnings: data.warnings } } : {}) };
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<SnapchatPlan> {
    const account = id.parse(op.accountId), p = op.payload, coercions: string[] = [], budgetDeltas: WritePreview['budgetDeltas'] = [], changes: string[] = [];
    const expectedKind = op.tool.startsWith('snapchat_create_') ? 'create' : op.tool === 'snapchat_delete_entity' ? 'remove' : 'update';
    if (op.provider !== 'snapchat' || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'snapchat: provider or write kind mismatch');
    let entity: Entity, path: string, method: 'POST' | 'PATCH' = 'PATCH', fields: Row, current: Row = {}, expected: Row = {};
    const paused = (value: string) => { if (guard.forcePausedCreation && value !== 'PAUSED') coercions.push('status coerced to PAUSED by policy (paused_creation)'); return guard.forcePausedCreation ? 'PAUSED' : value; };
    switch (op.tool) {
      case 'snapchat_create_adsquad': {
        const input = createGroup.parse(p); await this.owned(account, 'campaigns', input.campaign_id); await this.checkTargeting(account, input.targeting);
        if (input.pixel_id) await this.available(account, 'pixels', input.pixel_id);
        for (const app of input.event_sources?.MOBILE_APP ?? []) await this.available(account, 'mobile_apps', app);
        fields = { ...input, status: paused(input.status), billing_event: 'IMPRESSION', delivery_constraint: input.daily_budget_micro ? 'DAILY_BUDGET' : 'LIFETIME_BUDGET' };
        entity = 'adsquads'; path = `campaigns/${input.campaign_id}/adsquads`; method = 'POST'; expected = { campaign_id: input.campaign_id }; break;
      }
      case 'snapchat_update_adsquad': { const { ad_squad_id, ...input } = updateGroup.parse(p); current = await this.owned(account, 'adsquads', ad_squad_id); entity = 'adsquads'; path = `campaigns/${current.campaign_id}/adsquads/${ad_squad_id}`; fields = input; expected = { id: ad_squad_id, campaign_id: current.campaign_id }; break; }
      case 'snapchat_update_targeting': {
        const nativeId = id.parse(p.ad_squad_id), input = targeting.parse(p.targeting); current = await this.owned(account, 'adsquads', nativeId);
        const merged = { ...record(current.targeting), ...input }; await this.checkTargeting(account, merged);
        entity = 'adsquads'; path = `campaigns/${current.campaign_id}/adsquads/${nativeId}`; fields = { targeting: input }; expected = { id: nativeId, campaign_id: current.campaign_id }; changes.push('Targeting edits trigger review; delivery can pause temporarily and resume after approval.'); break;
      }
      case 'snapchat_set_adsquad_budget': {
        const nativeId = id.parse(p.ad_squad_id); current = await this.owned(account, 'adsquads', nativeId);
        const daily = current.delivery_constraint === 'DAILY_BUDGET', lifetime = current.delivery_constraint === 'LIFETIME_BUDGET';
        if (!daily && !lifetime) throw new AdportError('INVALID_INPUT', 'snapchat: current budget type is unavailable or uses a different buying model');
        const field = daily ? 'daily_budget_micro' : 'lifetime_budget_micro', value = micros.positive().parse(p.budget_micros);
        if (current[field] === undefined || (daily && value < 5_000_000)) throw new AdportError('INVALID_INPUT', 'snapchat: current budget missing or daily budget below minimum');
        entity = 'adsquads'; path = `campaigns/${current.campaign_id}/adsquads/${nativeId}`; fields = { [field]: value }; expected = { id: nativeId, campaign_id: current.campaign_id }; break;
      }
      case 'snapchat_set_adsquad_bidding': {
        const nativeId = id.parse(p.ad_squad_id); current = await this.owned(account, 'adsquads', nativeId);
        fields = { ...(p.bid_strategy !== undefined ? { bid_strategy: z.enum(['AUTO_BID', 'LOWEST_COST_WITH_MAX_BID', 'TARGET_COST']).parse(p.bid_strategy) } : {}), ...(p.bid_micros !== undefined ? { bid_micro: micros.positive().parse(p.bid_micros) } : {}) };
        if ((fields.bid_strategy ?? current.bid_strategy) !== 'AUTO_BID' && !(fields.bid_micro ?? current.bid_micro)) throw new AdportError('INVALID_INPUT', 'snapchat: selected strategy requires a monetary bid');
        entity = 'adsquads'; path = `campaigns/${current.campaign_id}/adsquads/${nativeId}`; expected = { id: nativeId, campaign_id: current.campaign_id }; break;
      }
      case 'snapchat_create_ad': {
        const input = createAd.parse(p); await this.owned(account, 'adsquads', input.ad_squad_id); const creative = await this.owned(account, 'creatives', input.creative_id);
        if (formats[input.type] !== creative.type) throw new AdportError('INVALID_INPUT', 'snapchat: ad type is incompatible with creative type');
        entity = 'ads'; path = `adsquads/${input.ad_squad_id}/ads`; method = 'POST'; fields = { ...input, status: paused(input.status) }; expected = { ad_squad_id: input.ad_squad_id, creative_id: input.creative_id }; break;
      }
      case 'snapchat_update_ad': { const { ad_id, ...input } = updateAd.parse(p); current = await this.owned(account, 'ads', ad_id); entity = 'ads'; path = `adsquads/${current.ad_squad_id}/ads/${ad_id}`; fields = input; expected = { id: ad_id, ad_squad_id: current.ad_squad_id }; break; }
      case 'snapchat_set_ad_status':
      case 'snapchat_set_adsquad_status': {
        entity = op.tool === 'snapchat_set_ad_status' ? 'ads' : 'adsquads'; const nativeId = id.parse(p[entity === 'ads' ? 'ad_id' : 'ad_squad_id']); current = await this.owned(account, entity, nativeId);
        fields = { status: z.enum(['ACTIVE', 'PAUSED']).parse(p.status) }; path = entity === 'ads' ? `adsquads/${current.ad_squad_id}/ads/${nativeId}` : `campaigns/${current.campaign_id}/adsquads/${nativeId}`;
        expected = { id: nativeId, [entity === 'ads' ? 'ad_squad_id' : 'campaign_id']: current[entity === 'ads' ? 'ad_squad_id' : 'campaign_id'] }; break;
      }
      case 'snapchat_create_creative': {
        const { profile_id, ...input } = createCreative.parse(p); await this.available(account, 'public_profiles', profile_id);
        creativeFields(input.type, input);
        if (input.top_snap_media_id) await this.topMedia(account, input.top_snap_media_id);
        for (const value of [input.preview_properties?.preview_media_id, input.preview_properties?.logo_media_id, input.app_install_properties?.icon_media_id, input.deep_link_properties?.icon_media_id].filter(nonempty)) await this.readyMedia(account, value, 'IMAGE');
        if (input.ad_to_lens_properties) await this.readyMedia(account, input.ad_to_lens_properties.lens_media_id, 'LENS_PACKAGE');
        if (input.preview_creative_id && (await this.owned(account, 'creatives', input.preview_creative_id)).type !== 'PREVIEW') throw new AdportError('INVALID_INPUT', 'snapchat: story preview must be a PREVIEW creative');
        for (const value of input.composite_properties?.creative_ids ?? []) await this.owned(account, 'creatives', value);
        fields = { ...input, ad_account_id: account, profile_properties: { profile_id } }; entity = 'creatives'; path = `adaccounts/${account}/creatives`; method = 'POST'; expected = { type: input.type }; break;
      }
      case 'snapchat_update_creative': {
        const { creative_id, profile_id, ...input } = updateCreative.parse(p); current = await this.owned(account, 'creatives', creative_id);
        creativeFields(String(current.type), input);
        const ads = await this.client.collection(`adaccounts/${account}/ads`, 'ads', 'ad', rowSchema, { limit: '1000' });
        if (ads.some(row => row.ad_account_id !== undefined && row.ad_account_id !== account)) throw new AdportError('PROVIDER_ERROR', 'snapchat: linked-ad collection returned a foreign account');
        const linked = ads.filter(row => row.creative_id === creative_id);
        changes.push(`Shared creative edit affects all ${linked.length} linked ad(s) and triggers review: ${linked.map(row => row.id).join(', ') || 'none currently'}.`);
        if (input.top_snap_media_id) { if (linked.length) throw new AdportError('INVALID_INPUT', 'snapchat: replace Top Snap media only on an unused creative; create a new creative/ad for media changes to linked ads'); await this.topMedia(account, input.top_snap_media_id); }
        if (profile_id) await this.available(account, 'public_profiles', profile_id);
        for (const value of [input.app_install_properties?.icon_media_id, input.deep_link_properties?.icon_media_id].filter(nonempty)) await this.readyMedia(account, value, 'IMAGE');
        fields = { ...input, ...(profile_id ? { profile_properties: { profile_id } } : {}) }; entity = 'creatives'; path = `adaccounts/${account}/creatives/${creative_id}`; expected = { id: creative_id }; break;
      }
      case 'snapchat_create_media': {
        fields = { ...z.object({ name: z.string().min(1).max(375), type: z.enum(['IMAGE', 'VIDEO']), ai_content_source: z.literal('USER_AI_GEN').optional() }).parse(p), ad_account_id: account };
        entity = 'media'; path = `adaccounts/${account}/media`; method = 'POST'; expected = { type: fields.type, media_status: 'PENDING_UPLOAD' }; break;
      }
      case 'snapchat_upload_media': {
        const input = uploadMedia.parse(p), current = await this.owned(account, 'media', input.snapchat_media_id);
        if (current.media_status !== 'PENDING_UPLOAD' || !['IMAGE', 'VIDEO'].includes(String(current.type))) throw new AdportError('INVALID_INPUT', 'snapchat: uploads require a PENDING_UPLOAD IMAGE or VIDEO container');
        const file = await this.media.read(input, { maxBytes: current.type === 'IMAGE' ? 5_000_000 : 100 * 1024 * 1024, contentTypes: current.type === 'IMAGE' ? ['image/png', 'image/jpeg'] : ['video/mp4', 'video/quicktime'] });
        return { summary: `Upload Snapchat ${current.type} media ${current.id}`, changes: [`Upload ${file.name}, ${file.bytes.byteLength} bytes, SHA-256 ${file.sha256}; no ad is created or activated.`], coercions, budgetDeltas, execute: async () => {
          const resultSchema = z.looseObject({ result: rowSchema }); let uploaded: Row;
          const chunkBytes = 32_000_000;
          if (file.bytes.byteLength <= chunkBytes) { const form = new FormData(); form.set('file', new Blob([file.bytes], { type: file.contentType }), file.name); uploaded = (await this.client.request(`media/${current.id}/upload`, 'POST', resultSchema, form)).result; }
          else {
            const initForm = new FormData(); initForm.set('file_name', file.name); initForm.set('file_size', String(file.bytes.byteLength)); initForm.set('number_of_parts', String(Math.ceil(file.bytes.byteLength / chunkBytes)));
            const init = await this.client.request(`media/${current.id}/multipart-upload-v2?action=INIT`, 'POST', z.looseObject({ upload_id: z.string().min(1), add_path: z.string(), finalize_path: z.string() }), initForm);
            snapchatUploadPath(init.add_path, current.id as string, 'ADD'); snapchatUploadPath(init.finalize_path, current.id as string, 'FINALIZE');
            for (let offset = 0, part = 1; offset < file.bytes.byteLength; offset += chunkBytes, part++) {
              const form = new FormData(); form.set('upload_id', init.upload_id); form.set('part_number', String(part)); form.set('file', new Blob([file.bytes.subarray(offset, offset + chunkBytes)], { type: file.contentType }), `${file.name}.part${part}`);
              await this.client.uploadPart(init.add_path, current.id as string, 'ADD', form, z.looseObject({ request_status: z.string() }));
            }
            const form = new FormData(); form.set('upload_id', init.upload_id);
            uploaded = (await this.client.uploadPart(init.finalize_path, current.id as string, 'FINALIZE', form, resultSchema)).result;
          }
          if (uploaded.id !== current.id || uploaded.ad_account_id !== account || uploaded.type !== current.type || !['PENDING_UPLOAD', 'READY'].includes(String(uploaded.media_status))) throw new AdportError('PROVIDER_ERROR', 'snapchat: upload receipt ownership/type/readiness mismatch; read media before retrying', { resource_ids: [current.id] });
          return { applied: true, resourceIds: [current.id as string], details: { media_status: uploaded.media_status, sha256: file.sha256 } };
        } };
      }
      case 'snapchat_delete_entity': {
        const input = z.object({ entity: z.enum(['campaigns', 'adsquads', 'ads']), resource_id: id }).parse(p); await this.owned(account, input.entity, input.resource_id);
        return { summary: `Permanently delete Snapchat ${input.entity} ${input.resource_id}`, changes: [`DELETE ${input.entity}/${input.resource_id}. This cannot be undone; review the parent/child hierarchy before approval.`], coercions, budgetDeltas, execute: async () => { const data = await this.client.request(`${input.entity}/${input.resource_id}`, 'DELETE', z.looseObject({ [input.entity]: z.array(z.unknown()) })); if ((data[input.entity] as unknown[]).length) throw new AdportError('PROVIDER_ERROR', 'snapchat: unexpected delete receipt; reconcile entity before retrying', { resource_ids: [input.resource_id] }); return { applied: true, resourceIds: [input.resource_id] }; } };
      }
      default: throw new AdportError('INVALID_INPUT', `snapchat: unsupported write ${op.tool}`);
    }
    const effective = { ...current, ...fields };
    if (effective.start_time && effective.end_time && Date.parse(String(effective.end_time)) <= Date.parse(String(effective.start_time))) throw new AdportError('INVALID_INPUT', 'snapchat: end_time must follow start_time');
    for (const key of moneyFields) if (fields[key] !== undefined) budgetDeltas.push({ target: `${entity} ${String(current.id ?? 'new')} ${key}`, ...(current[key] !== undefined ? { fromMicros: micros.parse(Number(current[key])) } : {}), toMicros: micros.positive().parse(fields[key]) });
    const critical = ['status', 'daily_budget_micro', 'lifetime_budget_micro', 'bid_micro', 'bid_strategy', 'name', 'top_snap_media_id', 'headline', 'brand_name', 'type', 'billing_event', 'delivery_constraint', 'optimization_goal', 'ai_content_source'];
    for (const key of critical) if (fields[key] !== undefined) expected[key] = fields[key];
    const body = method === 'POST' ? { [entity]: [fields] } : patches(current, fields);
    return { summary: `Snapchat ${op.tool.replace('snapchat_', '').replaceAll('_', ' ')}`, changes: [...changes, `${method} ${path}: ${JSON.stringify(body)}`], coercions, budgetDeltas, execute: () => this.mutate(account, entity, path, method, body, expected) };
  }
}

/** Nested patches preserve provider fields, including newer targeting dimensions. */
function patches(current: Row, fields: Row, prefix = ''): Array<{ op: 'add' | 'replace'; path: string; value: unknown }> {
  return Object.entries(fields).flatMap(([key, value]) => {
    const path = `${prefix}/${key}`;
    if (value && typeof value === 'object' && !Array.isArray(value) && current[key] && typeof current[key] === 'object' && !Array.isArray(current[key])) return patches(record(current[key]), value as Row, path);
    return [{ op: current[key] === undefined ? 'add' : 'replace', path, value }];
  });
}
