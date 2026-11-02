import { AdportError, creativeStatusAction, type Creative, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { formatPartialErrors, MicrosoftAdsClient, type RequestScope } from './client.js';

type Row = Record<string, unknown>;
interface Plan { summary: string; changes: string[]; coercions: string[]; budgetDeltas: WritePreview['budgetDeltas']; execute: () => Promise<string[]> }
type Parent = { account_id: string; campaign_id: string; ad_group_id: string };
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const objects = (value: unknown): Row[] => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') as Row[] : [];
const texts = (value: unknown): string[] => objects(value).flatMap(link => typeof object(link.Asset).Text === 'string' ? [String(object(link.Asset).Text)] : []);

/** REST wire shapes pinned in MicrosoftDocs/Advertising (2026-11-02). */
export class MicrosoftChildService {
  constructor(private readonly client: MicrosoftAdsClient, private readonly scope: (accountId: string) => Promise<RequestScope>,
    private readonly campaign: (accountId: string, campaignId: string) => Promise<unknown>) {}

  private async request(account: string, path: string, body: Row, method: 'POST' | 'PUT' | 'DELETE' = 'POST'): Promise<Row> {
    const result = await this.client.request<Row>('campaign', method, path, body, await this.scope(account));
    const partial = formatPartialErrors(result.PartialErrors as Parameters<typeof formatPartialErrors>[0]);
    if (partial) throw new AdportError('PROVIDER_ERROR', `microsoft: ${path} partial errors — ${partial}. Check successful resource IDs before retrying.`, {
      resourceIds: Object.entries(result).filter(([key]) => /Ids$/.test(key)).flatMap(([, value]) => Array.isArray(value) ? value.filter(id => id !== null).map(String) : []), partialErrors: result.PartialErrors,
    });
    return result;
  }

  async listGroups(input: { account_id: string; campaign_id: string }) {
    await this.campaign(input.account_id, input.campaign_id);
    const result = await this.request(input.account_id, 'AdGroups/QueryByCampaignId', { CampaignId: input.campaign_id, ReturnAdditionalFields: 'AdGroupType' });
    return { rows: objects(result.AdGroups), truncated: false };
  }

  private async group(input: Parent): Promise<Row> {
    await this.campaign(input.account_id, input.campaign_id);
    const result = await this.request(input.account_id, 'AdGroups/QueryByIds', { CampaignId: input.campaign_id, AdGroupIds: [input.ad_group_id], ReturnAdditionalFields: 'AdGroupType' });
    const group = objects(result.AdGroups).find(row => String(row.Id) === input.ad_group_id);
    if (!group) throw new AdportError('INVALID_INPUT', 'Microsoft ad group was not found in the selected campaign/account.');
    return group;
  }

  async listKeywords(input: Parent) {
    await this.group(input);
    const result = await this.request(input.account_id, 'Keywords/QueryByAdGroupId', { AdGroupId: input.ad_group_id, ReturnAdditionalFields: null });
    return { rows: objects(result.Keywords), truncated: false };
  }

  async listAds(input: Parent & { ad_types: string[]; limit: number }) {
    await this.group(input);
    const result = await this.request(input.account_id, 'Ads/QueryByAdGroupId', { AdGroupId: input.ad_group_id, AdTypes: input.ad_types, ReturnAdditionalFields: null });
    const ads = objects(result.Ads);
    return { ads: ads.slice(0, input.limit), truncated: ads.length > input.limit, creatives: ads.slice(0, input.limit).map(ad => this.card(input, ad)) };
  }

  private card(input: Parent, ad: Row): Creative {
    const adId = String(ad.Id), headlines = texts(ad.Headlines), descriptions = texts(ad.Descriptions), args = { account_id: input.account_id, campaign_id: input.campaign_id, ad_group_id: input.ad_group_id, ad_id: adId };
    if (!/^\d+$/.test(adId)) throw new AdportError('PROVIDER_ERROR', 'Microsoft returned an ad without a valid ID.');
    const actions: Creative['actions'] = ['Active', 'Paused'].includes(String(ad.Status)) ? [creativeStatusAction('microsoft_set_ad_status', { ...args, ad_type: ad.Type }, String(ad.Status), ['Active', 'Paused'])] : [];
    if (ad.Type === 'ResponsiveSearch') actions.push({ label: 'Edit ad copy', tool: 'microsoft_update_responsive_search_ad', arguments: args,
      fields: [
        { key: 'headlines', label: 'Headlines (one per line)', type: 'text_list', value: headlines },
        { key: 'descriptions', label: 'Descriptions (one per line)', type: 'text_list', value: descriptions },
        { key: 'final_urls', label: 'Landing pages (one per line)', type: 'url_list', value: Array.isArray(ad.FinalUrls) ? ad.FinalUrls.map(String) : [] },
      ] });
    const destinations = Array.isArray(ad.FinalUrls) ? ad.FinalUrls.map(String).filter(value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }) : [];
    return { id: adId, provider: 'microsoft', account_id: input.account_id, campaign_id: input.campaign_id, ad_group_id: input.ad_group_id,
      name: headlines[0] || String(ad.Title ?? ad.TitlePart1 ?? `Ad ${adId}`), type: String(ad.Type), status: String(ad.Status),
      headlines, descriptions, landing_urls: destinations, media: [], actions };
  }

  private async ad(input: Parent, id: string, type: string): Promise<Row> {
    await this.group(input);
    const result = await this.request(input.account_id, 'Ads/QueryByIds', { AdGroupId: input.ad_group_id, AdIds: [id], AdTypes: [type], ReturnAdditionalFields: null });
    const ad = objects(result.Ads).find(row => String(row.Id) === id && row.Type === type);
    if (!ad) throw new AdportError('INVALID_INPUT', 'Microsoft ad was not found with this type in the selected ad group/account.');
    return ad;
  }

  private async keywords(input: Parent, ids: string[]): Promise<Row[]> {
    await this.group(input);
    const result = await this.request(input.account_id, 'Keywords/QueryByIds', { AdGroupId: input.ad_group_id, KeywordIds: ids, ReturnAdditionalFields: null });
    const rows = objects(result.Keywords);
    if (ids.some(id => !rows.some(row => String(row.Id) === id))) throw new AdportError('INVALID_INPUT', 'A keyword was not found in the selected ad group/account.');
    return rows;
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const p = op.payload as Row, parent: Parent = { account_id: op.accountId, campaign_id: String(p.campaign_id), ad_group_id: String(p.ad_group_id) };
    const mutate = (collection: string, body: Row, changes: string[], ids: string[] = [], coercions: string[] = []): Plan => ({
      summary: changes[0]!, changes, coercions, budgetDeltas: [], execute: async () => {
        const method = op.kind === 'create' ? 'POST' : op.kind === 'remove' ? 'DELETE' : 'PUT';
        const result = await this.request(op.accountId, collection, body, method);
        if (op.kind !== 'create') return ids;
        const values = result[`${collection === 'AdGroups' ? 'AdGroup' : collection === 'Keywords' ? 'Keyword' : 'Ad'}Ids`];
        const created = Array.isArray(values) ? values.filter(id => id !== null).map(String) : [];
        if (created.length !== objects(body[collection]).length) throw new AdportError('PROVIDER_ERROR', 'Microsoft did not return an ID for every requested resource. Check creation status before retrying.', { resourceIds: created });
        return created;
      },
    });
    const creationStatus = (requested: unknown) => guard.forcePausedCreation ? 'Paused' : requested ?? 'Paused';
    const creationCoercion = (requested: unknown) => guard.forcePausedCreation && requested === 'Active' ? ['status coerced to Paused by policy (paused_creation)'] : [];
    const assetLinks = (value: unknown, current: unknown = []): Row[] => (value as string[]).map((text, index) => {
      const previous = objects(current)[index];
      // Text asset IDs are read-only; Microsoft deduplicates assets by text.
      return { Asset: { Type: 'TextAsset', Text: text }, ...(previous?.PinnedField ? { PinnedField: previous.PinnedField } : {}) };
    });
    switch (op.tool) {
      case 'microsoft_create_ad_group':
        await this.campaign(op.accountId, String(p.campaign_id));
        return mutate('AdGroups', { CampaignId: p.campaign_id, AdGroups: [{ Name: p.name, AdGroupType: 'SearchStandard', Language: p.language, Status: creationStatus(p.status), ...(p.cpc_bid !== undefined ? { CpcBid: { Amount: p.cpc_bid } } : {}) }] },
          [`+ SearchStandard ad group "${p.name}" (${creationStatus(p.status)}), language=${p.language}`, ...(p.cpc_bid !== undefined ? [`CPC bid ${p.cpc_bid} whole currency units`] : [])], [], creationCoercion(p.status));
      case 'microsoft_set_ad_group_status':
      case 'microsoft_update_ad_group': {
        const current = await this.group(parent), fields = op.tool === 'microsoft_set_ad_group_status' ? { Status: p.status } : { ...(p.name !== undefined ? { Name: p.name } : {}), ...(p.cpc_bid !== undefined ? { CpcBid: { Amount: p.cpc_bid } } : {}) };
        return mutate('AdGroups', { CampaignId: p.campaign_id, AdGroups: [{ Id: p.ad_group_id, ...fields }] }, [`~ ad group ${p.ad_group_id}: ${JSON.stringify({ Name: current.Name, Status: current.Status, CpcBid: current.CpcBid })} → ${JSON.stringify(fields)}`], [String(p.ad_group_id)]);
      }
      case 'microsoft_create_responsive_search_ad': {
        const group = await this.group(parent);
        if (group.AdGroupType !== 'SearchStandard') throw new AdportError('INVALID_INPUT', 'Responsive search ads require a SearchStandard ad group.');
        const fields = { Type: 'ResponsiveSearch', Status: creationStatus(p.status), Headlines: assetLinks(p.headlines), Descriptions: assetLinks(p.descriptions), FinalUrls: p.final_urls,
          ...(p.path1 !== undefined ? { Path1: p.path1 } : {}), ...(p.path2 !== undefined ? { Path2: p.path2 } : {}) };
        return mutate('Ads', { AdGroupId: p.ad_group_id, Ads: [fields] }, [`+ responsive search ad ${JSON.stringify(fields)}`], [], creationCoercion(p.status));
      }
      case 'microsoft_update_responsive_search_ad':
      case 'microsoft_set_ad_status': {
        const type = op.tool === 'microsoft_set_ad_status' ? String(p.ad_type) : 'ResponsiveSearch';
        const current = await this.ad(parent, String(p.ad_id), type);
        const fields: Row = { Id: p.ad_id, Type: type };
        if (op.tool === 'microsoft_set_ad_status') fields.Status = p.status;
        else {
          if (p.headlines !== undefined) fields.Headlines = assetLinks(p.headlines, current.Headlines);
          if (p.descriptions !== undefined) fields.Descriptions = assetLinks(p.descriptions, current.Descriptions);
          if (p.final_urls !== undefined) fields.FinalUrls = p.final_urls;
          if (p.path1 !== undefined) fields.Path1 = p.path1;
          if (p.path2 !== undefined) fields.Path2 = p.path2;
        }
        return mutate('Ads', { AdGroupId: p.ad_group_id, Ads: [fields] }, [`~ ad ${p.ad_id}: ${JSON.stringify(current)} → ${JSON.stringify(fields)}`,
          ...(op.tool === 'microsoft_update_responsive_search_ad' ? [`Serving status remains ${current.Status}. Omitted content fields remain unchanged.`] : [])], [String(p.ad_id)]);
      }
      case 'microsoft_add_keywords': {
        await this.group(parent);
        const keywords = (p.keywords as Array<{ text: string; match_type: string; bid?: number; status: string }>).map(keyword => ({ Text: keyword.text, MatchType: keyword.match_type, Status: creationStatus(keyword.status), ...(keyword.bid !== undefined ? { Bid: { Amount: keyword.bid } } : {}) }));
        return mutate('Keywords', { AdGroupId: p.ad_group_id, Keywords: keywords }, [`+ keywords ${JSON.stringify(keywords)}`], [], guard.forcePausedCreation && (p.keywords as Array<{ status: string }>).some(keyword => keyword.status === 'Active') ? ['keyword statuses coerced to Paused by policy (paused_creation)'] : []);
      }
      case 'microsoft_set_keyword_status':
      case 'microsoft_set_keyword_bid': {
        const [current] = await this.keywords(parent, [String(p.keyword_id)]);
        const fields = op.tool === 'microsoft_set_keyword_status' ? { Status: p.status } : { Bid: { Amount: p.bid } };
        return mutate('Keywords', { AdGroupId: p.ad_group_id, Keywords: [{ Id: p.keyword_id, ...fields }] }, [`~ keyword ${p.keyword_id}: ${JSON.stringify(current)} → ${JSON.stringify(fields)}`], [String(p.keyword_id)]);
      }
      case 'microsoft_remove_keywords':
        await this.keywords(parent, p.keyword_ids as string[]);
        return mutate('Keywords', { AdGroupId: p.ad_group_id, KeywordIds: p.keyword_ids }, [`- keywords ${(p.keyword_ids as string[]).join(', ')}; cannot be undone`], p.keyword_ids as string[]);
      default: throw new AdportError('PROVIDER_ERROR', `microsoft: unsupported write tool ${op.tool}`);
    }
  }
}
