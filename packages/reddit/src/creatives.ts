import { AdportError, LocalMediaResolver, creativeStatusAction, type Creative, type MediaResolver, type MediaSource, type WriteGuard, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { RedditAdsClient } from './client.js';
import { bidStrategy, createAd, createGroup, createPost, importAsset, stageCopy, targeting, textAsset, updateAd, updateGroup, uploadAsset } from './creative-tools.js';
import { micros, redditId as id } from './schemas.js';

type Row = Record<string, unknown>;
type Entity = 'campaigns' | 'ad_groups' | 'ads';
interface Page { account_id: string; page_size: number; cursor?: string }
export interface RedditCreativePlan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<WriteResult> }
const rowSchema = z.looseObject({ id }), record = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const string = (v: unknown): v is string => typeof v === 'string' && Boolean(v);
const safeUrl = (v: unknown): string | undefined => { if (!string(v)) return undefined; try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? v : undefined; } catch { return undefined; } };
const landing = (v: unknown): string[] => { if (!string(v)) return []; try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? [v] : []; } catch { return []; } };

/** Typed manual campaign children and current structured-post/asset APIs. */
export class RedditCreativeService {
  constructor(private readonly client: RedditAdsClient, private readonly media: MediaResolver = new LocalMediaResolver()) {}
  private async one(path: string) {
    const result = await this.client.get<unknown>(path), parsed = rowSchema.safeParse(result.data);
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'reddit: malformed entity response');
    return parsed.data;
  }
  async owned(account: string, entity: Entity, resource: string): Promise<Row> {
    id.parse(account); id.parse(resource);
    const row = await this.one(`${entity}/${resource}`);
    if (row.id !== resource || (row.ad_account_id !== undefined && row.ad_account_id !== account)) throw new AdportError('INVALID_INPUT', 'reddit: entity ID/account ownership mismatch');
    if (entity === 'campaigns') { if (row.ad_account_id !== account) throw new AdportError('INVALID_INPUT', 'reddit: campaign is not owned by this account'); }
    else if (entity === 'ad_groups') await this.owned(account, 'campaigns', id.parse(row.campaign_id));
    else { const parent = await this.owned(account, 'ad_groups', id.parse(row.ad_group_id)); if (row.campaign_id !== undefined && row.campaign_id !== parent.campaign_id) throw new AdportError('PROVIDER_ERROR', 'reddit: ad parent hierarchy mismatch'); }
    return row;
  }
  private async page(path: string, input: Page, params: Row = {}) {
    const url = input.cursor ? this.client.nextUrl(input.cursor, path) : path;
    const data = await this.client.get<unknown>(url, input.cursor ? {} : { ...params, 'page.size': input.page_size });
    if (!Array.isArray(data.data) || data.data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new AdportError('PROVIDER_ERROR', 'reddit: malformed collection response');
    const next = data.pagination?.next_url ? this.client.nextUrl(data.pagination.next_url, path) : undefined;
    if (next === this.client.nextUrl(url, path)) throw new AdportError('PROVIDER_ERROR', 'reddit: pagination repeated the current page');
    return { items: data.data as Row[], truncated: Boolean(next), ...(next ? { next_cursor: next } : {}) };
  }
  async profiles(account: string) {
    // Account profile pages cap at 100; business profile pages allow 1,000.
    const rows = await this.client.getPaged<unknown>(`ad_accounts/${id.parse(account)}/profiles`, { 'page.size': 100 }, 5000);
    return rows.map(row => rowSchema.parse(row));
  }
  private async profile(account: string, profileId: string) {
    const rows = (await this.profiles(account)).filter(row => row.id === profileId || row.reddit_user_id === profileId);
    if (rows.length !== 1) throw new AdportError('INVALID_INPUT', 'reddit: profile is not unambiguously associated with the selected account');
    return rows[0]!;
  }
  private profileMatch(value: unknown, profile: Row) { return value === profile.id || value === profile.reddit_user_id; }
  async groups(input: Page & { campaign_id?: string; ad_group_ids?: string[] }) {
    if (input.campaign_id) await this.owned(input.account_id, 'campaigns', input.campaign_id);
    const data = await this.page(`ad_accounts/${id.parse(input.account_id)}/ad_groups`, input, { campaign_id: input.campaign_id, id: input.ad_group_ids });
    data.items.forEach(row => rowSchema.parse(row));
    if (data.items.some(row => (row.ad_account_id !== undefined && row.ad_account_id !== input.account_id) || (input.campaign_id && row.campaign_id !== input.campaign_id))) throw new AdportError('PROVIDER_ERROR', 'reddit: ad-group collection account/parent mismatch');
    return data;
  }
  private async post(postId: string): Promise<Row> {
    if (!/^t3_[A-Za-z0-9]+$/.test(postId)) throw new AdportError('INVALID_INPUT', 'reddit: invalid post ID');
    let row: Row;
    try { row = await this.one(`structured_posts/${postId}`); }
    catch (error) { if (!(error instanceof AdportError) || record(error.details).http_status !== 404) throw error; row = await this.one(`posts/${postId}`); }
    if (row.id !== postId) throw new AdportError('PROVIDER_ERROR', 'reddit: post ID mismatch');
    return row;
  }
  private async ownedPost(account: string, postId: string) {
    const profiles = await this.profiles(account), row = await this.post(postId);
    if (!profiles.some(profile => this.profileMatch(row.profile_id, profile))) throw new AdportError('INVALID_INPUT', 'reddit: post author is not associated with this account');
    return row;
  }
  async assertPostOwned(account: string, postId: string) { await this.ownedPost(account, postId); }
  async assertProfileAvailable(account: string, profileId: string) { await this.profile(account, profileId); }
  async assertTargetingAvailable(account: string, value: unknown) { await this.verifyTargeting(account, targeting.parse(value)); }
  async posts(input: Page & { profile_id: string }) {
    const profile = await this.profile(input.account_id, input.profile_id), data = await this.page(`profiles/${profile.id}/structured_posts`, input);
    if (data.items.some(row => !rowSchema.safeParse(row).success || !this.profileMatch(row.profile_id, profile))) throw new AdportError('PROVIDER_ERROR', 'reddit: post collection profile mismatch');
    const creatives: Creative[] = data.items.map(row => { const content = record(row.creative), title = string(content.headline) ? content.headline : String(row.id); return { id: String(row.id), provider: 'reddit', account_id: input.account_id, name: title, type: String(content.type ?? 'POST'), headlines: [title], descriptions: string(content.body) ? [content.body] : [], landing_urls: landing(record(content.destination).url), media: postMedia(content, row), actions: [] }; });
    return { ...data, creatives };
  }
  private async asset(account: string, profileId: string, assetId: string) {
    const profile = await this.profile(account, profileId);
    const rows = await this.client.getPaged<Row>(`profiles/${profile.id}/creative_assets`, { 'page.size': 1000 }, 5000);
    const asset = rows.map(row => record(row.result)).find(row => row.id === assetId);
    if (!asset) throw new AdportError('INVALID_INPUT', 'reddit: asset is not in the associated profile’s first5000library entries');
    return { profile, asset };
  }
  private async readyAsset(account: string, profile: string, assetId: string, type: string) {
    const { asset } = await this.asset(account, profile, assetId);
    if (asset.type !== type || !['ACTIVE', 'DUPLICATE_ASSET'].includes(String(asset.status))) throw new AdportError('INVALID_INPUT', 'reddit: asset is not ready or has the wrong type');
    const url = safeUrl(record(asset.media).permanent_url) ?? safeUrl(record(asset.media).url);
    if (!url) throw new AdportError('INVALID_INPUT', 'reddit: asset has no usable HTTPS media URL');
    return { media: { type: 'URL', url } };
  }
  async assets(input: Page & { profile_id: string }) {
    const profile = await this.profile(input.account_id, input.profile_id), data = await this.page(`profiles/${profile.id}/creative_assets`, input);
    const items = data.items.map(row => rowSchema.parse(row.result));
    const creatives: Creative[] = items.map(row => {
      const url = safeUrl(record(row.media).permanent_url) ?? safeUrl(record(row.media).url);
      return { id: row.id, provider: 'reddit', account_id: input.account_id, name: String(row.name ?? row.text ?? row.call_to_action ?? row.id), type: `${row.type}_ASSET`, ...(string(row.status) ? { status: row.status } : {}), headlines: string(row.text) ? [row.text] : [], descriptions: [`Library readiness: ${row.status ?? 'unknown'}`, ...(string(row.call_to_action) ? [row.call_to_action] : [])], landing_urls: [], media: url && ['IMAGE', 'VIDEO'].includes(String(row.type)) ? [{ type: row.type === 'VIDEO' ? 'video' : 'image', url }] : [], actions: row.status === 'DELETED' ? [] : [{ label: 'Rename shared profile asset', tool: 'reddit_rename_asset', arguments: { account_id: input.account_id, profile_id: profile.id, creative_asset_id: row.id }, fields: [{ key: 'name', label: 'Asset name', type: 'text', value: String(row.name ?? '') }] }] };
    });
    return { ...data, items, creatives };
  }
  async ads(input: Page & { ad_ids?: string[]; ad_group_ids?: string[]; campaign_ids?: string[]; include_post_details: boolean }) {
    const data = await this.page(`ad_accounts/${id.parse(input.account_id)}/ads`, input, { id: input.ad_ids, ad_group_id: input.ad_group_ids, campaign_id: input.campaign_ids });
    data.items.forEach(row => rowSchema.parse(row));
    if (data.items.some(row => row.ad_account_id !== input.account_id)) throw new AdportError('PROVIDER_ERROR', 'reddit: ad collection returned another account');
    const posts = new Map<string, Row>(), warnings: Array<{ provider: string; message: string }> = [], profiles = input.include_post_details ? await this.profiles(input.account_id) : [];
    const postIds = [...new Set(data.items.map(row => row.post_id).filter(string))]; let cursor = 0;
    if (input.include_post_details) await Promise.all(Array.from({ length: Math.min(4, postIds.length) }, async () => { while (cursor < postIds.length) { const postId = postIds[cursor++]!; try { posts.set(postId, await this.post(postId)); } catch (error) { warnings.push({ provider: 'reddit', message: `Referenced post ${postId} unavailable: ${error instanceof Error ? error.message : 'provider read failed'}` }); } } }));
    const creatives: Creative[] = data.items.map(row => {
      const post = posts.get(String(row.post_id)), content = record(post?.creative), profile = profiles.find(profile => this.profileMatch(post?.profile_id, profile)), args = { account_id: input.account_id, ad_id: row.id };
      const status = String(row.configured_status ?? ''), body = string(content.body) ? content.body : string(post?.body) ? post.body : undefined;
      const title = string(content.headline) ? content.headline : string(post?.headline) ? post.headline : undefined;
      const actions: Creative['actions'] = ['ACTIVE', 'PAUSED'].includes(status) ? [creativeStatusAction('reddit_set_ad_status', args, status, ['ACTIVE', 'PAUSED']), { label: 'Edit ad name', tool: 'reddit_update_ad', arguments: args, fields: [{ key: 'name', label: 'Ad name', type: 'text', value: String(row.name ?? '') }] }] : [];
      if (profile && ['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'].includes(String(content.type)) && !['ARCHIVED', 'DELETED'].includes(status)) actions.push({ label: 'Stage a creative copy', tool: 'reddit_stage_post_copy', arguments: { ...args, source_post_id: row.post_id, profile_id: profile.id }, fields: [{ key: 'headline', label: 'Headline', type: 'text', value: title ?? '', max_length: 300 }, ...(body ? [{ key: 'body', label: 'Body', type: 'text' as const, value: body, max_length: 40_000 }] : [])] });
      return { id: String(row.id), provider: 'reddit', account_id: input.account_id, name: String(row.name ?? row.id), type: String(content.type ?? 'POST_AD'), status, ...(string(row.campaign_id) ? { campaign_id: row.campaign_id } : {}), ...(string(row.ad_group_id) ? { ad_group_id: row.ad_group_id } : {}), headlines: title ? [title] : [], descriptions: body ? [body] : [], landing_urls: landing(row.click_url).length ? landing(row.click_url) : landing(record(content.destination).url), media: postMedia(content, post), actions };
    });
    return { ...data, creatives, warnings };
  }
  async postJob(input: { account_id: string; job_id: string; resource_receipt: string }) {
    const bound = this.client.verifyResourceReceipt(input.resource_receipt, 'post_job', input.account_id, input.job_id), profile = await this.profile(input.account_id, bound.profile_id), row = await this.one(`structured_posts/jobs/${id.parse(input.job_id)}`);
    if (row.id !== input.job_id || !['PROCESSING', 'SUCCESS', 'CLIENT_ERROR', 'SERVER_ERROR', 'QUEUED'].includes(String(row.status))) throw new AdportError('PROVIDER_ERROR', 'reddit: post job receipt ID/status mismatch');
    if (row.status === 'SUCCESS') { const post = await this.post(String(row.post_id)); if (!this.profileMatch(post.profile_id, profile)) throw new AdportError('PROVIDER_ERROR', 'reddit: created post belongs to a different profile'); }
    return { job_id: row.id, status: row.status, post_id: row.post_id ?? null, ...(this.client.diagnostic(row.error_message) ? { error_message: this.client.diagnostic(row.error_message) } : {}) };
  }
  async uploadStatus(input: { account_id: string; upload_id: string; resource_receipt: string }) {
    const bound = this.client.verifyResourceReceipt(input.resource_receipt, 'asset_upload', input.account_id, input.upload_id); await this.profile(input.account_id, bound.profile_id);
    const row = await this.one(`creative_assets/uploads/${id.parse(input.upload_id)}`);
    if (row.id !== input.upload_id || !['PROCESSING_MEDIA', 'ACTIVE', 'INVALID_MEDIA'].includes(String(row.status))) throw new AdportError('PROVIDER_ERROR', 'reddit: asset upload receipt ID/status mismatch');
    if (row.status !== 'PROCESSING_MEDIA' && (!rowSchema.safeParse(row.result).success || !['IMAGE', 'VIDEO', 'HEADLINE', 'CTA'].includes(String(record(row.result).type)))) throw new AdportError('PROVIDER_ERROR', 'reddit: completed asset upload is missing a valid stored asset');
    return { upload_id: row.id, status: row.status, ...(row.result ? { result: row.result } : {}), ...(record(row.result).status === 'DUPLICATE_ASSET' ? { warning: 'Reddit reused an existing asset. This is not proof that the asset was newly created.' } : {}) };
  }
  async targetingOptions(input: Page & { dimension: string; query?: string; country?: string; postal_code?: string; cities_search?: string }) {
    id.parse(input.account_id); const dimensions = ['carriers', 'communities', 'communities_search', 'devices', 'geolocations', 'interests', 'languages', 'third_party_audiences'];
    if (!dimensions.includes(input.dimension)) throw new AdportError('INVALID_INPUT', 'reddit: unsupported targeting dimension');
    const path = `targeting/${input.dimension === 'communities_search' ? 'communities/search' : input.dimension}`;
    if (['geolocations', 'interests'].includes(input.dimension)) {
      if (input.cursor) throw new AdportError('INVALID_INPUT', 'reddit: this native dimension is not paginated; narrow its query instead');
      const data = await this.client.get<unknown>(path, input.dimension === 'geolocations' ? { country: input.country, postal_code: input.postal_code, cities_search: input.cities_search } : {});
      if (!Array.isArray(data.data) || data.data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new AdportError('PROVIDER_ERROR', 'reddit: malformed targeting choices');
      return { items: data.data.slice(0, input.page_size), truncated: data.data.length > input.page_size, ...(data.data.length > input.page_size ? { warning: 'Native endpoint has no pagination. Narrow the filter or increase page_size to inspect more choices.' } : {}) };
    }
    return this.page(path, input, { ...(input.dimension === 'communities_search' ? { query: input.query } : {}), ...(input.dimension === 'geolocations' ? { country: input.country, postal_code: input.postal_code, cities_search: input.cities_search } : {}) });
  }
  private async verifyTargeting(account: string, value: Row) {
    const references = [...(Array.isArray(value.custom_audience_ids) ? value.custom_audience_ids : []), ...(Array.isArray(value.excluded_custom_audience_ids) ? value.excluded_custom_audience_ids : [])];
    if (references.length) { const audiences = await this.client.getPaged<Row>(`ad_accounts/${account}/custom_audiences`, { 'page.size': 1000 }, 5000), known = new Set(audiences.map(row => row.id)); if (references.some(value => !known.has(value))) throw new AdportError('INVALID_INPUT', 'reddit: targeting audience is not available to this account'); }
  }
  private async mutation(account: string, path: string, method: 'POST' | 'PATCH', fields: Row, expected: Row): Promise<WriteResult> {
    const response = method === 'POST' ? await this.client.post<unknown>(path, { data: fields }) : await this.client.patch<unknown>(path, { data: fields }), row = record(response.data), ids = string(row.id) ? [row.id] : [];
    if (ids.length !== 1 || row.ad_account_id !== account || Object.entries(expected).some(([key, value]) => value !== undefined && (key === 'targeting' ? !targetingMatches(row[key], value) : ['start_time', 'end_time'].includes(key) && value !== null ? Date.parse(String(row[key])) !== Date.parse(String(value)) : row[key] !== value))) throw new AdportError('PROVIDER_ERROR', 'reddit: child receipt ID/account/status/money mismatch; reconcile before retrying', { resource_ids: ids });
    return { applied: true, resourceIds: ids };
  }
  private async assetUpload(account: string, profile: Row, payload: Row): Promise<WriteResult> {
    const data = await this.client.post<unknown>(`profiles/${profile.id}/creative_assets/uploads`, { data: [payload] });
    const rows = Array.isArray(data.data) ? data.data : [], ids = rows.map(row => record(row).id).filter(string);
    if (rows.length !== 1 || ids.length !== 1 || !id.safeParse(ids[0]).success) throw new AdportError('PROVIDER_ERROR', 'reddit: asset upload did not return one native handle; reconcile before retrying', { resource_ids: ids });
    return { applied: true, resourceIds: ids, details: { upload_id: ids[0], resource_receipt: this.client.resourceReceipt('asset_upload', account, String(profile.id), ids[0]!), next_tool: 'reddit_asset_upload_status' } };
  }
  private async postCreate(account: string, profile: Row, payload: Row): Promise<WriteResult> {
    const data = await this.client.post<unknown>(`profiles/${profile.id}/structured_posts/jobs`, { data: payload }), row = record(data.data), ids = string(row.id) ? [row.id] : [];
    if (ids.length !== 1 || !['PROCESSING', 'QUEUED', 'SUCCESS'].includes(String(row.status))) throw new AdportError('PROVIDER_ERROR', 'reddit: post job was not accepted; reconcile before retrying', { resource_ids: ids, job_status: row.status });
    return { applied: true, resourceIds: ids, details: { job_id: row.id, status: row.status, resource_receipt: this.client.resourceReceipt('post_job', account, String(profile.id), ids[0]!), next_tool: 'reddit_post_job' } };
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<RedditCreativePlan> {
    const account = id.parse(op.accountId), p = op.payload, expectedKind = /^reddit_(?:create_|stage_|upload_|import_)/.test(op.tool) ? 'create' : op.tool === 'reddit_delete_asset' ? 'remove' : 'update';
    if (op.provider !== 'reddit' || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'reddit: provider or write kind mismatch');
    const coercions: string[] = [], budgetDeltas: WritePreview['budgetDeltas'] = [], notes: string[] = [];
    let fields: Row = {}, current: Row = {}, expected: Row = {}, path = '', method: 'POST' | 'PATCH' = 'PATCH';
    const paused = (value: string) => { if (guard.forcePausedCreation && value !== 'PAUSED') coercions.push('configured_status coerced to PAUSED by policy (paused_creation)'); return guard.forcePausedCreation ? 'PAUSED' : value; };
    switch (op.tool) {
      case 'reddit_create_ad_group': {
        const input = createGroup.parse(p), parent = await this.owned(account, 'campaigns', input.campaign_id);
        if (parent.type === 'AUTOMATED' || parent.is_max === true) throw new AdportError('INVALID_INPUT', 'reddit: this tool creates MANUAL ad groups; Reddit Max requires its own authoring flow');
        await this.verifyTargeting(account, input.targeting);
        const cbo = parent.is_campaign_budget_optimization === true;
        if (cbo && (input.budget_micros !== undefined || input.bid_micros !== undefined || input.bid_type !== null || input.bid_strategy !== null)) throw new AdportError('INVALID_INPUT', 'reddit: CBO ad groups inherit budget/bidding; use null bid settings and omit child money');
        if (!cbo && (!input.budget_micros || !input.budget_type || !input.bid_type || !input.bid_strategy || (input.bid_strategy !== 'BIDLESS' && !input.bid_micros))) throw new AdportError('INVALID_INPUT', 'reddit: non-CBO ad groups require explicit budget, budget type, bid type and bidding settings');
        if (input.bid_strategy === 'BIDLESS' && input.bid_micros) throw new AdportError('INVALID_INPUT', 'reddit: BIDLESS requires no monetary bid');
        if (input.conversion_pixel_id) { const pixels = await this.client.getPaged<Row>(`ad_accounts/${account}/pixels`, {}, 1000); if (!pixels.some(row => row.id === input.conversion_pixel_id)) throw new AdportError('INVALID_INPUT', 'reddit: Pixel is not available to this account'); }
        if (input.app_id) { const apps = await this.client.getPaged<Row>(`ad_accounts/${account}/apps`, {}, 1000); if (!apps.some(row => row.id === input.app_id)) throw new AdportError('INVALID_INPUT', 'reddit: app is not available to this account'); }
        if (input.saved_audience_id) { const audience = await this.one(`saved_audiences/${input.saved_audience_id}`); if (audience.ad_account_id !== account) throw new AdportError('INVALID_INPUT', 'reddit: saved audience is not owned by this account'); }
        const { budget_micros, budget_type, bid_micros, ...native } = input;
        fields = { ...native, type: 'MANUAL', configured_status: paused(input.configured_status), targeting: { expand_targeting: false, ...input.targeting }, goal_value: cbo ? null : budget_micros, goal_type: cbo ? null : budget_type, bid_value: cbo || input.bid_strategy === 'BIDLESS' ? null : bid_micros };
        path = `ad_accounts/${account}/ad_groups`; method = 'POST'; expected = { campaign_id: input.campaign_id, type: 'MANUAL' }; break;
      }
      case 'reddit_update_ad_group': { const { ad_group_id, ...input } = updateGroup.parse(p); current = await this.owned(account, 'ad_groups', ad_group_id); path = `ad_groups/${ad_group_id}`; fields = input; expected = { id: ad_group_id, campaign_id: current.campaign_id }; break; }
      case 'reddit_update_targeting': {
        const nativeId = id.parse(p.ad_group_id), input = targeting.parse(p.targeting); current = await this.owned(account, 'ad_groups', nativeId);
        const previous = record(current.targeting);
        if (!targeting.safeParse(previous).success) throw new AdportError('INVALID_INPUT', 'reddit: current targeting contains unsupported fields; refusing a partial update that could reset them');
        const merged = { ...previous, ...input }; await this.verifyTargeting(account, merged);
        path = `ad_groups/${nativeId}`; fields = { targeting: merged }; expected = { id: nativeId, campaign_id: current.campaign_id }; break;
      }
      case 'reddit_set_ad_group_budget':
      case 'reddit_set_ad_group_bidding': {
        const nativeId = id.parse(p.ad_group_id); current = await this.owned(account, 'ad_groups', nativeId); const parent = await this.owned(account, 'campaigns', String(current.campaign_id));
        if (parent.is_campaign_budget_optimization === true) throw new AdportError('INVALID_INPUT', 'reddit: CBO budgets and bidding belong to the parent campaign');
        path = `ad_groups/${nativeId}`; expected = { id: nativeId, campaign_id: current.campaign_id };
        if (op.tool.endsWith('_budget')) { if (!['DAILY_SPEND', 'LIFETIME_SPEND'].includes(String(current.goal_type)) || !Number.isSafeInteger(current.goal_value)) throw new AdportError('INVALID_INPUT', 'reddit: current ad-group budget/type is unavailable'); fields = { goal_value: micros.positive().parse(p.budget_micros) }; }
        else {
          const strategy = p.bid_strategy !== undefined ? bidStrategy.parse(p.bid_strategy) : current.bid_strategy;
          if (current.bid_strategy !== 'BIDLESS' && (current.bid_value === undefined || current.bid_value === null)) throw new AdportError('INVALID_INPUT', 'reddit: current monetary bid is unavailable');
          if (strategy === 'BIDLESS' && (p.bid_micros !== undefined || Number(current.bid_value) > 0)) throw new AdportError('INVALID_INPUT', 'reddit: removing an existing monetary bid cap cannot be represented by the current policy; preserve a bounded bid');
          if (strategy !== 'BIDLESS' && !(p.bid_micros ?? current.bid_value)) throw new AdportError('INVALID_INPUT', 'reddit: the strategy requires a monetary bid');
          fields = { ...(p.bid_strategy !== undefined ? { bid_strategy: strategy } : {}), ...(p.bid_micros !== undefined ? { bid_value: micros.positive().parse(p.bid_micros) } : {}) };
        }
        break;
      }
      case 'reddit_create_ad': { const input = createAd.parse(p); await this.owned(account, 'ad_groups', input.ad_group_id); await this.ownedPost(account, input.post_id); fields = { ...input, type: 'UNSPECIFIED', configured_status: paused(input.configured_status) }; path = `ad_accounts/${account}/ads`; method = 'POST'; expected = { ad_group_id: input.ad_group_id, post_id: input.post_id }; break; }
      case 'reddit_update_ad': { const { ad_id, ...input } = updateAd.parse(p); current = await this.owned(account, 'ads', ad_id); if (input.post_id) { if (!['ACTIVE', 'PAUSED'].includes(String(current.configured_status))) throw new AdportError('INVALID_INPUT', 'reddit: creative replacement requires a readable ACTIVE/PAUSED configured status'); await this.ownedPost(account, input.post_id); expected.configured_status = current.configured_status; notes.push(`Post replacement preserves configured status ${current.configured_status} and can trigger review.`); } fields = input; path = `ads/${ad_id}`; expected = { ...expected, id: ad_id, ad_group_id: current.ad_group_id }; break; }
      case 'reddit_set_ad_status':
      case 'reddit_set_ad_group_status': { const entity = op.tool === 'reddit_set_ad_status' ? 'ads' : 'ad_groups', nativeId = id.parse(p[entity === 'ads' ? 'ad_id' : 'ad_group_id']); current = await this.owned(account, entity, nativeId); path = `${entity}/${nativeId}`; fields = { configured_status: z.enum(['ACTIVE', 'PAUSED']).parse(p.configured_status) }; expected = { id: nativeId }; break; }
      case 'reddit_archive_entity': { const entity = z.enum(['campaigns', 'ad_groups', 'ads']).parse(p.entity), nativeId = id.parse(p.resource_id); current = await this.owned(account, entity, nativeId); path = `${entity}/${nativeId}`; fields = { configured_status: 'ARCHIVED' }; expected = { id: nativeId }; break; }
      case 'reddit_upload_asset': {
        const input = uploadAsset.parse(p), profile = await this.profile(account, input.profile_id);
        if (!this.media.providerUrl) throw new AdportError('INVALID_INPUT', 'reddit: exact-file uploads require a hosted immutable media source. Local CLI can use reddit_import_asset_url for an existing HTTPS asset.');
        const options = { maxBytes: 100 * 1024 * 1024, contentTypes: input.type === 'IMAGE' ? ['image/png', 'image/jpeg', 'image/webp'] : ['video/mp4', 'video/quicktime'] };
        const file = await this.media.read(input, options), poster: MediaSource | undefined = input.type === 'VIDEO' ? { media_id: input.poster_media_id, expected_sha256: input.poster_expected_sha256! } : undefined;
        if (poster) await this.media.read(poster, { contentTypes: ['image/png', 'image/jpeg', 'image/webp'] });
        return { summary: `Import approved Reddit ${input.type} asset`, changes: [`Profile ${profile.id}; ${file.name}, ${file.bytes.byteLength}bytes, SHA-256 ${file.sha256}. Reddit downloads a temporary immutable project source after approval; no ad is created.`], coercions, budgetDeltas, execute: async () => {
          const source = await this.media.providerUrl!(input, options), payload: Row = { type: input.type, name: input.name, media: { type: 'URL', url: source.url } };
          if (source.sha256 !== file.sha256 || !safeUrl(source.url) || !Number.isFinite(Date.parse(source.expires_at)) || Date.parse(source.expires_at) <= Date.now()) throw new AdportError('INVALID_INPUT', 'reddit: invalid or changed immutable provider media source');
          if (poster) { const image = await this.media.providerUrl!(poster, { contentTypes: ['image/png', 'image/jpeg', 'image/webp'] }); if (image.sha256 !== poster.expected_sha256.toLowerCase() || !safeUrl(image.url) || !Number.isFinite(Date.parse(image.expires_at)) || Date.parse(image.expires_at) <= Date.now()) throw new AdportError('INVALID_INPUT', 'reddit: invalid poster source'); payload.poster = { type: 'URL', url: image.url }; }
          return this.assetUpload(account, profile, payload);
        } };
      }
      case 'reddit_import_asset_url': { const input = importAsset.parse(p), profile = await this.profile(account, input.profile_id), payload = { name: input.name, type: input.type, media: { type: 'URL', url: input.media_url }, ...(input.poster_url ? { poster: { type: 'URL', url: input.poster_url } } : {}) }; return { summary: 'Import a Reddit media URL', changes: [`Reddit fetches the supplied URL; approval binds this URL rather than remote bytes: ${JSON.stringify(payload)}`], coercions, budgetDeltas, execute: () => this.assetUpload(account, profile, payload) }; }
      case 'reddit_create_text_asset': { const { profile_id, ...input } = textAsset.parse(p), profile = await this.profile(account, profile_id); return { summary: `Create Reddit ${input.type} asset`, changes: [JSON.stringify(input)], coercions, budgetDeltas, execute: () => this.assetUpload(account, profile, input) }; }
      case 'reddit_rename_asset':
      case 'reddit_delete_asset': {
        const assetId = id.parse(p.creative_asset_id), { profile, asset } = await this.asset(account, id.parse(p.profile_id), assetId), remove = op.tool === 'reddit_delete_asset', name = remove ? undefined : z.string().trim().min(1).parse(p.name);
        return { summary: `${remove ? 'Delete' : 'Rename'} shared Reddit profile asset ${assetId}`, changes: [`Profile ${profile.id}; current ${asset.name ?? asset.id}. ${remove ? 'Permanently delete from the shared profile library.' : `Rename to ${name}.`}`], coercions, budgetDeltas, execute: async () => { if (remove) { const result = await this.client.delete(`creative_assets/${assetId}`); if (result.data !== null && (!result.data || typeof result.data !== 'object' || Object.keys(result.data).length)) throw new AdportError('PROVIDER_ERROR', 'reddit: unexpected asset deletion receipt; reconcile before retrying', { resource_ids: [assetId] }); return { applied: true, resourceIds: [assetId] }; } const result = await this.client.patch<Row>(`creative_assets/${assetId}`, { data: { name } }); if (result.data.id !== assetId || result.data.name !== name) throw new AdportError('PROVIDER_ERROR', 'reddit: asset rename receipt mismatch', { resource_ids: [assetId] }); return { applied: true, resourceIds: [assetId] }; } };
      }
      case 'reddit_create_post': {
        const input = createPost.parse(p), profile = await this.profile(account, input.profile_id), creative: Row = { type: input.type, headline: input.headline, ...(input.body !== undefined ? { body: input.body, text_format: 'PLAIN_TEXT' } : {}) };
        if (input.destination_url) creative.destination = { type: 'URL', url: input.destination_url, ...(input.call_to_action ? { call_to_action: input.call_to_action } : {}) };
        if (input.type === 'IMAGE') creative.image = await this.readyAsset(account, String(profile.id), input.image_asset_id!, 'IMAGE');
        if (input.type === 'VIDEO') creative.video = await this.readyAsset(account, String(profile.id), input.video_asset_id!, 'VIDEO');
        if (input.thumbnail_asset_id) creative.thumbnail = await this.readyAsset(account, String(profile.id), input.thumbnail_asset_id, 'IMAGE');
        if (input.type === 'CAROUSEL') creative.carousel = await Promise.all(input.carousel!.map(async card => ({ image: await this.readyAsset(account, String(profile.id), card.image_asset_id, 'IMAGE'), destination: { type: 'URL', url: card.destination_url, ...(card.call_to_action ? { call_to_action: card.call_to_action } : {}) }, ...(card.caption !== undefined ? { caption: card.caption } : {}) })));
        const payload = { allow_comments: input.allow_comments, creative }; return { summary: 'Create a Reddit structured-post job', changes: [`Create a new post under profile ${profile.id}; ad attachment requires a separate approval. ${JSON.stringify(payload)}`], coercions, budgetDeltas, execute: () => this.postCreate(account, profile, payload) };
      }
      case 'reddit_stage_post_copy': {
        const input = stageCopy.parse(p), ad = await this.owned(account, 'ads', input.ad_id), profile = await this.profile(account, input.profile_id);
        if (ad.post_id !== input.source_post_id) throw new AdportError('INVALID_INPUT', 'reddit: source post no longer matches the selected ad');
        const post = await this.post(input.source_post_id);
        if (!this.profileMatch(post.profile_id, profile)) throw new AdportError('INVALID_INPUT', 'reddit: source post belongs to a different associated profile');
        const creative = writableCopy(record(post.creative));
        if (input.headline !== undefined) creative.headline = input.headline;
        if (input.body !== undefined) { creative.body = input.body; creative.text_format = 'PLAIN_TEXT'; }
        const payload = { allow_comments: post.allow_comments === true, creative };
        return { summary: `Stage a new creative copy for Reddit ad ${input.ad_id}`, changes: [`Create a new post under profile ${profile.id}. The original ${input.source_post_id} and ad reference remain unchanged until a separate reddit_update_ad approval. ${JSON.stringify(payload)}`], coercions, budgetDeltas, execute: () => this.postCreate(account, profile, payload) };
      }
      default: throw new AdportError('INVALID_INPUT', `reddit: unsupported creative write ${op.tool}`);
    }
    const effective = { ...current, ...fields };
    if (effective.end_time && (!effective.start_time || Date.parse(String(effective.end_time)) <= Date.parse(String(effective.start_time)))) throw new AdportError('INVALID_INPUT', 'reddit: end_time requires a preceding start_time');
    for (const key of ['goal_value', 'bid_value']) if (fields[key] !== undefined && fields[key] !== null) budgetDeltas.push({ target: `${path} ${key}`, ...(current[key] !== undefined && current[key] !== null ? { fromMicros: micros.parse(current[key]) } : {}), toMicros: micros.parse(fields[key]) });
    for (const key of ['name', 'configured_status', 'goal_value', 'bid_value', 'bid_strategy', 'post_id', 'start_time', 'end_time', 'targeting']) if (fields[key] !== undefined) expected[key] = fields[key];
    return { summary: `Reddit ${op.tool.replace('reddit_', '').replaceAll('_', ' ')}`, changes: [...notes, `${method} ${path}: ${JSON.stringify({ data: fields })}`], coercions, budgetDeltas, execute: () => this.mutation(account, path, method, fields, expected) };
  }
}

function postMedia(creative: Row, legacy?: Row): Creative['media'] {
  const result: Creative['media'] = [];
  for (const [key, type] of [['image', 'image'], ['video', 'video'], ['thumbnail', 'image']] as const) { const asset = record(creative[key]), media = record(asset.media), url = safeUrl(media.url) ?? safeUrl(media.permanent_url); if (url) result.push({ type, url }); }
  if (Array.isArray(creative.carousel)) for (const card of creative.carousel) { const url = safeUrl(record(record(record(card).image).media).url); if (url) result.push({ type: 'image', url }); }
  if (!result.length && Array.isArray(legacy?.content)) for (const card of legacy.content) { const url = safeUrl(record(card).media_url); if (url && ['IMAGE', 'VIDEO', 'CAROUSEL'].includes(String(legacy?.type))) result.push({ type: legacy?.type === 'VIDEO' ? 'video' : 'image', url }); }
  return result.slice(0, 40);
}
function writableCopy(source: Row): Row {
  if (!['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'].includes(String(source.type))) throw new AdportError('INVALID_INPUT', 'reddit: this post format requires a dedicated authoring flow');
  const allowed = ['type', 'headline', 'body', 'text_format', 'destination', 'image', 'video', 'thumbnail', 'carousel', 'supplementary_text', 'event', 'enhancements'];
  if (Object.keys(source).some(key => !allowed.includes(key))) throw new AdportError('INVALID_INPUT', 'reddit: source creative contains unsupported fields; refusing a copy that could omit them');
  const result = structuredClone(source);
  const cleanMedia = (value: unknown) => { const asset = record(value), media = record(asset.media), url = safeUrl(media.url) ?? safeUrl(media.permanent_url); if (!url) throw new AdportError('INVALID_INPUT', 'reddit: source creative media has no safe HTTPS URL'); return { ...Object.fromEntries(Object.entries(asset).filter(([key]) => ['crop', 'name', 'gifify'].includes(key))), media: { type: 'URL', url } }; };
  for (const key of ['image', 'video', 'thumbnail']) if (result[key] !== undefined && result[key] !== null) result[key] = cleanMedia(result[key]);
  if (Array.isArray(result.carousel)) result.carousel = result.carousel.map(value => { const card = record(value); return { ...card, image: cleanMedia(card.image) }; });
  return result;
}
function targetingMatches(actual: unknown, expected: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  if (Array.isArray(expected)) return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
  if (expected && typeof expected === 'object') return actual !== null && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => targetingMatches((actual as Row)[key], value));
  return actual === expected;
}
