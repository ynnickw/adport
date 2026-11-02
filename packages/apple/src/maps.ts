import { AdportError, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import type { z } from 'zod';
import type { AppleAdsClient } from './client.js';
import type { brandCampaignPayload, brandCreativePayload, brandGroupPayload, locationGroupPayload, updateLocationGroupPayload } from './maps-tools.js';
import type { AppleNativePlan } from './native.js';

/** Maps contracts: Apple's journey-apple-maps-brand-ads and v1 Node SDK, 2026-11-03. */
export class AppleMapsService {
  constructor(private readonly client: AppleAdsClient) {}

  private async owned(account: string, collection: string, id: string) {
    const { result } = await this.client.request<Record<string, unknown>>('GET', `${collection}/${id}`, { adAccountId: account });
    if (!result || String(result.id) !== id || (result.adAccountId !== undefined && String(result.adAccountId) !== account) || result.deleted || result.systemStatus === 'DELETED') throw new AdportError('INVALID_INPUT', 'apple: Maps resource was not found in the selected account');
    return result;
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<AppleNativePlan> {
    let collection: string, body: Record<string, unknown>;
    const coercions: string[] = [], budgetDeltas: WritePreview['budgetDeltas'] = [];
    const paused = (status: string) => {
      if (status === 'ENABLED' && guard.forcePausedCreation) { coercions.push('status coerced to PAUSED by policy (paused_creation)'); return 'PAUSED'; }
      return status;
    };
    switch (op.tool) {
      case 'apple_create_brand_campaign': {
        const p = op.payload as z.infer<typeof brandCampaignPayload>;
        await this.owned(op.accountId, 'business-brands', p.brand_id);
        collection = 'campaigns';
        body = { adAccountId: Number(op.accountId), name: p.name, promotedObjectId: p.brand_id, promotedObjectType: 'BUSINESS_BRAND', billingEvent: p.strategy === 'MANUAL_CPM' ? 'IMPRESSIONS' : 'TAPS', status: paused(p.status), dailyBudget: { value: { amount: String(p.daily_budget), currency: p.currency } }, bidStrategy: { bidStrategyType: p.strategy, bidStrategyGoal: p.strategy === 'MANUAL_CPM' ? 'IMPRESSION' : 'TAP' }, targeting: { supplySource: { include: ['MAPS'] }, ...(p.placement ? { supplyPlacement: { include: [p.placement] } } : {}), countryOrRegion: { include: p.countries_or_regions } } };
        budgetDeltas.push({ target: `new Maps campaign "${p.name}" daily budget`, toMicros: p.daily_budget * 1_000_000, currency: p.currency });
        break;
      }
      case 'apple_create_brand_ad_group': {
        const p = op.payload as z.infer<typeof brandGroupPayload>;
        const campaign = await this.owned(op.accountId, 'campaigns', p.campaign_id);
        if (campaign.promotedObjectType !== 'BUSINESS_BRAND') throw new AdportError('INVALID_INPUT', 'apple: this tool requires a Business Brand campaign');
        const strategy = object(campaign.bidStrategy), currency = object(object(campaign.dailyBudget).value).currency;
        if (!['MAX_ENGAGEMENTS', 'MANUAL_CPT', 'MANUAL_CPM'].includes(String(strategy.bidStrategyType)) || typeof currency !== 'string') throw new AdportError('INVALID_INPUT', 'apple: campaign bidding strategy or currency is unavailable');
        const manual = String(strategy.bidStrategyType).startsWith('MANUAL_');
        if (manual !== (p.bid !== undefined)) throw new AdportError('INVALID_INPUT', 'apple: manual bidding requires bid; automated bidding must omit it');
        for (const id of p.location_group_ids) {
          const group = await this.owned(op.accountId, 'location-groups', id);
          if (String(group.brandId) !== String(campaign.promotedObjectId) || group.systemStatus !== 'VALID') throw new AdportError('INVALID_INPUT', 'apple: location groups must belong to the promoted brand and have VALID system status');
        }
        collection = 'adgroups';
        body = { campaignId: Number(p.campaign_id), name: p.name, startTime: p.start_time.replace(/Z$/, ''), status: paused(p.status), pricingModel: campaign.billingEvent === 'IMPRESSIONS' ? 'CPM' : 'CPT', bidStrategy: { bidStrategyType: strategy.bidStrategyType, bidStrategyGoal: strategy.bidStrategyGoal, ...(p.bid !== undefined ? { bid: { amount: String(p.bid), currency } } : {}) }, targeting: { locationGroup: { include: p.location_group_ids } } };
        if (p.bid !== undefined) budgetDeltas.push({ target: `new Maps ad group "${p.name}" bid`, toMicros: p.bid * 1_000_000, currency });
        break;
      }
      case 'apple_create_brand_creative': {
        const p = op.payload as z.infer<typeof brandCreativePayload>;
        await this.owned(op.accountId, 'business-brands', p.brand_id);
        for (const id of p.asset_ids) {
          const asset = await this.owned(op.accountId, 'assets', id);
          if (String(asset.promotedObjectId) !== p.brand_id || asset.promotedObjectType !== 'BUSINESS_BRAND') throw new AdportError('INVALID_INPUT', 'apple: creative assets must belong to the selected brand');
        }
        collection = 'creatives';
        body = { name: p.name, creativeType: 'LOCAL_ADS_SEARCH_CREATIVE', creativeSpec: { brandId: p.brand_id, creativeSubtype: p.subtype, creativeAssets: p.asset_ids.map(assetId => ({ assetId })), localizedText: p.localized_text, defaultLocale: p.default_locale }, destination: { destinationType: 'LOCAL_ADS_PLACECARD' } };
        break;
      }
      case 'apple_create_location_group': {
        const p = op.payload as z.infer<typeof locationGroupPayload>;
        await this.owned(op.accountId, 'business-brands', p.brand_id);
        for (const id of p.location_ids ?? []) {
          const location = await this.owned(op.accountId, 'locations', id);
          if (String(location.brandId) !== p.brand_id) throw new AdportError('INVALID_INPUT', 'apple: locations must belong to the selected brand');
        }
        collection = 'location-groups';
        body = { adAccountId: op.accountId, brandId: p.brand_id, name: p.name, groupType: p.group_type, ...(p.location_ids ? { locationIds: p.location_ids } : {}), ...(p.rules ? { rules: p.rules } : {}), ...(p.description !== undefined ? { description: p.description } : {}) };
        break;
      }
      case 'apple_update_location_group': {
        const p = op.payload as z.infer<typeof updateLocationGroupPayload>;
        const group = await this.owned(op.accountId, 'location-groups', p.location_group_id);
        if ((p.location_ids && group.groupType !== 'STATIC') || (p.rules && group.groupType !== 'DYNAMIC')) throw new AdportError('INVALID_INPUT', 'apple: membership fields must match the existing location group type');
        for (const id of p.location_ids ?? []) {
          const location = await this.owned(op.accountId, 'locations', id);
          if (String(location.brandId) !== String(group.brandId)) throw new AdportError('INVALID_INPUT', 'apple: locations must belong to the selected brand');
        }
        const update = { ...(p.name !== undefined ? { name: p.name } : {}), ...(p.description !== undefined ? { description: p.description } : {}), ...(p.location_ids ? { locationIds: p.location_ids } : {}), ...(p.rules ? { rules: p.rules } : {}) };
        return { summary: `Update Apple location group ${p.location_group_id}`, changes: Object.entries(update).map(([field, value]) => `~ ${field}: ${JSON.stringify(group[field] ?? null)} → ${JSON.stringify(value)}`), budgetDeltas, coercions, execute: async () => { await this.client.request('PUT', `location-groups/${p.location_group_id}`, { adAccountId: op.accountId, body: update }); return [p.location_group_id]; } };
      }
      default: throw new AdportError('PROVIDER_ERROR', `apple: unsupported Maps tool ${op.tool}`);
    }
    return { summary: `Create Apple Maps ${collection}: ${body.name}`, changes: [`+ POST /${collection} ${JSON.stringify(body)}`], budgetDeltas, coercions, execute: async () => {
      const { result } = await this.client.request<{ id?: number | string }>('POST', collection, { adAccountId: op.accountId, body });
      if (result?.id === undefined) throw new AdportError('PROVIDER_ERROR', 'apple: creation returned no resource ID; inspect configuration before retrying');
      return [String(result.id)];
    } };
  }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
