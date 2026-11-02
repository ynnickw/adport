import { AdportError, creativeStatusAction, LocalMediaResolver, type Creative, type MediaResolver, type MediaSource, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { MetaGraphClient, normalizeAccountId } from './client.js';

type Row = Record<string, unknown>;
interface Plan { summary: string; changes: string[]; coercions: string[]; budgetDeltas: WritePreview['budgetDeltas']; serverValidated?: boolean; execute: (validateOnly: boolean) => Promise<string[]> }
const creativeFields = 'id,account_id,name,title,body,image_url,image_hash,thumbnail_url,video_id,object_story_spec,object_story_id,effective_object_story_id,link_url,url_tags,asset_feed_spec';
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function url(value: unknown, media = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { const parsed = new URL(value); return (media ? parsed.protocol === 'https:' : ['https:', 'http:'].includes(parsed.protocol)) && !parsed.username && !parsed.password ? value : undefined; } catch { return undefined; }
}

/** Shapes follow the official Meta Business SDK adaccount/ad/adcreative/adset definitions. */
export class MetaCreativeService {
  constructor(private readonly client: MetaGraphClient, private readonly pages: () => Promise<Array<{ id: string }>>, private readonly media: MediaResolver = new LocalMediaResolver()) {}

  private async owned(id: string, account: string, fields = 'id,account_id'): Promise<Row> {
    if (!/^\d+$/.test(id)) throw new AdportError('INVALID_INPUT', 'Meta object IDs must be numeric.');
    const row = await this.client.get<Row>(id, { fields });
    if (text(row.id) !== id || normalizeAccountId(text(row.account_id)) !== account) throw new AdportError('INVALID_INPUT', 'Meta object does not belong to the selected ad account.');
    return row;
  }

  private async rows(accountId: string, edge: string, fields: string, limit: number, filters: Row[] = []): Promise<{ rows: Row[]; truncated: boolean }> {
    const rows = await this.client.getPaged<Row>(`act_${normalizeAccountId(accountId)}/${edge}`, {
      fields, limit: String(Math.min(limit + 1, 100)), ...(filters.length ? { filtering: JSON.stringify(filters) } : {}),
    }, limit + 1);
    const account = normalizeAccountId(accountId);
    if (rows.some(row => Object.hasOwn(row, 'account_id') && normalizeAccountId(text(row.account_id)) !== account)) throw new AdportError('INVALID_INPUT', 'Meta returned an object outside the selected account.');
    return { rows: rows.slice(0, limit), truncated: rows.length > limit };
  }

  async listAds(input: { account_id: string; campaign_id?: string; ad_set_id?: string; limit: number }) {
    const filters: Row[] = [];
    if (input.campaign_id) filters.push({ field: 'campaign.id', operator: 'EQUAL', value: input.campaign_id });
    if (input.ad_set_id) filters.push({ field: 'adset.id', operator: 'EQUAL', value: input.ad_set_id });
    const data = await this.rows(input.account_id, 'ads', `id,account_id,name,status,effective_status,campaign_id,adset_id,creative{${creativeFields}}`, input.limit, filters);
    return { ads: data.rows, truncated: data.truncated, creatives: data.rows.map(row => this.card(object(row.creative), input.account_id, row)) };
  }

  async listCreatives(input: { account_id: string; limit: number }) {
    const data = await this.rows(input.account_id, 'adcreatives', creativeFields, input.limit);
    return { raw: data.rows, truncated: data.truncated, creatives: data.rows.map(row => this.card(row, input.account_id)) };
  }

  async listAdSets(input: { account_id: string; campaign_id?: string; limit: number }) {
    return this.rows(input.account_id, 'adsets', 'id,account_id,campaign_id,name,status,effective_status,targeting,optimization_goal,billing_event,bid_strategy,bid_amount,bid_constraints,daily_budget,lifetime_budget,start_time,end_time,promoted_object,dsa_beneficiary,dsa_payor', input.limit,
      input.campaign_id ? [{ field: 'campaign.id', operator: 'EQUAL', value: input.campaign_id }] : []);
  }

  async library(kind: 'images' | 'videos' | 'custom_audiences' | 'pixels', input: { account_id: string; limit: number }) {
    const config = {
      images: ['adimages', 'hash,name,url,width,height,status'], videos: ['advideos', 'id,title,description,status,source,picture,length,created_time'],
      custom_audiences: ['customaudiences', 'id,account_id,name,subtype,description,delivery_status,operation_status,approximate_count_lower_bound,approximate_count_upper_bound'],
      pixels: ['adspixels', 'id,name,last_fired_time'],
    }[kind]!;
    const result = await this.rows(input.account_id, config[0]!, config[1]!, input.limit);
    if (kind !== 'images' && kind !== 'videos') return result;
    return { ...result, creatives: result.rows.map(row => {
      const image = kind === 'images', id = text(image ? row.hash : row.id), account = normalizeAccountId(input.account_id);
      const source = url(image ? row.url : row.source, true), thumbnail = url(row.picture, true);
      return { id, account_id: account, provider: 'meta', name: text(row.name ?? row.title) || `${image ? 'Image' : 'Video'} ${id}`, type: image ? 'IMAGE' : 'VIDEO',
        headlines: [], descriptions: text(row.description) ? [text(row.description)] : [], landing_urls: [],
        media: source ? [{ type: image ? 'image' as const : 'video' as const, url: source }] : thumbnail ? [{ type: 'image' as const, url: thumbnail }] : [],
        actions: image ? [{ label: 'Permanently delete image', tool: 'meta_delete_image', arguments: { account_id: account, image_hash: id }, fields: [] }] : [],
      };
    }) };
  }

  async searchTargeting(input: { type: string; query: string; country_code?: string; limit: number }) {
    const rows = await this.client.getPaged<Row>('search', { type: input.type, q: input.query, limit: String(input.limit), ...(input.country_code ? { country_code: input.country_code } : {}) }, input.limit + 1);
    return { rows: rows.slice(0, input.limit), truncated: rows.length > input.limit };
  }

  async deliveryEstimate(input: { account_id: string; targeting_spec: Row; optimization_goal: string }) {
    const estimates = await this.client.getPaged<Row>(`act_${normalizeAccountId(input.account_id)}/delivery_estimate`, { targeting_spec: JSON.stringify(input.targeting_spec), optimization_goal: input.optimization_goal }, 100);
    return { estimates };
  }

  private card(content: Row, accountId: string, ad?: Row): Creative {
    const story = object(content.object_story_spec), link = object(story.link_data), video = object(story.video_data);
    const id = text(ad?.id ?? content.id), account = normalizeAccountId(accountId);
    if (!/^\d+$/.test(id)) throw new AdportError('PROVIDER_ERROR', 'Meta returned a creative without a valid ID.');
    const headline = text(link.name ?? video.title ?? content.title), description = text(link.description), message = text(link.message ?? video.message ?? content.body);
    const imageUrl = url(content.image_url ?? link.picture ?? content.thumbnail_url, true);
    const landing = url(link.link ?? object(object(video.call_to_action).value).link ?? content.link_url);
    const actions: Creative['actions'] = [];
    if (ad && !['DELETED', 'ARCHIVED'].includes(text(ad.status))) {
      actions.push(creativeStatusAction('meta_set_ad_status', { account_id: account, ad_id: id }, text(ad.status), ['ACTIVE', 'PAUSED']));
      actions.push({ label: 'Replace creative', tool: 'meta_update_ad', arguments: { account_id: account, ad_id: id }, fields: [{ key: 'creative_id', label: 'Existing creative ID', type: 'text', value: text(content.id) }] });
    }
    if (text(story.page_id) && text(link.image_hash) && landing) {
      actions.push({ label: 'Copy into a new creative', tool: 'meta_create_link_creative',
        arguments: { account_id: account, page_id: text(story.page_id), image_hash: text(link.image_hash), ...(object(link.call_to_action).type ? { call_to_action: object(link.call_to_action).type } : {}) },
        fields: [
          { key: 'name', label: 'New creative name', type: 'text', value: `${text(content.name) || text(ad?.name) || 'Creative'} copy` },
          { key: 'headline', label: 'Headline', type: 'text', value: headline }, { key: 'message', label: 'Primary text', type: 'text', value: message },
          { key: 'description', label: 'Description', type: 'text', value: description }, { key: 'link', label: 'Destination URL', type: 'text', value: landing },
        ] });
    }
    return { id, provider: 'meta', account_id: account, name: text(ad?.name ?? content.name) || `Creative ${id}`, type: video.video_id || content.video_id ? 'VIDEO' : Array.isArray(link.child_attachments) ? 'CAROUSEL' : 'LINK',
      ...(ad ? { status: text(ad.status), campaign_id: text(ad.campaign_id), ad_group_id: text(ad.adset_id) } : {}),
      headlines: headline ? [headline] : [], descriptions: [message, description].filter(Boolean), landing_urls: landing ? [landing] : [],
      media: imageUrl ? [{ type: 'image', url: imageUrl, alt: headline || 'Creative preview' }] : [], actions };
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const account = normalizeAccountId(op.accountId), p = op.payload as Row;
    const post = (path: string, fields: Row, summary: string, changes: string[], serverValidated = true, coercions: string[] = []): Plan => ({
      summary, changes, coercions, budgetDeltas: [], serverValidated,
      execute: async validateOnly => {
        const result = await this.client.post<{ id?: string }>(path, { ...fields, ...(validateOnly ? { execution_options: ['validate_only'] } : {}) });
        return result.id ? [result.id] : /^\d+$/.test(path) ? [path] : [];
      },
    });
    switch (op.tool) {
      case 'meta_create_link_creative':
      case 'meta_create_creative': {
        let story = p.object_story_spec;
        if (op.tool === 'meta_create_link_creative') story = { page_id: p.page_id, link_data: { image_hash: p.image_hash, link: p.link, message: p.message, name: p.headline,
          ...(p.description !== undefined ? { description: p.description } : {}), ...(p.call_to_action ? { call_to_action: { type: p.call_to_action, value: { link: p.link } } } : {}) } };
        const pageId = story ? text(object(story).page_id) : text(p.object_story_id).split('_')[0];
        if (!pageId || !(await this.pages()).some(page => page.id === pageId)) throw new AdportError('INVALID_INPUT', 'Choose a Facebook Page accessible to this connection.');
        const fields = { name: p.name, ...(story ? { object_story_spec: story } : { object_story_id: p.object_story_id }), ...(p.url_tags !== undefined ? { url_tags: p.url_tags } : {}) };
        return post(`act_${account}/adcreatives`, fields, `Create Meta creative "${p.name}"`, [`+ creative ${JSON.stringify(fields)}`, 'Existing ads and serving status are unchanged.']);
      }
      case 'meta_create_ad': {
        await this.owned(text(p.ad_set_id), account);
        await this.owned(text(p.creative_id), account);
        const status = guard.forcePausedCreation ? 'PAUSED' : p.status;
        return post(`act_${account}/ads`, { name: p.name, adset_id: p.ad_set_id, creative: { creative_id: p.creative_id }, status }, `Create Meta ad "${p.name}" (${status})`,
          [`+ ad in ad set ${p.ad_set_id}, creative ${p.creative_id}, status ${status}`], true, guard.forcePausedCreation && p.status !== 'PAUSED' ? ['status coerced to PAUSED by policy (paused_creation)'] : []);
      }
      case 'meta_set_ad_status':
      case 'meta_update_ad': {
        const current = await this.owned(text(p.ad_id), account, 'id,account_id,name,status,creative');
        const fields: Row = op.tool === 'meta_set_ad_status' ? { status: p.status } : { ...(p.name !== undefined ? { name: p.name } : {}), ...(p.creative_id ? { creative: { creative_id: p.creative_id } } : {}) };
        if (p.creative_id) await this.owned(text(p.creative_id), account);
        return post(text(p.ad_id), fields, `Update Meta ad "${current.name ?? p.ad_id}"`, [`~ ${JSON.stringify({ name: current.name, status: current.status, creative: current.creative })} → ${JSON.stringify(fields)}`,
          ...(op.tool === 'meta_update_ad' ? [`Serving status remains ${current.status}. Creative replacement can trigger review.`] : [])]);
      }
      case 'meta_rename_creative':
        await this.owned(text(p.creative_id), account);
        return post(text(p.creative_id), { name: p.name }, `Rename Meta creative ${p.creative_id}`, [`~ name → ${p.name}`], false);
      case 'meta_delete_creative':
      case 'meta_delete_image': {
        const image = op.tool === 'meta_delete_image';
        if (image) {
          const images = await this.client.getPaged<Row>(`act_${account}/adimages`, { hashes: JSON.stringify([p.image_hash]), fields: 'hash,name' }, 2);
          if (!images.some(row => row.hash === p.image_hash)) throw new AdportError('INVALID_INPUT', 'Image hash not found in the selected account library.');
        } else await this.owned(text(p.creative_id), account);
        const id = text(image ? p.image_hash : p.creative_id);
        return { summary: `Permanently delete Meta ${image ? 'image' : 'creative'} ${id}`, changes: [`- ${id}; cannot be undone. Check existing creative/ad references before applying.`], coercions: [], budgetDeltas: [], serverValidated: false,
          execute: async () => { await this.client.delete(image ? `act_${account}/adimages` : id, image ? { hash: id } : {}); return [id]; } };
      }
      case 'meta_update_targeting':
      case 'meta_set_ad_set_bidding': {
        const current = await this.owned(text(p.ad_set_id), account, 'id,account_id,name,targeting,bid_strategy,bid_amount,bid_constraints,optimization_goal');
        const fields: Row = op.tool === 'meta_update_targeting' ? { targeting: p.targeting } : { bid_strategy: p.bid_strategy, ...(p.bid_amount !== undefined ? { bid_amount: p.bid_amount } : {}), ...(p.bid_constraints !== undefined ? { bid_constraints: p.bid_constraints } : {}) };
        if (op.tool === 'meta_set_ad_set_bidding') {
          if (p.bid_strategy === 'LOWEST_COST_WITHOUT_CAP' && (p.bid_amount !== undefined || p.bid_constraints !== undefined)) throw new AdportError('INVALID_INPUT', 'Uncapped bidding cannot include bid_amount or bid_constraints.');
          if (['LOWEST_COST_WITH_BID_CAP', 'COST_CAP'].includes(text(p.bid_strategy)) && p.bid_amount === undefined) throw new AdportError('INVALID_INPUT', 'This bid strategy requires bid_amount in minor currency units.');
          if (p.bid_strategy === 'LOWEST_COST_WITH_MIN_ROAS' && (!p.bid_constraints || !['VALUE', 'ADVERTISER_SILOED_VALUE'].includes(text(current.optimization_goal)))) throw new AdportError('INVALID_INPUT', 'Minimum ROAS requires a floor and VALUE optimization.');
        }
        return post(text(p.ad_set_id), fields, `Update Meta ad set "${current.name ?? p.ad_set_id}"`, [`~ ${JSON.stringify(op.tool === 'meta_update_targeting' ? current.targeting : { bid_strategy: current.bid_strategy, bid_amount: current.bid_amount, bid_constraints: current.bid_constraints })} → ${JSON.stringify(fields)}`]);
      }
      case 'meta_create_custom_audience':
        return post(`act_${account}/customaudiences`, { name: p.name, subtype: 'CUSTOM', customer_file_source: p.customer_file_source, ...(p.description !== undefined ? { description: p.description } : {}) }, `Create empty Meta audience "${p.name}"`, ['+ Empty CUSTOM audience; no customer data uploaded.'], false);
      case 'meta_create_pixel':
        return post(`act_${account}/adspixels`, { name: p.name }, `Create Meta pixel "${p.name}"`, ['+ Pixel container; no tracking code installed and no events sent.'], false);
      case 'meta_upload_image':
      case 'meta_upload_video': {
        const image = op.tool === 'meta_upload_image';
        const file = await this.media.read(p as unknown as MediaSource, { maxBytes: image ? 30 * 1024 * 1024 : 100 * 1024 * 1024, contentTypes: image ? ['image/png', 'image/jpeg'] : ['video/mp4', 'video/quicktime'] });
        return { summary: `Upload Meta ${image ? 'image' : 'video'} ${file.name} (${file.bytes.byteLength} bytes)`, changes: [`+ ${file.contentType} sha256=${file.sha256}`, 'No ad is published.'], coercions: [], budgetDeltas: [], serverValidated: false,
          execute: async () => {
            if (image) {
              const result = await this.client.post<{ images?: Record<string, { hash?: string }> }>(`act_${account}/adimages`, { bytes: Buffer.from(file.bytes).toString('base64') });
              return Object.values(result.images ?? {}).flatMap(value => value.hash ? [value.hash] : []);
            }
            const form = new FormData(); form.append('source', new Blob([file.bytes], { type: file.contentType }), file.name);
            if (p.title !== undefined) form.append('title', text(p.title));
            const result = await this.client.postMultipart<{ id?: string }>(`act_${account}/advideos`, form);
            return result.id ? [result.id] : [];
          } };
      }
      default: throw new AdportError('PROVIDER_ERROR', `meta: unsupported write tool ${op.tool}`);
    }
  }
}
