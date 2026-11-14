import { createHash } from 'node:crypto';
import { AdportError, creativeStatusAction, type Creative, type MediaResolver, type MediaSource, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import type { z } from 'zod';
import type { groupPayload } from './creative-tools.js';
import type { TikTokClient } from './client.js';

type Row = Record<string, unknown>;
type PageInfo = { total_page?: number; total_number?: number };
interface Page { account_id: string; page: number; page_size: number }
interface List { list?: Row[]; page_info?: PageInfo }
interface Plan { summary: string; changes: string[]; coercions: string[]; budgetDeltas: WritePreview['budgetDeltas']; execute: () => Promise<string[]> }

/** Contracts checked against TikTok-owned SDK f809c396 and v1.3 OpenAPI files. */
export class TikTokCreativeService {
  constructor(private readonly client: TikTokClient, private readonly media: MediaResolver) {}

  async read(path: string, input: { account_id: string } & Row, post = false) {
    const { account_id, ...params } = input;
    return post ? this.client.post(path, { ...params, advertiser_id: account_id }) : this.client.get(path, { ...params, advertiser_id: account_id });
  }

  async groups(input: Page & { campaign_ids?: string[]; ad_group_ids?: string[] }) {
    const data = await this.client.get<List>('adgroup/get', { advertiser_id: input.account_id, filtering: { ...(input.campaign_ids ? { campaign_ids: input.campaign_ids } : {}), ...(input.ad_group_ids ? { adgroup_ids: input.ad_group_ids } : {}) }, page: input.page, page_size: input.page_size });
    return { ad_groups: data.list ?? [], page_info: data.page_info, truncated: truncated(data, input) };
  }

  async ads(input: Page & { ad_group_ids?: string[]; ad_ids?: string[] }) {
    const data = await this.client.get<List>('ad/get', { advertiser_id: input.account_id, filtering: { ...(input.ad_group_ids ? { adgroup_ids: input.ad_group_ids } : {}), ...(input.ad_ids ? { ad_ids: input.ad_ids } : {}) }, page: input.page, page_size: input.page_size });
    const creatives: Creative[] = (data.list ?? []).map(row => {
      if (row.advertiser_id !== undefined && String(row.advertiser_id) !== input.account_id) throw new AdportError('PROVIDER_ERROR', 'tiktok: ad response belongs to another advertiser');
      const id = String(row.ad_id), group = String(row.adgroup_id ?? ''), status = String(row.operation_status ?? row.secondary_status ?? '');
      const args = { account_id: input.account_id, ad_group_id: group, ad_id: id };
      return { id, name: String(row.ad_name ?? id), account_id: input.account_id, provider: 'tiktok', type: String(row.ad_format ?? 'TIKTOK_AD'), status,
        ...(row.campaign_id ? { campaign_id: String(row.campaign_id) } : {}), ...(group ? { ad_group_id: group } : {}), headlines: [], descriptions: typeof row.ad_text === 'string' ? [row.ad_text] : [], landing_urls: safeUrl(row.landing_page_url),
        media: [...safeUrl(row.video_url).filter(url => url.startsWith('https:')).map(url => ({ type: 'video' as const, url })), ...safeUrl(row.image_url).filter(url => url.startsWith('https:')).map(url => ({ type: 'image' as const, url }))],
        actions: status === 'DELETE' ? [] : [
          ...(['ENABLE', 'DISABLE'].includes(status) ? [creativeStatusAction('tiktok_set_ad_status', { account_id: input.account_id, ad_ids: [id] }, status, ['ENABLE', 'DISABLE'])] : []),
          ...(group ? [{ label: 'Edit ad copy', tool: 'tiktok_update_ad', arguments: args, fields: [{ key: 'ad_name', label: 'Ad name', type: 'text' as const, value: String(row.ad_name ?? ''), max_length: 512 }, ...(!row.tiktok_item_id && typeof row.ad_text === 'string' ? [{ key: 'ad_text', label: 'Ad text', type: 'text' as const, value: row.ad_text, max_length: 100 }] : [])] }] : []),
        ],
      };
    });
    return { creatives, ads: data.list ?? [], page_info: data.page_info, truncated: truncated(data, input) };
  }

  private async owned(account: string, entity: 'campaign' | 'adgroup' | 'ad', ids: string[]): Promise<Row[]> {
    const key = `${entity}_id`;
    const data = await this.client.get<List>(`${entity}/get`, { advertiser_id: account, filtering: { [`${entity}_ids`]: ids }, page: 1, page_size: Math.max(ids.length, 100) });
    return ids.map(id => {
      const row = data.list?.find(row => String(row[key]) === id);
      if (!row || (row.advertiser_id !== undefined && String(row.advertiser_id) !== account) || row.operation_status === 'DELETE') throw new AdportError('INVALID_INPUT', `tiktok: ${entity} ${id} was not found in the selected advertiser`);
      return row;
    });
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const p = op.payload;
    const coercions: string[] = [], budgetDeltas: WritePreview['budgetDeltas'] = [];
    let path: string, body: Row, ids: string[] = [];
    const paused = (value: unknown, label: string) => { if (guard.forcePausedCreation && value !== 'DISABLE') { coercions.push(`${label}.operation_status coerced to DISABLE by policy (paused_creation)`); return 'DISABLE'; } return value ?? 'DISABLE'; };
    if (op.tool === 'tiktok_upload_image' || op.tool === 'tiktok_upload_video') return this.upload(op, op.tool.endsWith('_image') ? 'image' : 'video');
    switch (op.tool) {
      case 'tiktok_create_ad_group': {
        const value = p as z.infer<typeof groupPayload>;
        await this.owned(op.accountId, 'campaign', [value.campaign_id]);
        const { targeting, ...fields } = value;
        path = 'adgroup/create'; body = { ...fields, ...targeting, advertiser_id: op.accountId, operation_status: paused(value.operation_status, 'adgroup') };
        for (const field of ['budget', 'bid_price', 'conversion_bid_price'] as const) if (value[field] !== undefined) budgetDeltas.push({ target: `new ad group ${value.adgroup_name} ${field}`, toMicros: Math.round(value[field]! * 1_000_000) });
        break;
      }
      case 'tiktok_create_ads': {
        const group = String(p.ad_group_id); await this.owned(op.accountId, 'adgroup', [group]);
        path = 'ad/create'; body = { advertiser_id: op.accountId, adgroup_id: group, creatives: (p.creatives as Row[]).map((creative, index) => ({ ...creative, operation_status: paused(creative.operation_status, `creative[${index}]`) })) };
        break;
      }
      case 'tiktok_set_ad_group_status':
      case 'tiktok_set_ad_status': {
        const entity = op.tool === 'tiktok_set_ad_status' ? 'ad' : 'adgroup';
        ids = p[entity === 'ad' ? 'ad_ids' : 'ad_group_ids'] as string[];
        const current = await this.owned(op.accountId, entity, ids);
        return { summary: `Set ${ids.length} TikTok ${entity}(s) → ${p.operation_status}`, changes: current.map(row => `~ ${row[`${entity}_id`]} status ${row.operation_status ?? 'unknown'} → ${p.operation_status}`), budgetDeltas, coercions, execute: async () => { await this.client.post(`${entity}/status/update`, { advertiser_id: op.accountId, [`${entity}_ids`]: ids, operation_status: p.operation_status, ...(entity === 'adgroup' ? { allow_partial_success: false } : {}) }); return ids; } };
      }
      case 'tiktok_update_ad': {
        const [ad] = await this.owned(op.accountId, 'ad', [String(p.ad_id)]);
        if (String(ad!.adgroup_id) !== p.ad_group_id) throw new AdportError('INVALID_INPUT', 'tiktok: ad does not belong to the selected ad group');
        await this.owned(op.accountId, 'adgroup', [String(p.ad_group_id)]);
        const { ad_group_id, ...fields } = p;
        path = 'ad/update'; body = { advertiser_id: op.accountId, adgroup_id: ad_group_id, patch_update: true, creatives: [fields] }; ids = [String(p.ad_id)];
        break;
      }
      case 'tiktok_update_targeting':
      case 'tiktok_set_ad_group_budget':
      case 'tiktok_set_ad_group_bidding': {
        const [current] = await this.owned(op.accountId, 'adgroup', [String(p.ad_group_id)]);
        const fields = op.tool === 'tiktok_update_targeting' ? p.targeting as Row : Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'ad_group_id'));
        for (const key of ['budget', 'bid_price', 'conversion_bid_price']) if (fields[key] !== undefined) {
          if (current![key] === undefined || !Number.isFinite(Number(current![key]))) throw new AdportError('INVALID_INPUT', `tiktok: current ${key} is unavailable; cannot policy-check the change`);
          budgetDeltas.push({ target: `ad group ${p.ad_group_id} ${key}`, fromMicros: Math.round(Number(current![key]) * 1_000_000), toMicros: Math.round(Number(fields[key]) * 1_000_000) });
        }
        path = 'adgroup/update'; body = { advertiser_id: op.accountId, adgroup_id: p.ad_group_id, ...fields }; ids = [String(p.ad_group_id)];
        break;
      }
      default: throw new AdportError('PROVIDER_ERROR', `tiktok: unsupported creative tool ${op.tool}`);
    }
    return { summary: `TikTok ${op.tool.replace(/^tiktok_/, '').replaceAll('_', ' ')}`, changes: [`${op.kind === 'create' ? '+' : '~'} POST /${path} ${JSON.stringify(body)}`], budgetDeltas, coercions, execute: async () => {
      const result = await this.client.post<Row>(path, body);
      if (op.kind !== 'create') return ids;
      const created = resourceIds(result, path === 'adgroup/create' ? 'adgroup' : 'ad');
      if (!created.length) throw new AdportError('PROVIDER_ERROR', 'tiktok: creation returned no resource IDs; read configuration before retrying');
      return created;
    } };
  }

  private async upload(op: WriteOperation, type: 'image' | 'video'): Promise<Plan> {
    const file = await this.media.read(op.payload as unknown as MediaSource, { maxBytes: (type === 'image' ? 10 : 100) * 1024 * 1024, contentTypes: type === 'image' ? ['image/jpeg', 'image/png'] : ['video/mp4', 'video/quicktime'] });
    const signature = createHash('md5').update(file.bytes).digest('hex');
    return { summary: `Upload TikTok ${type} ${file.name} (${file.bytes.byteLength} bytes)`, changes: [`+ ${type} SHA-256=${file.sha256}; advertiser=${op.accountId}`], coercions: [], budgetDeltas: [], execute: async () => {
      const form = new FormData(); form.append('advertiser_id', op.accountId); form.append('file_name', file.name); form.append('upload_type', 'UPLOAD_BY_FILE'); form.append(`${type}_signature`, signature); form.append(`${type}_file`, new Blob([file.bytes], { type: file.contentType }), file.name);
      const result = await this.client.postMultipart<Row>(`file/${type}/ad/upload`, form), ids = resourceIds(result, type);
      if (!ids.length) throw new AdportError('PROVIDER_ERROR', 'tiktok: upload returned no media ID; inspect the asset library before retrying');
      return ids;
    } };
  }
}

function truncated(data: List, input: Page): boolean { return data.page_info?.total_page !== undefined ? input.page < data.page_info.total_page : data.page_info?.total_number !== undefined ? input.page * input.page_size < data.page_info.total_number : (data.list?.length ?? 0) >= input.page_size; }
function safeUrl(value: unknown): string[] { try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? [url.toString()] : []; } catch { return []; } }
function resourceIds(value: unknown, kind: 'ad' | 'adgroup' | 'image' | 'video'): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => resourceIds(item, kind)))];
  if (!value || typeof value !== 'object') return [];
  return [...new Set(Object.entries(value).flatMap(([key, item]) => key === `${kind}_id` || key === `${kind}_ids` ? (Array.isArray(item) ? item.filter(validId).map(String) : validId(item) ? [String(item)] : []) : resourceIds(item, kind)))];
}
function validId(value: unknown): value is string | number { return typeof value === 'string' && value.length > 0 || typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
