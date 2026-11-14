import { AdportError, type Creative, type MediaResolver, type MediaSource, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { SpotifyAdsClient } from './client.js';
import { assetResponse, createAd, createAsset, createGroup, draftMutation, draftResponse, publishDraft, updateAd, updateCampaign, updateGroup, uploadAsset } from './creative-schemas.js';
import { budgetSchema, spotifyId } from './schemas.js';

type Row = Record<string, unknown>;
type Entity = 'campaigns' | 'ad_sets' | 'ads';
interface Page { account_id: string; limit: number; offset: number }
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<string[]> }
const object = z.record(z.string(), z.unknown());
const paging = z.looseObject({ offset: z.number().int().nonnegative(), total_results: z.number().int().nonnegative() });
const keys = { campaigns: 'campaign_drafts', ad_sets: 'ad_set_drafts', ads: 'ad_drafts' } as const;

/** Spotify's live v3 OpenAPI is the wire authority, including native draft versions. */
export class SpotifyCreativeService {
  constructor(private readonly client: SpotifyAdsClient, private readonly media: MediaResolver) {}
  private base(account: string) { return `ad_accounts/${spotifyId.parse(account)}`; }

  async page(input: Page, path: string, key: string, params: Row = {}): Promise<Row & { truncated: boolean; next_offset?: number }> {
    const data = await this.client.get(`${this.base(input.account_id)}/${path}`, z.looseObject({ paging }), query({ limit: input.limit, offset: input.offset, ...params }));
    if (data.paging.offset !== input.offset) throw new AdportError('PROVIDER_ERROR', 'spotify: pagination offset mismatch');
    const rows = z.array(draftResponse).parse(data[key]);
    for (const row of rows) this.checkAccount(input.account_id, row);
    const next = input.offset + rows.length, truncated = next < data.paging.total_results;
    if (truncated && !rows.length) throw new AdportError('PROVIDER_ERROR', 'spotify: pagination stalled');
    return { ...data, truncated, ...(truncated ? { next_offset: next } : {}) };
  }

  async drafts(input: Page & { entity: Entity; campaign_ids?: string[]; ad_set_ids?: string[] }) {
    return this.page(input, `drafts/${input.entity}`, keys[input.entity], { campaign_ids: input.campaign_ids, ad_set_ids: input.ad_set_ids });
  }

  async get(account: string, entity: Entity, id: string, draft = true) {
    const row = await this.getOwned(account, entity, id, draft);
    if (entity === 'ad_sets') await this.get(account, 'campaigns', spotifyId.parse(row.campaign_id), draft);
    else if (entity === 'ads') await this.get(account, 'ad_sets', spotifyId.parse(row.ad_set_id), draft);
    return row;
  }

  private async getOwned(account: string, entity: Entity, id: string, draft = true) {
    const row = await this.client.get(`${this.base(account)}/${draft ? 'drafts/' : ''}${entity}/${spotifyId.parse(id)}`, draftResponse);
    if (row.id !== id) throw new AdportError('PROVIDER_ERROR', 'spotify: response ID mismatch');
    this.checkAccount(account, row);
    if (entity === 'campaigns') {
      if (draft && row.ad_account_id !== account) throw new AdportError('PROVIDER_ERROR', 'spotify: campaign account mismatch');
      if (!draft && row.ad_account_id == null) await this.verifyPublishedCampaign(account, id);
    }
    return row;
  }

  private checkAccount(account: string, row: Row) {
    if (row.ad_account_id != null && row.ad_account_id !== account) throw new AdportError('PROVIDER_ERROR', 'spotify: resource belongs to another account');
  }

  private async verifyPublishedCampaign(account: string, id: string) {
    // Live campaign GET/list responses can have ad_account_id:null. Prove
    // membership in the selected account's paged collection instead.
    for (let page = 0, offset = 0; page < 1000; page++) {
      const data = await this.page({ account_id: account, limit: 50, offset }, 'campaigns', 'campaigns', { sort_field: 'ID', sort_direction: 'ASC' });
      if ((data.campaigns as Row[]).some(campaign => campaign.id === id)) return;
      if (!data.truncated) break;
      offset = data.next_offset!;
    }
    throw new AdportError('INVALID_INPUT', 'spotify: campaign is not present in the selected account’s published campaign list');
  }

  async assets(input: Page & { asset_types?: string[]; asset_statuses?: string[]; name?: string }) {
    const data = await this.client.get(`${this.base(input.account_id)}/assets`, z.looseObject({ paging, assets: z.array(assetResponse) }), query({ limit: input.limit, offset: input.offset, asset_types: input.asset_types, asset_statuses: input.asset_statuses, name: input.name }));
    if (data.paging.offset !== input.offset) throw new AdportError('PROVIDER_ERROR', 'spotify: asset pagination offset mismatch');
    for (const asset of data.assets) this.checkAccount(input.account_id, asset);
    const next = input.offset + data.assets.length, truncated = next < data.paging.total_results;
    if (truncated && !data.assets.length) throw new AdportError('PROVIDER_ERROR', 'spotify: asset pagination stalled');
    const creatives: Creative[] = data.assets.map(asset => ({ id: asset.id, provider: 'spotify', account_id: input.account_id, name: asset.name, type: asset.asset_type, status: asset.status, headlines: [], descriptions: [], landing_urls: [], media: mediaFor(asset), actions: [] }));
    return { ...data, creatives, truncated, ...(truncated ? { next_offset: next } : {}) };
  }

  async asset(account: string, id: string) {
    const asset = await this.client.get(`${this.base(account)}/assets/${spotifyId.parse(id)}`, assetResponse);
    if (asset.id !== id) throw new AdportError('PROVIDER_ERROR', 'spotify: asset response ID mismatch');
    this.checkAccount(account, asset);
    return asset;
  }

  async ads(input: Page & { draft: boolean; ad_set_ids?: string[] }) {
    const data = await this.page(input, `${input.draft ? 'drafts/' : ''}ads`, input.draft ? 'ad_drafts' : 'ads', { ad_set_ids: input.ad_set_ids });
    const rows = data[input.draft ? 'ad_drafts' : 'ads'] as Row[];
    const cache = new Map<string, Awaited<ReturnType<typeof this.asset>>>();
    const creatives: Creative[] = [];
    for (const ad of rows) {
      const assets = record(ad.assets), media: Creative['media'] = [];
      for (const id of new Set(Object.values(assets).filter((value): value is string => typeof value === 'string' && spotifyId.safeParse(value).success))) {
        if (!cache.has(id)) cache.set(id, await this.asset(input.account_id, id));
        media.push(...mediaFor(cache.get(id)!));
      }
      const args = { account_id: input.account_id, draft_id: ad.id };
      creatives.push({ id: String(ad.id), provider: 'spotify', account_id: input.account_id, name: String(ad.name ?? ad.id), type: input.draft ? 'DRAFT_AD' : 'AD', ...(typeof ad.status === 'string' ? { status: ad.status } : {}), ...(typeof ad.ad_set_id === 'string' ? { ad_group_id: ad.ad_set_id } : {}),
        headlines: typeof ad.advertiser_name === 'string' ? [ad.advertiser_name] : [], descriptions: typeof ad.tagline === 'string' ? [ad.tagline] : [], landing_urls: safeUrl(record(ad.call_to_action).clickthrough_url), media,
        actions: input.draft ? [{ label: 'Edit draft copy', tool: 'spotify_update_draft_ad', arguments: args, fields: [{ key: 'name', label: 'Ad name', type: 'text', value: String(ad.name ?? ''), max_length: 200 }, ...(typeof ad.tagline === 'string' ? [{ key: 'tagline', label: 'Tagline', type: 'text' as const, value: ad.tagline, max_length: 200 }] : [])] }] : [{ label: 'Stage a draft for editing', tool: 'spotify_create_draft_from_published', arguments: { account_id: input.account_id, entity: 'ads', draft_id: ad.id }, fields: [] }],
      });
    }
    return { ...data, creatives };
  }

  async read(account: string, path: string, params: Row = {}) { return this.client.get(`${this.base(account)}/${path}`, object, query(params)); }
  async targeting(input: { account_id: string; kind: string } & Row) {
    const { account_id, kind, ...params } = input;
    return this.client.get(`targets/${kind}`, object, query({ ...params, ...(kind === 'languages' ? { ad_account_id: account_id } : {}) }));
  }
  async categories(q?: string) { return this.client.get('ad_categories', object, query({ q })); }
  async estimate(kind: 'audience' | 'bid', input: { account_id: string } & Row) {
    const { account_id, ...body } = input;
    return this.client.mutate(`estimates/${kind}`, 'POST', { ...body, ...(kind === 'audience' ? { ad_account_id: account_id } : {}) }, object);
  }
  async validate(account: string, id: string, version: number) {
    const campaign = await this.get(account, 'campaigns', id);
    this.version(campaign, version);
    return this.client.mutate(`${this.base(account)}/drafts/campaigns/${id}`, 'POST', { action: 'VALIDATE', draft_hierarchy_version: version }, object);
  }
  private version(campaign: Row, version: number) {
    if (campaign.draft_hierarchy_version !== version) throw new AdportError('PENDING_MISMATCH', 'spotify: draft hierarchy changed. Read its current version and prepare a new preview.');
  }
  private async allDrafts(account: string, entity: Entity, campaign: string) {
    const rows: Row[] = [], seen = new Set<string>();
    for (let page = 0, offset = 0; page < 1000; page++) {
      const data = await this.drafts({ account_id: account, entity, campaign_ids: [campaign], limit: 50, offset });
      const nextRows = data[keys[entity]] as Row[];
      for (const row of nextRows) { if (seen.has(String(row.id))) throw new AdportError('PROVIDER_ERROR', 'spotify: repeated draft resource'); seen.add(String(row.id)); rows.push(row); }
      if (!data.truncated) return rows;
      offset = data.next_offset!;
    }
    throw new AdportError('PROVIDER_ERROR', 'spotify: draft hierarchy pagination did not terminate');
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const base = this.base(op.accountId), coercions: string[] = [], budgetDeltas: WritePreview['budgetDeltas'] = [];
    let path: string, body: Row, method: 'POST' | 'PATCH' = 'PATCH', expectedId: string | undefined;
    const payload = op.payload;
    switch (op.tool) {
      case 'spotify_create_draft_ad_set': {
        const input = createGroup.parse(payload);
        await this.get(op.accountId, 'campaigns', input.campaign_id);
        body = input; path = `${base}/drafts/ad_sets`; method = 'POST';
        checkGroup(body);
        monetaryDeltas(body, {}, `draft ad set ${input.name}`, budgetDeltas);
        break;
      }
      case 'spotify_create_draft_ad': {
        const input = createAd.parse(payload);
        await this.get(op.accountId, 'ad_sets', input.ad_set_id);
        await this.verifyAssets(op.accountId, input.assets);
        body = input; path = `${base}/drafts/ads`; method = 'POST'; break;
      }
      case 'spotify_update_draft_campaign':
      case 'spotify_update_draft_ad_set':
      case 'spotify_update_draft_ad': {
        const entity = op.tool === 'spotify_update_draft_campaign' ? 'campaigns' : op.tool === 'spotify_update_draft_ad_set' ? 'ad_sets' : 'ads';
        const input = (entity === 'campaigns' ? updateCampaign : entity === 'ad_sets' ? updateGroup : updateAd).parse(payload);
        const { draft_id, ...fields } = input;
        const current = await this.get(op.accountId, entity, draft_id);
        body = { ...fields }; expectedId = draft_id;
        if (body.targets !== undefined) body.targets = { ...record(current.targets), ...record(body.targets) };
        for (const key of ['assets', 'call_to_action']) if (body[key] !== undefined) {
          const writable = key === 'assets' ? ['asset_id', 'logo_asset_id', 'companion_asset_id', 'canvas_asset_id'] : ['key', 'language', 'clickthrough_url'];
          body[key] = { ...Object.fromEntries(Object.entries(record(current[key])).filter(([field, value]) => writable.includes(field) && value !== null)), ...record(body[key]) };
        }
        if (entity === 'ad_sets') { checkGroup({ ...current, ...body }); monetaryDeltas(body, current, `draft ad set ${draft_id}`, budgetDeltas); }
        if (entity === 'ads') await this.verifyAssets(op.accountId, body.assets);
        path = `${base}/drafts/${entity}/${draft_id}`; break;
      }
      case 'spotify_create_draft_from_published': {
        const input = draftMutation.parse(payload);
        await this.get(op.accountId, input.entity, input.draft_id, false);
        try {
          await this.get(op.accountId, input.entity, input.draft_id);
          throw new AdportError('INVALID_INPUT', 'spotify: a draft already exists. Read and edit it instead of overwriting pending changes.');
        } catch (error) { if (!isNotFound(error)) throw error; }
        path = `${base}/${input.entity}/${input.draft_id}/drafts`; method = 'POST'; expectedId = input.draft_id; body = {}; break;
      }
      case 'spotify_delete_draft': {
        const input = draftMutation.parse(payload);
        // Spotify can retain orphan ad drafts after deleting a parent campaign.
        // The account-scoped resource read still proves ownership for cleanup.
        const current = await this.getOwned(op.accountId, input.entity, input.draft_id);
        if (input.entity === 'campaigns') {
          const groups = await this.allDrafts(op.accountId, 'ad_sets', input.draft_id);
          for (const group of groups) await this.ensureNoAdDrafts(op.accountId, String(group.id));
        } else if (input.entity === 'ad_sets') await this.ensureNoAdDrafts(op.accountId, input.draft_id);
        return { summary: `Delete Spotify draft ${input.entity}/${input.draft_id}`, changes: [`- ${current.name ?? current.id}; draft children may also be deleted. Published entities remain unchanged.`], coercions, budgetDeltas, execute: async () => { await this.client.mutate(`${base}/drafts/${input.entity}/${input.draft_id}`, 'DELETE', undefined, z.undefined()); return [input.draft_id]; } };
      }
      case 'spotify_delete_draft_ads':
      case 'spotify_delete_draft_ad_sets': {
        const ads = op.tool === 'spotify_delete_draft_ads', entity = ads ? 'ads' : 'ad_sets';
        const input = z.object({ draft_ids: z.array(spotifyId).min(1).max(ads ? 100 : 40).refine(ids => new Set(ids).size === ids.length, 'IDs must be unique') }).parse(payload);
        for (const id of input.draft_ids) { await this.getOwned(op.accountId, entity, id); if (!ads) await this.ensureNoAdDrafts(op.accountId, id); }
        return { summary: `Delete ${input.draft_ids.length} Spotify ${entity} drafts`, changes: input.draft_ids.map(id => `- draft ${id}${ads ? '' : ' and child ad drafts'}; published entities remain unchanged`), coercions, budgetDeltas, execute: async () => { await this.client.mutate(`${base}/drafts/${entity}`, 'DELETE', undefined, z.undefined(), query({ [ads ? 'ad_draft_ids' : 'ad_set_draft_ids']: input.draft_ids })); return input.draft_ids; } };
      }
      case 'spotify_publish_draft': return this.publish(op, guard);
      case 'spotify_create_asset': {
        const input = createAsset.parse(payload);
        return { summary: `Create Spotify ${input.asset_type} asset metadata`, changes: [`+ ${JSON.stringify(input)}; file upload is a separate approved operation`], coercions, budgetDeltas, execute: async () => { const asset = await this.client.mutate(`${base}/assets`, 'POST', input, assetResponse); this.checkAccount(op.accountId, asset); if (asset.asset_type !== input.asset_type) throw new AdportError('PROVIDER_ERROR', 'spotify: created asset type mismatch; inspect before retrying'); return [asset.id]; } };
      }
      case 'spotify_rename_asset': {
        const input = z.object({ asset_id: spotifyId, name: z.string().trim().min(2).max(120) }).parse(payload);
        const current = await this.asset(op.accountId, input.asset_id);
        return { summary: 'Rename Spotify asset', changes: [`~ ${current.id} name: ${current.name} → ${input.name}`], coercions, budgetDeltas, execute: async () => { const result = await this.client.mutate(`${base}/assets/${current.id}`, 'PATCH', { asset_type: current.asset_type, name: input.name }, assetResponse); if (result.id !== current.id || result.name !== input.name) throw new AdportError('PROVIDER_ERROR', 'spotify: asset update response mismatch'); return [current.id]; } };
      }
      case 'spotify_upload_asset': return this.upload(op);
      default: throw new AdportError('INVALID_INPUT', `spotify: unsupported write ${op.tool}`);
    }
    const parent = body.campaign_id ?? body.ad_set_id;
    return { summary: `Spotify ${op.tool.replace(/^spotify_/, '').replaceAll('_', ' ')}`, changes: [`${method} /${path} ${JSON.stringify(body)}`], coercions, budgetDeltas, execute: async () => {
      const result = await this.client.mutate(path, method, op.tool === 'spotify_create_draft_from_published' ? undefined : body, draftResponse);
      this.checkAccount(op.accountId, result);
      if ((expectedId && result.id !== expectedId) || (parent && parent !== (result.campaign_id ?? result.ad_set_id))) throw new AdportError('PROVIDER_ERROR', 'spotify: draft mutation response mismatch; inspect before retrying');
      return [result.id];
    } };
  }

  private async verifyAssets(account: string, assets: unknown) {
    for (const value of Object.values(record(assets))) await this.asset(account, spotifyId.parse(value));
  }

  private async ensureNoAdDrafts(account: string, group: string) {
    const data = await this.drafts({ account_id: account, entity: 'ads', ad_set_ids: [group], limit: 1, offset: 0 });
    if ((data.ad_drafts as Row[]).length || data.truncated) throw new AdportError('INVALID_INPUT', 'spotify: delete draft ads before deleting their parent. Spotify can otherwise leave undeletable orphan ad drafts.');
  }

  private async publish(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    if (guard.forcePausedCreation) throw new AdportError('POLICY_VIOLATION', 'spotify: publication is blocked by paused_creation. The live PUBLISH endpoint activates even a PAUSED draft; Spotify cannot guarantee paused publication. Keep this hierarchy as a draft.');
    const input = publishDraft.parse(op.payload), account = op.accountId;
    if (!input.acknowledge_active_publication) throw new AdportError('INVALID_INPUT', 'spotify: publishing activates the campaign. Explicit acknowledge_active_publication=true is required.');
    const campaign = await this.get(account, 'campaigns', input.draft_campaign_id);
    this.version(campaign, input.draft_hierarchy_version);
    const groups = await this.allDrafts(account, 'ad_sets', campaign.id);
    const budgetDeltas: WritePreview['budgetDeltas'] = [];
    for (const group of groups) {
      if (group.campaign_id !== campaign.id) throw new AdportError('PROVIDER_ERROR', 'spotify: draft ad set belongs to another campaign');
      let current: Row = {};
      try { current = await this.get(account, 'ad_sets', String(group.id), false); } catch (error) { if (!isNotFound(error)) throw error; }
      monetaryDeltas(group, current, `publish ad set ${group.id}`, budgetDeltas);
    }
    return { summary: `Publish Spotify campaign ${campaign.name ?? campaign.id} as ACTIVE`, changes: [`PUBLISH hierarchy version ${input.draft_hierarchy_version}; ${groups.length} draft ad sets. Spotify changes campaign status ${campaign.status} → ACTIVE, regardless of the draft's paused state.`], coercions: [], budgetDeltas, execute: async () => {
      const validation = await this.validate(account, campaign.id, input.draft_hierarchy_version);
      assertValidation(validation);
      const result = await this.client.mutate(`${this.base(account)}/drafts/campaigns/${campaign.id}`, 'POST', { action: 'PUBLISH', draft_hierarchy_version: input.draft_hierarchy_version }, object);
      assertValidation(result);
      const published = record(result.campaign);
      if (published.id !== campaign.id || (published.ad_account_id != null && published.ad_account_id !== account) || published.status !== 'ACTIVE') throw new AdportError('PROVIDER_ERROR', 'spotify: publish receipt does not confirm the expected campaign/account/status. Inspect before retrying.', { resource_ids: spotifyId.safeParse(published.id).success ? [published.id] : [], observed_status: published.status });
      if (published.ad_account_id == null) await this.verifyPublishedCampaign(account, campaign.id);
      return [campaign.id];
    } };
  }

  private async upload(op: WriteOperation): Promise<Plan> {
    const input = uploadAsset.parse(op.payload), current = await this.asset(op.accountId, input.asset_id);
    if (current.status !== 'WAITING_UPLOAD') throw new AdportError('INVALID_INPUT', 'spotify: upload only to a new WAITING_UPLOAD asset. Create a separate asset instead of replacing media used by ads.');
    const types = { IMAGE: ['image/png', 'image/jpeg'], AUDIO: ['audio/mpeg', 'audio/wav', 'audio/ogg'], VIDEO: ['video/mp4', 'video/quicktime'] };
    const file = await this.media.read(input as MediaSource, { maxBytes: 100 * 1024 * 1024, contentTypes: types[current.asset_type] });
    const path = `${this.base(op.accountId)}/assets/${current.id}`;
    return { summary: `Upload Spotify ${current.asset_type} asset ${current.name}`, changes: [`+ ${file.name}; ${file.bytes.byteLength} bytes; SHA-256 ${file.sha256}; existing ads are unchanged`], coercions: [], budgetDeltas: [], execute: async () => {
      let result: z.infer<typeof assetResponse>;
      if (file.bytes.byteLength <= 20_000_000) {
        result = await this.client.upload(`${path}/upload`, form(file.bytes, file.name, file.contentType, { asset_type: current.asset_type }), assetResponse);
      } else {
        const session = await this.client.mutate(`${path}/chunked_upload/start`, 'POST', undefined, z.object({ upload_session_id: spotifyId, max_chunk_size_mb: z.number().int().positive().max(100) }));
        const size = session.max_chunk_size_mb * 1_000_000, sections = Math.ceil(file.bytes.byteLength / size);
        if (sections > 1000) throw new AdportError('PROVIDER_ERROR', 'spotify: upload requires too many chunks');
        for (let index = 0; index < sections; index++) {
          const reply = await this.client.upload(`${path}/chunked_upload/transfer`, form(file.bytes.slice(index * size, (index + 1) * size), file.name, file.contentType, { asset_type: current.asset_type, upload_session_id: session.upload_session_id, upload_section: String(index + 1) }), z.object({ success: z.boolean() }));
          if (!reply.success) throw new AdportError('PROVIDER_ERROR', `spotify: upload section ${index + 1} failed. Inspect the asset before retrying.`);
        }
        result = await this.client.mutate(`${path}/chunked_upload/complete`, 'POST', { asset_type: current.asset_type, upload_session_id: session.upload_session_id, number_of_sections: sections }, assetResponse);
      }
      if (result.id !== current.id || result.asset_type !== current.asset_type || result.status === 'ERROR') throw new AdportError('PROVIDER_ERROR', 'spotify: uploaded asset response mismatch/error; inspect before retrying');
      return [current.id];
    } };
  }
}

function record(value: unknown): Row { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function query(input: Row) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(input)) if (value !== undefined) { if (Array.isArray(value)) for (const item of value) params.append(key, String(item)); else params.set(key, String(value)); } return params; }
function safeUrl(value: unknown): string[] { if (typeof value !== 'string') return []; try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? [value] : []; } catch { return []; } }
function mediaFor(asset: z.infer<typeof assetResponse>): Creative['media'] { return safeUrl(asset.url).filter(url => url.startsWith('https:')).map(url => ({ type: asset.asset_type === 'IMAGE' ? 'image' : asset.asset_type === 'VIDEO' ? 'video' : 'audio', url })); }
function isNotFound(error: unknown) { return error instanceof AdportError && record(error.details).http_status === 404; }
function form(bytes: Uint8Array<ArrayBuffer>, name: string, type: string, fields: Record<string, string>) { const data = new FormData(); for (const [key, value] of Object.entries(fields)) data.set(key, value); data.set('media', new Blob([bytes], { type }), name); return data; }
function checkGroup(row: Row) {
  const target = record(row.targets), budget = record(row.budget);
  if (row.targets !== undefined && (!Array.isArray(target.placements) || !target.placements.length)) throw new AdportError('INVALID_INPUT', 'spotify: supplied targeting must include placements');
  if (budget.type === 'LIFETIME' && !row.end_time) throw new AdportError('INVALID_INPUT', 'spotify: lifetime budget requires end_time');
  if (row.start_time && row.end_time && String(row.end_time) <= String(row.start_time)) throw new AdportError('INVALID_INPUT', 'spotify: end_time must be after start_time');
}
function monetaryDeltas(next: Row, current: Row, target: string, deltas: WritePreview['budgetDeltas']) {
  if (next.budget !== undefined) {
    const budget = budgetSchema.parse(next.budget), old = current.budget === undefined ? undefined : budgetSchema.parse(current.budget);
    if (old && old.type !== budget.type) throw new AdportError('INVALID_INPUT', 'spotify: budget type changes require a separate ad set');
    deltas.push({ target: `${target} ${budget.type} budget`, ...(old ? { fromMicros: old.micro_amount } : {}), toMicros: budget.micro_amount });
  }
  if (next.bid_micro_amount !== undefined) {
    const amount = z.number().int().nonnegative().safe().parse(next.bid_micro_amount);
    const old = current.bid_micro_amount === undefined ? undefined : z.number().int().nonnegative().safe().parse(current.bid_micro_amount);
    deltas.push({ target: `${target} bid`, ...(old !== undefined ? { fromMicros: old } : {}), toMicros: amount });
  }
}
function assertValidation(result: Row) {
  if (result.validation_errors !== undefined && result.validation_errors !== null && !Array.isArray(result.validation_errors)) throw new AdportError('PROVIDER_ERROR', 'spotify: malformed draft validation result');
  if (Array.isArray(result.validation_errors) && result.validation_errors.length) throw new AdportError('PROVIDER_ERROR', 'spotify: draft hierarchy failed validation; nothing was published', { validation_errors: result.validation_errors });
}
