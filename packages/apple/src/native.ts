import { AdportError, creativeStatusAction, type Creative, type WriteOperation, type WritePreview } from '@adport/core';
import type { AppleAdsClient } from './client.js';

type ObjectData = Record<string, unknown>;
type Page = { account_id: string; offset: number; limit: number; filters?: unknown[]; sorting?: unknown[] };
interface ReportInput extends Page { entity: string; campaign_id?: string; fields?: string[]; group_by: string[]; start: string; end: string; time_zone?: string; granularity?: string; include_empty: boolean }
interface AppSearchInput extends Page { query?: string; owned_only?: boolean; adam_ids?: string[]; storefronts?: string[] }
interface GeoSearchInput extends Page { query: string; supply_source: string; eligible_only: boolean; entity?: string; country_code?: string }
interface RecommendationInput extends Page { category: string; promoted_object_id: string; promoted_object_type: string }
interface InsightInput extends Page { start: string; end: string; granularity: string; promoted_object_id?: string; slot?: string; fields?: string[] }
interface NativeCreative {
  id: number | string; adAccountId?: number | string; name?: string; status?: string; systemStatus?: string;
  creativeType?: string; campaignId?: number; adGroupId?: number; creativeId?: number; creative?: NativeCreative;
  deleted?: boolean;
  creativeSpec?: { localizedText?: Record<string, { promoText?: string }> };
  destination?: { url?: string; parameters?: { adamId?: string } };
}
export interface AppleNativePlan {
  summary: string; changes: string[]; coercions: string[]; budgetDeltas: WritePreview['budgetDeltas']; execute: () => Promise<string[]>;
}

/** Wire contracts: Apple's official v1 Node SDK, e81717d1 (checked 2026-11-03). */
export class AppleNativeService {
  constructor(private readonly client: AppleAdsClient) {}

  async query<T = unknown>(resource: string, input: Page) {
    return this.client.request<T>('POST', `${resource}/query`, { adAccountId: input.account_id, body: {
      filters: input.filters ?? [], ...(input.sorting?.length ? { sorting: input.sorting } : {}),
      pagination: { offset: input.offset, pageSize: input.limit },
    } });
  }

  async report(input: ReportInput) {
    return this.client.request('POST', `reports/apps/${input.entity}/query`, { adAccountId: input.account_id, body: {
      pagination: { offset: input.offset, pageSize: input.limit },
      filters: [...(input.filters ?? []), ...(input.campaign_id ? [{ field: input.entity === 'campaigns' ? 'id' : 'campaignId', operator: 'EQUALS', value: [input.campaign_id] }] : [])], ...(input.sorting?.length ? { sorting: input.sorting } : {}),
      ...(input.fields ? { fields: input.fields } : {}), ...(input.group_by.length ? { groupBy: input.group_by } : {}),
      timeRange: { start: input.start, end: input.end, timeZone: input.time_zone ?? (input.entity === 'searchterms' ? 'ORTZ' : 'UTC'), ...(input.granularity ? { granularity: input.granularity } : {}) },
      options: { includeRows: ['GRAND_TOTAL', ...(input.include_empty ? ['EMPTY_METRICS'] : [])] },
    } });
  }

  async searchApps(input: AppSearchInput) {
    const params = new URLSearchParams({ offset: String(input.offset), limit: String(input.limit) });
    if (input.query !== undefined) params.set('query', input.query);
    if (input.owned_only !== undefined) params.set('returnOwnedApps', String(input.owned_only));
    if (input.adam_ids) params.set('cpids', input.adam_ids.join(','));
    for (const storefront of input.storefronts ?? []) params.append('storeFronts', storefront);
    return this.client.request('GET', `search/apps?${params}`, { adAccountId: input.account_id });
  }

  async searchGeo(input: GeoSearchInput) {
    const params = new URLSearchParams({ query: input.query, supplySource: input.supply_source, offset: String(input.offset), pageSize: String(input.limit), eligible: String(input.eligible_only) });
    if (input.entity) params.set('entity', input.entity);
    if (input.country_code) params.set('countrycode', input.country_code);
    return this.client.request('GET', `search/geo?${params}`, { adAccountId: input.account_id });
  }

  async recommendations(family: 'recommendations' | 'suggestions', input: RecommendationInput) {
    return this.query(`${family}/${input.category}`, { ...input, filters: [
      { field: 'promotedObjectId', operator: 'EQUALS', value: [input.promoted_object_id] },
      { field: 'promotedObjectType', operator: 'EQUALS', value: [input.promoted_object_type] },
      ...(family === 'suggestions' && ['phrases', 'categories'].includes(input.category) ? [{ field: 'queryType', operator: 'EQUALS', value: ['SUGGESTION'] }] : []),
    ] });
  }

  async searchSuggestions(input: Page & { category: string; terms?: string[]; query?: string }) {
    return this.query(`suggestions/${input.category}`, { ...input, filters: [
      { field: 'queryType', operator: 'EQUALS', value: ['SEARCH'] },
      { field: input.category === 'phrases' ? 'phrase' : 'category', operator: input.terms ? 'IN' : 'LIKE', value: input.terms ?? [input.query] },
    ] });
  }

  async insights(kind: 'impression-share' | 'search-term-popularity', input: InsightInput) {
    return this.client.request('POST', `insights/apps/${kind}/query`, { adAccountId: input.account_id, body: {
      filters: [...(input.filters ?? []), ...(kind === 'impression-share' ? [{ field: 'promotedObjectId', operator: 'IN', value: [input.promoted_object_id] }] : [])],
      ...(input.sorting?.length ? { sorting: input.sorting } : {}),
      pagination: { offset: input.offset, pageSize: input.limit },
      timeRange: { start: input.start, end: input.end, timeZone: 'UTC', granularity: input.granularity },
      ...(input.fields?.length ? { fields: input.fields } : {}),
      ...(kind === 'impression-share' ? { options: { impressionShareReportType: input.slot } } : {}),
    } });
  }

  async creatives(resource: 'ads' | 'creatives', input: Page & { resource_id?: string }) {
    const response = input.resource_id
      ? await this.client.request<NativeCreative>('GET', `${resource}/${input.resource_id}`, { adAccountId: input.account_id })
      : await this.query<NativeCreative[]>(resource, input);
    const values = Array.isArray(response.result) ? response.result : response.result ? [response.result] : [];
    const linked = new Map<string, NativeCreative>();
    const creativeIds = [...new Set(values.flatMap(value => value.creativeId && !value.creative ? [String(value.creativeId)] : []))];
    if (resource === 'ads' && creativeIds.length) {
      const result = await this.query<NativeCreative[]>('creatives', { account_id: input.account_id, offset: 0, limit: 1000, filters: [{ field: 'id', operator: 'IN', value: creativeIds }] });
      for (const creative of result.result ?? []) {
        if (creative.adAccountId !== undefined && String(creative.adAccountId) !== input.account_id) throw new AdportError('PROVIDER_ERROR', 'apple: linked creative belongs to another account');
        linked.set(String(creative.id), creative);
      }
    }
    const creatives: Creative[] = values.map((value: NativeCreative) => {
      if (value.adAccountId !== undefined && String(value.adAccountId) !== input.account_id) throw new AdportError('PROVIDER_ERROR', 'apple: creative response belongs to another account');
      const args = { account_id: input.account_id, [resource === 'ads' ? 'ad_id' : 'creative_id']: String(value.id) };
      const creative = resource === 'ads' ? value.creative ?? linked.get(String(value.creativeId)) : value;
      const destination = creative?.destination ?? {};
      const adamId = destination.parameters?.adamId;
      const url = destination.url ?? (typeof adamId === 'string' && /^\d+$/.test(adamId) ? `https://apps.apple.com/app/id${adamId}` : undefined);
      return {
        id: String(value.id), provider: 'apple', account_id: input.account_id, name: value.name ?? String(value.id), type: creative?.creativeType ?? (resource === 'ads' ? 'APPLE_AD' : 'APPLE_CREATIVE'),
        status: value.deleted ? 'DELETED' : value.status ?? value.systemStatus, ...(value.campaignId ? { campaign_id: String(value.campaignId) } : {}), ...(value.adGroupId ? { ad_group_id: String(value.adGroupId) } : {}),
        headlines: [], descriptions: Object.entries(creative?.creativeSpec?.localizedText ?? {}).flatMap(([locale, text]) => text.promoText ? [`[${locale}] ${text.promoText}`] : []), landing_urls: safeDestination(url), media: [],
        actions: value.deleted ? [] : [
          ...(resource === 'ads' && value.status && ['PAUSED', 'ENABLED'].includes(value.status) ? [creativeStatusAction('apple_set_ad_status', args, value.status, ['PAUSED', 'ENABLED'])] : []),
          { label: 'Rename', tool: resource === 'ads' ? 'apple_update_ad' : 'apple_update_creative', arguments: args, fields: [{ key: 'name', label: 'Name', type: 'text', value: value.name ?? '', max_length: 255 }] },
          ...(creative?.creativeType === 'LOCAL_ADS_SEARCH_CREATIVE' ? Object.entries(creative.creativeSpec?.localizedText ?? {}).flatMap(([locale, text]) => text.promoText ? [{ label: `Edit ${locale} promo copy`, tool: 'apple_update_brand_creative_copy', arguments: { account_id: input.account_id, creative_id: String(creative.id), locale }, fields: [{ key: 'promo_text', label: `${locale} promotional copy`, type: 'text' as const, value: text.promoText }] }] : []) : []),
        ],
      };
    });
    const total = response.pagination?.totalCount;
    return { ...response, creatives, truncated: !input.resource_id && (total === undefined ? values.length >= input.limit : input.offset + values.length < total) };
  }

  private async owned(accountId: string, collection: string, id: string): Promise<ObjectData> {
    const { result } = await this.client.request<ObjectData>('GET', `${collection}/${id}`, { adAccountId: accountId });
    if (!result || result.deleted || result.systemStatus === 'DELETED' || String(result.id) !== id || (result.adAccountId !== undefined && String(result.adAccountId) !== accountId)) throw new AdportError('INVALID_INPUT', 'apple: resource was not found in the selected ad account');
    return result;
  }

  async plan(op: WriteOperation): Promise<AppleNativePlan> {
    const p = op.payload as ObjectData;
    const collection = op.tool === 'apple_update_ad' ? 'ads' : ['apple_update_creative', 'apple_update_brand_creative_copy'].includes(op.tool) ? 'creatives' : op.tool === 'apple_set_search_match' ? 'adgroups' : collections[String(p.resource_type)];
    if (!collection) throw new AdportError('INVALID_INPUT', 'apple: unsupported resource type');
    const id = String(p.resource_id ?? p.ad_id ?? p.creative_id ?? p.ad_group_id);
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new AdportError('INVALID_INPUT', 'apple: invalid resource ID');
    const current = await this.owned(op.accountId, collection, id);
    let body: ObjectData;
    switch (op.tool) {
      case 'apple_update_targeting': body = { targeting: p.targeting }; break;
      case 'apple_update_ad': body = { name: p.name }; break;
      case 'apple_update_creative': body = { ...(p.name !== undefined ? { name: p.name } : {}), ...(p.creative_spec !== undefined ? { creativeSpec: p.creative_spec } : {}) }; break;
      case 'apple_update_brand_creative_copy': {
        if (current.creativeType !== 'LOCAL_ADS_SEARCH_CREATIVE') throw new AdportError('INVALID_INPUT', 'apple: promotional copy can be edited only on Maps creatives; App Store copy comes from App Store Connect');
        const spec = object(current.creativeSpec), localized = object(spec.localizedText), locale = String(p.locale);
        if (!Object.hasOwn(localized, locale)) throw new AdportError('INVALID_INPUT', 'apple: locale does not exist on this creative; use apple_update_creative to add complete locale configuration');
        body = { creativeSpec: { ...spec, localizedText: { ...localized, [locale]: { ...object(localized[locale]), promoText: p.promo_text } } } }; break;
      }
      case 'apple_set_search_match':
        if (!p.enabled && current.automatedKeywordsRequired) throw new AdportError('INVALID_INPUT', 'apple: this ad group requires automated keywords');
        body = { automatedKeywordsOptIn: p.enabled }; break;
      case 'apple_delete_resource':
        if (collection === 'creatives' && current.creativeType === 'DEFAULT_PRODUCT_PAGE') throw new AdportError('INVALID_INPUT', 'apple: default product-page creatives cannot be deleted; reuse the existing creative or rename it');
        if (collection === 'ads' && current.creativeId !== undefined) {
          const creative = await this.owned(op.accountId, 'creatives', String(current.creativeId));
          if (creative.creativeType === 'DEFAULT_PRODUCT_PAGE') throw new AdportError('INVALID_INPUT', 'apple: ads linked to default product-page creatives cannot be deleted individually; pause the ad or remove its parent ad group');
        }
        body = {}; break;
      default: throw new AdportError('PROVIDER_ERROR', `apple: unsupported native write ${op.tool}`);
    }
    const remove = op.tool === 'apple_delete_resource';
    return {
      summary: `${remove ? 'Delete' : 'Update'} Apple ${collection}/${id} (${current.name ?? current.text ?? id})`,
      changes: remove ? [`- ${collection}/${id} permanently, including any provider-dependent children`] : Object.entries(body).map(([key, value]) => `~ ${key}: ${JSON.stringify(current[key] ?? null)} → ${JSON.stringify(value)}`).concat(collection === 'creatives' && body.creativeSpec !== undefined ? ['Content changes affect ads sharing this creative and may require review.'] : []),
      coercions: [], budgetDeltas: [], execute: async () => {
        await this.client.request(remove ? 'DELETE' : 'PUT', `${collection}/${id}`, { adAccountId: op.accountId, ...(remove ? {} : { body }) });
        return [id];
      },
    };
  }
}

const collections: Record<string, string> = { campaign: 'campaigns', ad_group: 'adgroups', ad: 'ads', creative: 'creatives', keyword: 'keywords', negative_keyword: 'negative-keywords', asset: 'assets', location_group: 'location-groups' };
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeDestination(value: unknown): string[] {
  try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? [url.toString()] : []; } catch { return []; }
}
