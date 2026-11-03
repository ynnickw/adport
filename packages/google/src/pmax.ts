import { createHash } from 'node:crypto';
import { AdportError, creativeStatusAction, creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';
import type { GoogleAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute: (validateOnly: boolean) => Promise<string[]> };
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const id = z.string().regex(/^[1-9]\d*$/), hash = z.string().regex(/^[a-f0-9]{64}$/), name = z.string().trim().min(1).max(128);
const url = z.string().url().refine(value => { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; });
const fieldType = z.enum(['HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO', 'YOUTUBE_VIDEO']);
const textType = z.enum(['HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME']);
const asset = z.union([z.object({ field_type: fieldType, asset_id: id }).strict(), z.object({ field_type: textType, text: z.string().min(1).max(2048) }).strict()]);
const assetKey = z.object({ field_type: fieldType, asset_id: id }).strict();
const level = z.enum(['LEVEL1', 'LEVEL2', 'LEVEL3', 'LEVEL4', 'LEVEL5']);
const dimension = z.discriminatedUnion('dimension', [
  z.object({ dimension: z.literal('product_brand'), value: z.string().max(1000).optional() }).strict(),
  z.object({ dimension: z.literal('product_item_id'), value: z.string().max(1000).optional() }).strict(),
  z.object({ dimension: z.literal('product_category'), category_id: id.optional(), level }).strict(),
  z.object({ dimension: z.literal('product_type'), value: z.string().max(1000).optional(), level }).strict(),
  z.object({ dimension: z.literal('product_custom_attribute'), value: z.string().max(1000).optional(), index: z.enum(['INDEX0', 'INDEX1', 'INDEX2', 'INDEX3', 'INDEX4']) }).strict(),
  z.object({ dimension: z.literal('product_channel'), channel: z.enum(['ONLINE', 'LOCAL']).optional() }).strict(),
  z.object({ dimension: z.literal('product_condition'), condition: z.enum(['NEW', 'USED', 'REFURBISHED']).optional() }).strict(),
]);
const filterNode = z.object({ key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/), parent_key: z.string().optional(), type: z.enum(['SUBDIVISION', 'UNIT_INCLUDED', 'UNIT_EXCLUDED']), case_value: dimension.optional() }).strict();
const signal = z.discriminatedUnion('type', [z.object({ type: z.literal('AUDIENCE'), audience_id: id }).strict(), z.object({ type: z.literal('SEARCH_THEME'), text: z.string().trim().min(1).max(2000) }).strict()]);
const groupSettings = { name: name.optional(), final_urls: z.array(url).max(10).optional(), final_mobile_urls: z.array(url).max(10).optional(), path1: z.string().max(15).optional(), path2: z.string().max(15).optional(), tracking_url_template: z.string().max(2048).optional(), final_url_suffix: z.string().max(2048).optional(), url_custom_parameters: z.array(z.object({ key: z.string().min(1).max(16), value: z.string().max(200) }).strict()).max(8).optional() };
const groupCreate = z.object({ ...groupSettings, name, status: z.enum(['PAUSED', 'ENABLED']).default('PAUSED'), assets: z.array(asset).max(120), signals: z.array(signal).max(100).default([]), listing_filters: z.array(filterNode).min(1).max(1000).optional() }).strict();
const campaignCreate = z.object({ name, daily_budget_micros: z.number().int().positive().safe(), status: z.enum(['PAUSED', 'ENABLED']).default('PAUSED'), bidding: z.discriminatedUnion('strategy', [z.object({ strategy: z.literal('MAXIMIZE_CONVERSIONS'), target_cpa_micros: z.number().int().positive().safe().optional() }).strict(), z.object({ strategy: z.literal('MAXIMIZE_CONVERSION_VALUE'), target_roas: z.number().finite().positive().optional() }).strict()]), merchant: z.object({ merchant_id: id, feed_label: z.string().min(1).max(100).optional() }).strict().optional(), brand_guidelines: z.object({ main_color: z.string().regex(/^#[a-fA-F0-9]{6}$/), accent_color: z.string().regex(/^#[a-fA-F0-9]{6}$/), predefined_font_family: z.enum(['Open Sans', 'Roboto', 'Montserrat', 'Poppins', 'Lato', 'Oswald', 'Playfair Display', 'Roboto Slab']).optional() }).strict().optional(), allow_final_url_expansion: z.boolean().default(false), location_ids: z.array(id).max(100).default([]), language_ids: z.array(id).max(100).default([]), contains_eu_political_advertising: z.enum(['CONTAINS_EU_POLITICAL_ADVERTISING', 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING']).default('DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'), asset_group: groupCreate }).strict();
const groupRef = { asset_group_id: id, expected_group_hash: hash };
const groupUpdate = z.object({ ...groupRef, ...groupSettings }).strict().refine(value => Object.entries(value).some(([key, item]) => !['asset_group_id', 'expected_group_hash'].includes(key) && item !== undefined), 'Supply asset-group metadata to update');
const copyUpdate = z.object({ asset_group_id: id, expected_assets_hash: hash, headlines: z.array(z.string().min(1).max(2048)).min(3).max(15).optional(), long_headlines: z.array(z.string().min(1).max(2048)).min(1).max(5).optional(), descriptions: z.array(z.string().min(1).max(2048)).min(2).max(5).optional() }).strict().refine(value => value.headlines || value.long_headlines || value.descriptions, 'Supply text copy to replace');
const assetsUpdate = z.object({ asset_group_id: id, expected_assets_hash: hash, add: z.array(asset).max(120).default([]), remove: z.array(assetKey).max(120).default([]) }).strict().refine(value => value.add.length + value.remove.length > 0, 'Supply asset links to add or remove');
const brandUpdate = z.object({ campaign_id: id, expected_campaign_hash: hash, add: z.array(asset).max(30).default([]), remove: z.array(assetKey).max(30).default([]) }).strict().refine(value => value.add.length + value.remove.length > 0 && [...value.add, ...value.remove].every(value => ['BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO'].includes(value.field_type)), 'Supply campaign brand placements to add or remove');
const signalsAdd = z.object({ asset_group_id: id, expected_signals_hash: hash, signals: z.array(signal).min(1).max(100) }).strict();
const signalsRemove = z.object({ asset_group_id: id, expected_signals_hash: hash, signal_ids: z.array(id).min(1).max(100) }).strict();
const listingReplace = z.object({ asset_group_id: id, expected_listing_hash: hash, listing_filters: z.array(filterNode).min(1).max(1000) }).strict();
const campaignFields = 'campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.brand_guidelines_enabled, campaign.shopping_setting.merchant_id, campaign.shopping_setting.feed_label, campaign.asset_automation_settings, campaign.campaign_budget, campaign.bidding_strategy_type, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared';
const groupFields = 'asset_group.resource_name, asset_group.id, asset_group.campaign, asset_group.name, asset_group.status, asset_group.final_urls, asset_group.final_mobile_urls, asset_group.path1, asset_group.path2, asset_group.primary_status, asset_group.primary_status_reasons, asset_group.ad_strength, asset_group.tracking_url_template, asset_group.final_url_suffix, asset_group.url_custom_parameters';
const assetFields = 'asset.resource_name, asset.id, asset.type, asset.name, asset.text_asset.text, asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels, asset.youtube_video_asset.youtube_video_id';
const linkFields = 'asset_group_asset.resource_name, asset_group_asset.asset_group, asset_group_asset.asset, asset_group_asset.field_type, asset_group_asset.status, asset_group_asset.primary_status, asset_group_asset.policy_summary.approval_status';
const signalFields = 'asset_group_signal.resource_name, asset_group_signal.asset_group, asset_group_signal.audience.audience, asset_group_signal.search_theme.text, asset_group_signal.approval_status, asset_group_signal.disapproval_reasons';
const filterFields = 'asset_group_listing_group_filter.resource_name, asset_group_listing_group_filter.id, asset_group_listing_group_filter.asset_group, asset_group_listing_group_filter.type, asset_group_listing_group_filter.listing_source, asset_group_listing_group_filter.parent_listing_group_filter, ' + ['product_category.category_id', 'product_category.level', 'product_brand.value', 'product_channel.channel', 'product_condition.condition', 'product_custom_attribute.value', 'product_custom_attribute.index', 'product_item_id.value', 'product_type.value', 'product_type.level', 'webpage.conditions', 'retail_filter_bundle.shared_set'].map(value => `asset_group_listing_group_filter.case_value.${value}`).join(', ');
const camel = (key: string) => key.replace(/_([a-z])/g, (_match, c: string) => c.toUpperCase());
const fields = (value: Row): Row => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [camel(key), item]));
function sorted(value: unknown): unknown { return Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value; }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
const kinds = { google_create_performance_max_campaign: 'create', google_create_asset_group: 'create', google_update_asset_group: 'update', google_set_asset_group_status: 'update', google_remove_asset_group: 'remove', google_update_asset_group_assets: 'update', google_update_asset_group_copy: 'update', google_update_performance_max_brand_assets: 'update', google_add_asset_group_signals: 'create', google_remove_asset_group_signals: 'remove', google_replace_asset_group_listing_filters: 'update' } as const;
export const GOOGLE_PMAX_WRITES = new Set(Object.keys(kinds));
const brandTypes = new Set(['BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO']);

/** Official v25 resource/service contracts, discovery, and native GAQL checked 2026-11-04. */
export class GooglePerformanceMaxService {
  constructor(private readonly client: GoogleAdsRestClient) {}
  private resource(account: string, service: string, value: string) { return `customers/${account}/${service}/${id.parse(value)}`; }
  private async customer(account: string) {
    const rows = await this.client.search(account, 'SELECT customer.resource_name, customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2', { maxRows: 2 }), value = row(rows[0]?.customer);
    if (rows.length !== 1 || value.id !== account || value.resourceName !== `customers/${account}` || typeof value.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(value.currencyCode) || typeof value.timeZone !== 'string') throw new AdportError('PROVIDER_ERROR', 'google: invalid Performance Max customer context');
    return value;
  }
  private group(value: unknown, account: string): Row {
    const group = row(value);
    if (!id.safeParse(group.id).success || group.resourceName !== this.resource(account, 'assetGroups', String(group.id)) || typeof group.campaign !== 'string' || !new RegExp(`^customers/${account}/campaigns/[1-9]\\d*$`).test(group.campaign) || typeof group.name !== 'string' || !['PAUSED', 'ENABLED', 'REMOVED'].includes(String(group.status))) throw new AdportError('PROVIDER_ERROR', 'google: invalid asset-group identity or status');
    return group;
  }
  async campaignContext(input: { account_id: string; campaign_id: string }) {
    const account = normalizeCustomerId(input.account_id), customer = await this.customer(account), resource = this.resource(account, 'campaigns', input.campaign_id);
    const rows = await this.client.search(account, `SELECT ${campaignFields} FROM campaign WHERE campaign.resource_name = '${resource}' LIMIT 2`, { maxRows: 2, includeDrafts: true }), campaign = row(rows[0]?.campaign), budget = row(rows[0]?.campaignBudget);
    if (rows.length !== 1 || campaign.resourceName !== resource || campaign.id !== input.campaign_id || campaign.advertisingChannelType !== 'PERFORMANCE_MAX' || campaign.status === 'REMOVED' || campaign.campaignBudget !== budget.resourceName || !new RegExp(`^customers/${account}/campaignBudgets/[1-9]\\d*$`).test(String(budget.resourceName))) throw new AdportError('INVALID_INPUT', 'google: an available Performance Max campaign with an owned budget is required');
    const brands = await this.client.search(account, `SELECT campaign.id, campaign_asset.resource_name, campaign_asset.campaign, campaign_asset.asset, campaign_asset.field_type, campaign_asset.status, ${assetFields} FROM campaign_asset WHERE campaign_asset.campaign = '${resource}' AND campaign_asset.field_type IN ('BUSINESS_NAME','LOGO','LANDSCAPE_LOGO') AND campaign_asset.status != 'REMOVED' LIMIT 101`, { maxRows: 101, includeDrafts: true });
    if (brands.length > 100) throw new AdportError('PROVIDER_ERROR', 'google: complete campaign brand context exceeds the read bound');
    const brandAssets = brands.map(value => { const link = row(value.campaignAsset), asset = row(value.asset); this.assetIdentity(asset, account); if (link.campaign !== resource || link.asset !== asset.resourceName || !brandTypes.has(String(link.fieldType)) || link.resourceName !== `customers/${account}/campaignAssets/${input.campaign_id}~${asset.id}~${link.fieldType}`) throw new AdportError('PROVIDER_ERROR', 'google: campaign brand asset ownership mismatch'); return { link, asset }; }).sort((a, b) => String(a.link.resourceName).localeCompare(String(b.link.resourceName)));
    return { account: customer, campaign, budget, brand_assets: brandAssets, campaign_snapshot_hash: digest({ customer, campaign, budget, brandAssets }), note: 'Hashes cover returned campaign/group configuration, not performance or every campaign criterion. Native validation remains authoritative; Google has no atomic compare-and-set. Existing media assets are reused without downloading their bytes.' };
  }
  private assetIdentity(asset: Row, account: string) {
    if (!id.safeParse(asset.id).success || asset.resourceName !== this.resource(account, 'assets', String(asset.id)) || typeof asset.type !== 'string') throw new AdportError('PROVIDER_ERROR', 'google: asset ownership or identity mismatch');
  }
  async list(input: { account_id: string; campaign_id: string; limit: number; after_asset_group_id?: string; include_removed?: boolean }) {
    const account = normalizeCustomerId(input.account_id), campaign = this.resource(account, 'campaigns', input.campaign_id), predicates = [`asset_group.campaign = '${campaign}'`, ...(!input.include_removed ? ["asset_group.status != 'REMOVED'"] : []), ...(input.after_asset_group_id ? [`asset_group.id > ${id.parse(input.after_asset_group_id)}`] : [])];
    const rows = await this.client.search(account, `SELECT ${groupFields} FROM asset_group WHERE ${predicates.join(' AND ')} ORDER BY asset_group.id ASC LIMIT ${input.limit + 1}`, { maxRows: input.limit + 1, includeDrafts: true }), groups = rows.map(value => this.group(value.assetGroup, account));
    if (groups.some((value, index) => value.campaign !== campaign || BigInt(String(value.id)) <= BigInt(index ? String(groups[index - 1]!.id) : input.after_asset_group_id ?? '0'))) throw new AdportError('PROVIDER_ERROR', 'google: asset-group continuation or campaign scope mismatch');
    return { asset_groups: groups.slice(0, input.limit), truncated: groups.length > input.limit, ...(groups.length > input.limit ? { next_cursor: String(groups[input.limit - 1]!.id) } : {}) };
  }
  async context(input: { account_id: string; asset_group_id: string }) {
    const account = normalizeCustomerId(input.account_id), resource = this.resource(account, 'assetGroups', input.asset_group_id), rows = await this.client.search(account, `SELECT ${groupFields} FROM asset_group WHERE asset_group.resource_name = '${resource}' LIMIT 2`, { maxRows: 2, includeDrafts: true });
    if (rows.length !== 1) throw new AdportError('INVALID_INPUT', 'google: asset group was not available in this account');
    const group = this.group(rows[0]?.assetGroup, account);
    if (group.resourceName !== resource) throw new AdportError('PROVIDER_ERROR', 'google: asset-group selection mismatch');
    const campaign = await this.campaignContext({ account_id: account, campaign_id: String(group.campaign).split('/').at(-1)! });
    const [links, signals, filters] = await Promise.all([
      this.client.search(account, `SELECT ${linkFields}, ${assetFields} FROM asset_group_asset WHERE asset_group_asset.asset_group = '${resource}' AND asset_group_asset.status != 'REMOVED' LIMIT 501`, { maxRows: 501, includeDrafts: true }),
      this.client.search(account, `SELECT ${signalFields} FROM asset_group_signal WHERE asset_group_signal.asset_group = '${resource}' LIMIT 1001`, { maxRows: 1001, includeDrafts: true }),
      this.client.search(account, `SELECT ${filterFields} FROM asset_group_listing_group_filter WHERE asset_group_listing_group_filter.asset_group = '${resource}' LIMIT 1001`, { maxRows: 1001, includeDrafts: true }),
    ]);
    if (links.length > 500 || signals.length > 1000 || filters.length > 1000) throw new AdportError('INVALID_INPUT', 'google: complete asset-group context exceeds the read bound');
    const assets = links.map(value => { const link = row(value.assetGroupAsset), asset = row(value.asset); this.assetIdentity(asset, account); if (link.assetGroup !== resource || link.asset !== asset.resourceName || link.resourceName !== `customers/${account}/assetGroupAssets/${input.asset_group_id}~${asset.id}~${link.fieldType}` || !['ENABLED', 'PAUSED'].includes(String(link.status))) throw new AdportError('PROVIDER_ERROR', 'google: asset-group link identity or status mismatch'); return { link, asset }; }).sort((a, b) => String(a.link.resourceName).localeCompare(String(b.link.resourceName)));
    const owned = (values: Row[], key: string, service: string) => values.map(value => { const item = row(value[key]); if (item.assetGroup !== resource || !new RegExp(`^customers/${account}/${service}/${input.asset_group_id}~[1-9]\\d*$`).test(String(item.resourceName))) throw new AdportError('PROVIDER_ERROR', 'google: signal/filter ownership mismatch'); return item; }).sort((a, b) => String(a.resourceName).localeCompare(String(b.resourceName)));
    const nativeSignals = owned(signals, 'assetGroupSignal', 'assetGroupSignals'), listing = owned(filters, 'assetGroupListingGroupFilter', 'assetGroupListingGroupFilters'), groupHash = digest({ parent: campaign.campaign_snapshot_hash, group });
    if (new Set(assets.map(value => value.link.resourceName)).size !== assets.length || new Set(nativeSignals.map(value => value.resourceName)).size !== nativeSignals.length || new Set(listing.map(value => value.resourceName)).size !== listing.length) throw new AdportError('PROVIDER_ERROR', 'google: duplicate asset-group configuration rows');
    return { ...campaign, asset_group: group, assets, signals: nativeSignals, listing_filters: listing, group_snapshot_hash: groupHash, assets_snapshot_hash: digest({ groupHash, assets }), signals_snapshot_hash: digest({ groupHash, signals: nativeSignals }), listing_snapshot_hash: digest({ groupHash, filters: listing }) };
  }
  async creatives(input: { account_id: string; asset_group_id: string }) {
    const context = await this.context(input), group = context.asset_group, account = normalizeCustomerId(input.account_id);
    const texts = (type: string) => context.assets.filter(value => value.link.fieldType === type).map(value => row(value.asset.textAsset).text).filter((value): value is string => typeof value === 'string');
    const media = context.assets.flatMap(value => { const image = row(row(value.asset.imageAsset).fullSize), candidate = image.url; if (typeof candidate !== 'string') return []; try { const u = new URL(candidate); return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'tpc.googlesyndication.com' || u.hostname.endsWith('.googleusercontent.com')) ? [{ type: 'image' as const, url: candidate }] : []; } catch { return []; } });
    return creativesOutput.parse({ truncated: false, creatives: [{ id: input.asset_group_id, provider: 'google', account_id: account, campaign_id: String(context.campaign.id), name: String(group.name), type: 'PERFORMANCE_MAX_ASSET_GROUP', status: String(group.status), headlines: texts('HEADLINE'), descriptions: [...texts('LONG_HEADLINE'), ...texts('DESCRIPTION')], landing_urls: array(group.finalUrls).filter((value): value is string => url.safeParse(value).success), media, actions: group.status === 'REMOVED' ? [] : [creativeStatusAction('google_set_asset_group_status', { account_id: account, asset_group_id: input.asset_group_id, expected_group_hash: context.group_snapshot_hash }, String(group.status), ['ENABLED', 'PAUSED']), { label: 'Edit group copy', tool: 'google_update_asset_group_copy', arguments: { account_id: account, asset_group_id: input.asset_group_id, expected_assets_hash: context.assets_snapshot_hash }, fields: [{ key: 'headlines', label: 'Headlines (one per line)', type: 'text_list', value: texts('HEADLINE') }, { key: 'long_headlines', label: 'Long headlines (one per line)', type: 'text_list', value: texts('LONG_HEADLINE') }, { key: 'descriptions', label: 'Descriptions (one per line)', type: 'text_list', value: texts('DESCRIPTION') }] }] }] });
  }
  private atomic(account: string, operations: Row[], summary: string, changes: string[], coercions: string[] = [], budgetDeltas: WritePreview['budgetDeltas'] = []): Plan {
    return { summary, changes, coercions, budgetDeltas, notes: ['Native validateOnly checks the entire atomic request. Google checks placement eligibility, language-aware text lengths, image ratios, asset minimums and product-feed access.', 'Existing assets and links are re-read at preview/apply. Hashes are not an atomic native lock. No request is automatically retried; reconcile acknowledged IDs if a response is incomplete.', 'Asset association/content changes can affect serving creative combinations. Existing campaign/group statuses and budgets are preserved unless explicitly included in this operation.'], execute: async validateOnly => {
      const result = await this.client.googleAdsMutate(account, operations, { validateOnly });
      if (validateOnly) return [];
      const responses = result.mutateOperationResponses;
      const resources = responses?.map(value => Object.values(value).map(value => value.resourceName));
      const services: Record<string, string> = { assetOperation: 'assets', campaignBudgetOperation: 'campaignBudgets', campaignOperation: 'campaigns', campaignAssetOperation: 'campaignAssets', campaignCriterionOperation: 'campaignCriteria', assetGroupOperation: 'assetGroups', assetGroupAssetOperation: 'assetGroupAssets', assetGroupSignalOperation: 'assetGroupSignals', assetGroupListingGroupFilterOperation: 'assetGroupListingGroupFilters' };
      if (!resources || resources.length !== operations.length || resources.some((values, index) => {
        const [type, raw] = Object.entries(operations[index]!)[0]!, operation = row(raw), target = row(operation.update).resourceName ?? operation.remove, service = services[type];
        return values.length !== 1 || typeof values[0] !== 'string' || !service || !new RegExp(`^customers/${account}/${service}/[1-9]\\d*(?:~[1-9]\\d*)?(?:~[A-Z_]+)?$`).test(values[0]) || target !== undefined && target !== values[0];
      })) throw new AdportError('PROVIDER_ERROR', 'google: Performance Max atomic acknowledgement was not confirmed; reconcile before another mutation', { resource_ids: resources?.flat().filter(value => typeof value === 'string') ?? [] });
      return resources.flat() as string[];
    } };
  }
  private async resolveAssets(account: string, input: z.infer<typeof asset>[]) {
    const ids = [...new Set(input.flatMap(value => 'asset_id' in value ? [value.asset_id] : []))], native = new Map<string, Row>();
    if (ids.length) {
      const rows = await this.client.search(account, `SELECT ${assetFields} FROM asset WHERE asset.id IN (${ids.join(',')}) LIMIT ${ids.length + 1}`, { maxRows: ids.length + 1 });
      for (const value of rows) { const item = row(value.asset); this.assetIdentity(item, account); if (!ids.includes(String(item.id)) || native.has(String(item.id))) throw new AdportError('PROVIDER_ERROR', 'google: asset selection returned unexpected or duplicate IDs'); native.set(String(item.id), item); }
      if (native.size !== ids.length) throw new AdportError('INVALID_INPUT', 'google: all supplied assets must be available in the selected account');
    }
    const operations: Row[] = [], textResources = new Map<string, string>();
    const assets = input.map(value => {
      let item: Row;
      if ('asset_id' in value) item = native.get(value.asset_id)!;
      else {
        let resource = textResources.get(value.text);
        if (!resource) { resource = `customers/${account}/assets/-${textResources.size + 1}`; textResources.set(value.text, resource); operations.push({ assetOperation: { create: { resourceName: resource, textAsset: { text: value.text } } } }); }
        item = { resourceName: resource, type: 'TEXT', textAsset: { text: value.text } };
      }
      const expectedType = textType.safeParse(value.field_type).success ? 'TEXT' : value.field_type === 'YOUTUBE_VIDEO' ? 'YOUTUBE_VIDEO' : 'IMAGE';
      if (item.type !== expectedType) throw new AdportError('INVALID_INPUT', `google: ${value.field_type} requires ${expectedType}, not the selected asset type`);
      return { link: { fieldType: value.field_type, asset: item.resourceName, status: 'ENABLED' } as Row, asset: item };
    });
    if (new Set(assets.map(value => `${value.link.fieldType}:${value.link.asset}`)).size !== assets.length) throw new AdportError('INVALID_INPUT', 'google: duplicate asset and placement');
    return { assets, operations };
  }
  private requirements(groupAssets: { link: Row; asset: Row }[], brands: { link: Row; asset: Row }[], brandGuidelines: boolean, retail: boolean, finalUrls: unknown) {
    if (retail && groupAssets.every(value => value.asset.type === 'MEDIA_BUNDLE')) return;
    if (!array(finalUrls).length) throw new AdportError('INVALID_INPUT', 'google: custom asset groups need at least one final URL, including retail campaigns');
    const count = (values: { link: Row }[], type: string) => values.filter(value => value.link.fieldType === type).length;
    for (const [type, min, max] of [['HEADLINE', 3, 15], ['LONG_HEADLINE', 1, 5], ['DESCRIPTION', 2, 5], ['MARKETING_IMAGE', 1, 20], ['SQUARE_MARKETING_IMAGE', 1, 20], ['PORTRAIT_MARKETING_IMAGE', 0, 20], ['YOUTUBE_VIDEO', 0, 5]] as const) {
      const size = count(groupAssets, type);
      if (size < min || size > max) throw new AdportError('INVALID_INPUT', `google: ${type} needs ${min}–${max} linked assets in the final atomic set`);
    }
    const branding = brandGuidelines ? brands : groupAssets;
    if (count(branding, 'BUSINESS_NAME') !== 1 || count(branding, 'LOGO') < 1 || count(branding, 'LOGO') > 5) throw new AdportError('INVALID_INPUT', `google: exactly one BUSINESS_NAME and one to five LOGO assets are required at ${brandGuidelines ? 'campaign' : 'asset-group'} level`);
    if (brandGuidelines && groupAssets.some(value => brandTypes.has(String(value.link.fieldType)))) throw new AdportError('INVALID_INPUT', 'google: brand-guidelines campaigns require brand assets at campaign level');
  }
  private groupWire(value: Row): Row {
    const result = fields(value), path1 = result.path1, path2 = result.path2;
    if (path2 && !path1) throw new AdportError('INVALID_INPUT', 'google: path2 requires path1');
    if (Array.isArray(value.url_custom_parameters)) result.urlCustomParameters = value.url_custom_parameters;
    return result;
  }
  private async signalOperations(account: string, group: string, values: z.infer<typeof signal>[]) {
    if (new Set(values.map(value => JSON.stringify(value))).size !== values.length) throw new AdportError('INVALID_INPUT', 'google: duplicate signals');
    for (const audienceId of new Set(values.flatMap(value => value.type === 'AUDIENCE' ? [value.audience_id] : []))) {
      const resource = this.resource(account, 'audiences', audienceId), rows = await this.client.search(account, `SELECT audience.resource_name, audience.status FROM audience WHERE audience.resource_name = '${resource}' LIMIT 2`, { maxRows: 2 });
      if (rows.length !== 1 || row(rows[0]?.audience).resourceName !== resource || row(rows[0]?.audience).status !== 'ENABLED') throw new AdportError('INVALID_INPUT', 'google: signal audience must be an available account-owned audience');
    }
    return values.map(value => ({ assetGroupSignalOperation: { create: { assetGroup: group, ...(value.type === 'AUDIENCE' ? { audience: { audience: this.resource(account, 'audiences', value.audience_id) } } : { searchTheme: { text: value.text } }) } } }));
  }
  private listingOperations(account: string, group: string, values: z.infer<typeof filterNode>[]) {
    const byKey = new Map(values.map(value => [value.key, value]));
    if (byKey.size !== values.length || values.filter(value => !value.parent_key).length !== 1) throw new AdportError('INVALID_INPUT', 'google: shopping listing tree requires unique keys and one root');
    const ordered: z.infer<typeof filterNode>[] = [], visiting = new Set<string>(), visited = new Set<string>();
    const visit = (node: z.infer<typeof filterNode>) => {
      if (visiting.has(node.key)) throw new AdportError('INVALID_INPUT', 'google: cycle in listing filters');
      if (visited.has(node.key)) return;
      visiting.add(node.key);
      if (node.parent_key) { const parent = byKey.get(node.parent_key); if (!parent || parent.type !== 'SUBDIVISION' || !node.case_value) throw new AdportError('INVALID_INPUT', 'google: child listing filter requires a subdivision parent and case value'); visit(parent); }
      else if (node.case_value) throw new AdportError('INVALID_INPUT', 'google: shopping root has no case value');
      visiting.delete(node.key); visited.add(node.key); ordered.push(node);
    };
    for (const value of values) visit(value);
    for (const value of values) {
      const children = values.filter(child => child.parent_key === value.key);
      if (value.type !== 'SUBDIVISION' && children.length || value.type === 'SUBDIVISION' && children.length < 2) throw new AdportError('INVALID_INPUT', 'google: subdivision needs explicit and other children; units cannot have children');
      if (!children.length) continue;
      const dimensions = children.map(child => { const c = child.case_value!; return JSON.stringify([c.dimension, 'level' in c ? c.level : null, 'index' in c ? c.index : null]); });
      const cases = children.map(child => JSON.stringify(sorted(child.case_value)));
      const other = children.filter(child => { const c = child.case_value!; return !Object.keys(c).some(key => ['value', 'category_id', 'channel', 'condition'].includes(key)); });
      if (new Set(dimensions).size !== 1 || new Set(cases).size !== cases.length || other.length !== 1) throw new AdportError('INVALID_INPUT', 'google: siblings require one dimension/level, distinct cases and exactly one other case');
    }
    const groupId = group.split('/').at(-1)!, names = new Map(ordered.map((value, index) => [value.key, `customers/${account}/assetGroupListingGroupFilters/${groupId}~-${20000 + index}`]));
    return ordered.map(value => { const c = value.case_value, nativeCase = c ? { [camel(c.dimension)]: fields(Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'dimension'))) } : undefined; return { assetGroupListingGroupFilterOperation: { create: { resourceName: names.get(value.key), assetGroup: group, type: value.type, listingSource: 'SHOPPING', ...(value.parent_key ? { parentListingGroupFilter: names.get(value.parent_key) } : {}), ...(nativeCase ? { caseValue: nativeCase } : {}) } } }; });
  }
  private groupOperations(account: string, group: string, campaign: string, input: z.infer<typeof groupCreate>, assets: { link: Row; asset: Row }[], status: string) {
    const { assets: _assets, signals: _signals, listing_filters: _filters, status: _status, ...settings } = input;
    return [{ assetGroupOperation: { create: { resourceName: group, campaign, ...this.groupWire(settings), status } } }, ...assets.map(value => ({ assetGroupAssetOperation: { create: { assetGroup: group, asset: value.link.asset, fieldType: value.link.fieldType, status: 'ENABLED' } } }))];
  }
  private createdStatus(value: string, guard: WriteGuard, target: string, coercions: string[]) {
    if (guard.forcePausedCreation && value !== 'PAUSED') { coercions.push(`${target} status coerced to PAUSED by policy (paused_creation)`); return 'PAUSED'; }
    return value;
  }
  private verifyCreation(plan: Plan, account: string, expectedName: string, groupName: string, groupStatus: string, expectedCampaign?: string, campaignStatus?: string): Plan {
    return { ...plan, execute: async validateOnly => {
      const ids = await plan.execute(validateOnly);
      if (validateOnly) return [];
      const group = ids.find(value => new RegExp(`^customers/${account}/assetGroups/[1-9]\\d*$`).test(value));
      const campaign = expectedCampaign ?? ids.find(value => new RegExp(`^customers/${account}/campaigns/[1-9]\\d*$`).test(value));
      try {
        if (!group || !campaign) throw new Error('missing campaign/group receipt');
        const current = await this.context({ account_id: account, asset_group_id: group.split('/').at(-1)! });
        if (current.asset_group.resourceName !== group || current.asset_group.campaign !== campaign || current.asset_group.name !== groupName || current.asset_group.status !== groupStatus || current.campaign.name !== expectedName || campaignStatus && current.campaign.status !== campaignStatus) throw new Error('created group/parent state differs from the approved plan');
      } catch { throw new AdportError('PROVIDER_ERROR', 'google: creation was acknowledged but readback could not confirm the approved campaign/group. Reconcile these IDs before another create; nothing was automatically retried.', { resource_ids: ids }); }
      return ids;
    } };
  }
  private async createCampaign(account: string, input: z.infer<typeof campaignCreate>, guard: WriteGuard): Promise<Plan> {
    const customer = await this.customer(account), resolved = await this.resolveAssets(account, input.asset_group.assets), brandAssets = resolved.assets.filter(value => brandTypes.has(String(value.link.fieldType))), groupAssets = resolved.assets.filter(value => !brandTypes.has(String(value.link.fieldType))), retail = Boolean(input.merchant);
    this.requirements(groupAssets, brandAssets, true, retail, input.asset_group.final_urls);
    if (Boolean(input.asset_group.listing_filters) !== retail) throw new AdportError('INVALID_INPUT', 'google: retail campaigns require a SHOPPING product listing tree; non-retail campaigns must omit it');
    const budget = `customers/${account}/campaignBudgets/-10001`, campaign = `customers/${account}/campaigns/-10002`, group = `customers/${account}/assetGroups/-10003`, coercions: string[] = [];
    const status = this.createdStatus(input.status, guard, 'Campaign', coercions), groupStatus = this.createdStatus(input.asset_group.status, guard, 'Asset group', coercions);
    const bidding = input.bidding.strategy === 'MAXIMIZE_CONVERSIONS' ? { maximizeConversions: { ...(input.bidding.target_cpa_micros !== undefined ? { targetCpaMicros: String(input.bidding.target_cpa_micros) } : {}) } } : { maximizeConversionValue: { ...(input.bidding.target_roas !== undefined ? { targetRoas: input.bidding.target_roas } : {}) } };
    const operations: Row[] = [...resolved.operations,
      { campaignBudgetOperation: { create: { resourceName: budget, name: `Budget for ${input.name}`, amountMicros: String(input.daily_budget_micros), explicitlyShared: false, deliveryMethod: 'STANDARD' } } },
      { campaignOperation: { create: { resourceName: campaign, name: input.name, advertisingChannelType: 'PERFORMANCE_MAX', status, campaignBudget: budget, containsEuPoliticalAdvertising: input.contains_eu_political_advertising, brandGuidelinesEnabled: true, ...(input.brand_guidelines ? { brandGuidelines: fields(input.brand_guidelines) } : {}), ...(input.merchant ? { shoppingSetting: { merchantId: input.merchant.merchant_id, ...(input.merchant.feed_label ? { feedLabel: input.merchant.feed_label } : {}) } } : {}), assetAutomationSettings: [{ assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: input.allow_final_url_expansion ? 'OPTED_IN' : 'OPTED_OUT' }], ...(input.location_ids.length ? { geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' } } : {}), ...bidding } } },
      ...brandAssets.map(value => ({ campaignAssetOperation: { create: { campaign, asset: value.link.asset, fieldType: value.link.fieldType, status: 'ENABLED' } } })),
      ...this.groupOperations(account, group, campaign, input.asset_group, groupAssets, groupStatus),
      ...await this.signalOperations(account, group, input.asset_group.signals),
      ...(input.asset_group.listing_filters ? this.listingOperations(account, group, input.asset_group.listing_filters) : []),
      ...[...new Set(input.location_ids)].map(value => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${value}` } } } })),
      ...[...new Set(input.language_ids)].map(value => ({ campaignCriterionOperation: { create: { campaign, language: { languageConstant: `languageConstants/${value}` } } } })),
    ];
    const plan = this.atomic(account, operations, `Create Performance Max campaign “${input.name}” and complete ${retail ? 'retail' : 'standard'} asset group (${status})`, [`+ Non-shared budget ${input.daily_budget_micros} micros/day in ${String(customer.currencyCode)}; bidding ${input.bidding.strategy}.`, `+ Campaign ${status}; group “${input.asset_group.name}” ${groupStatus}; ${groupAssets.length} group assets, ${brandAssets.length} campaign brand assets.`, `+ ${input.asset_group.signals.length} signals; ${input.asset_group.listing_filters?.length ?? 0} SHOPPING filters.`, `+ Final URL expansion ${input.allow_final_url_expansion ? 'OPTED_IN (Google can select/generate other landing pages and text)' : 'OPTED_OUT'}; other native asset-automation defaults remain in effect.`, `+ Locations ${input.location_ids.join(', ') || 'unrestricted'}; languages ${input.language_ids.join(', ') || 'unrestricted'}. Native geo/language eligibility and Merchant Center links are checked by Google.`, 'All text assets precede associations, campaign brand links immediately follow the campaign, and group asset links are consecutive. This is one atomic request, not an incomplete channel-only campaign.'], coercions, [{ target: `new Performance Max campaign “${input.name}” daily budget`, fromMicros: 0, toMicros: input.daily_budget_micros }]);
    return this.verifyCreation(plan, account, input.name, input.asset_group.name, groupStatus, undefined, status);
  }
  private async createGroup(account: string, payload: Row, guard: WriteGuard): Promise<Plan> {
    const input = groupCreate.safeExtend({ campaign_id: id, expected_campaign_hash: hash }).parse(payload), context = await this.campaignContext({ account_id: account, campaign_id: input.campaign_id });
    if (context.campaign_snapshot_hash !== input.expected_campaign_hash) throw new AdportError('PENDING_MISMATCH', 'google: campaign, budget or brand assets changed; read Performance Max context again');
    const { campaign_id: _campaign, expected_campaign_hash: _hash, ...settings } = input, resolved = await this.resolveAssets(account, input.assets), brands = context.campaign.brandGuidelinesEnabled === true, retail = Boolean(row(context.campaign.shoppingSetting).merchantId);
    if (brands && resolved.assets.some(value => brandTypes.has(String(value.link.fieldType)))) throw new AdportError('INVALID_INPUT', 'google: use google_update_performance_max_brand_assets for campaign-level brand changes before creating a group');
    this.requirements(resolved.assets, context.brand_assets, brands, retail, input.final_urls);
    if (Boolean(input.listing_filters) !== retail) throw new AdportError('INVALID_INPUT', 'google: only retail groups require a SHOPPING product tree');
    const group = `customers/${account}/assetGroups/-10003`, coercions: string[] = [], status = this.createdStatus(input.status, guard, 'Asset group', coercions);
    const operations = [...resolved.operations, ...this.groupOperations(account, group, String(context.campaign.resourceName), settings, resolved.assets, status), ...await this.signalOperations(account, group, input.signals), ...(input.listing_filters ? this.listingOperations(account, group, input.listing_filters) : [])];
    const plan = this.atomic(account, operations, `Create Performance Max asset group “${input.name}” (${status})`, [`+ Group in campaign ${input.campaign_id}, with ${resolved.assets.length} atomic creative links, ${input.signals.length} signals and ${input.listing_filters?.length ?? 0} product filters.`, 'Campaign status, budget and campaign-level brand links are preserved. Child links are enabled within the new group; a paused group cannot serve.'], coercions);
    return this.verifyCreation(plan, account, String(context.campaign.name), input.name, status, String(context.campaign.resourceName));
  }
  private async updateAssets(account: string, input: z.infer<typeof assetsUpdate>, context: Awaited<ReturnType<GooglePerformanceMaxService['context']>>): Promise<Plan> {
    if (context.assets_snapshot_hash !== input.expected_assets_hash) throw new AdportError('PENDING_MISMATCH', 'google: group, parent, assets or brand configuration changed; read context again');
    const remove = input.remove.map(value => `customers/${account}/assetGroupAssets/${input.asset_group_id}~${value.asset_id}~${value.field_type}`);
    if (new Set(remove).size !== remove.length || remove.some(value => !context.assets.some(item => item.link.resourceName === value))) throw new AdportError('INVALID_INPUT', 'google: every removed asset association must belong to this group exactly once');
    const resolved = await this.resolveAssets(account, input.add), remain = context.assets.filter(value => !remove.includes(String(value.link.resourceName))), after = [...remain, ...resolved.assets];
    if (new Set(after.map(value => `${value.link.asset}:${value.link.fieldType}`)).size !== after.length) throw new AdportError('INVALID_INPUT', 'google: final asset set contains duplicate links');
    this.requirements(after, context.brand_assets, context.campaign.brandGuidelinesEnabled === true, Boolean(row(context.campaign.shoppingSetting).merchantId), context.asset_group.finalUrls);
    const operations = [...resolved.operations, ...remove.map(resource => ({ assetGroupAssetOperation: { remove: resource } })), ...resolved.assets.map(value => ({ assetGroupAssetOperation: { create: { assetGroup: context.asset_group.resourceName, asset: value.link.asset, fieldType: value.link.fieldType, status: 'ENABLED' } } }))];
    return this.atomic(account, operations, `Update creative assets in group “${String(context.asset_group.name)}”`, [`- ${remove.length} exact associations; + ${resolved.assets.length} associations in one atomic set. Shared source assets are retained.`, `Group stays ${String(context.asset_group.status)}; parent campaign stays ${String(context.campaign.status)}. New links are enabled as part of this explicit creative edit and can affect serving combinations.`, ...resolved.assets.map(value => `+ ${String(value.link.fieldType)} ${String(row(value.asset.textAsset).text ?? value.link.asset)}`)]);
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    if (op.provider !== 'google' || !GOOGLE_PMAX_WRITES.has(op.tool) || op.kind !== kinds[op.tool as keyof typeof kinds]) throw new AdportError('INVALID_INPUT', 'google: invalid Performance Max operation kind');
    const account = normalizeCustomerId(op.accountId);
    if (op.tool === 'google_create_performance_max_campaign') return this.createCampaign(account, campaignCreate.parse(op.payload), guard);
    if (op.tool === 'google_create_asset_group') return this.createGroup(account, op.payload, guard);
    if (op.tool === 'google_update_performance_max_brand_assets') return this.updateBrandAssets(account, op.payload);
    const payload = row(op.payload), groupId = id.parse(payload.asset_group_id), context = await this.context({ account_id: account, asset_group_id: groupId }), group = context.asset_group, resource = String(group.resourceName);
    if (group.status === 'REMOVED') throw new AdportError('INVALID_INPUT', 'google: removed asset group cannot be changed');
    if (op.tool === 'google_update_asset_group_assets') return this.updateAssets(account, assetsUpdate.parse(payload), context);
    if (op.tool === 'google_update_asset_group_copy') {
      const input = copyUpdate.parse(payload), changes: z.infer<typeof assetsUpdate> = { asset_group_id: groupId, expected_assets_hash: input.expected_assets_hash, add: [], remove: [] };
      for (const [key, type] of [['headlines', 'HEADLINE'], ['long_headlines', 'LONG_HEADLINE'], ['descriptions', 'DESCRIPTION']] as const) {
        const wanted = input[key]; if (!wanted) continue;
        if (new Set(wanted).size !== wanted.length) throw new AdportError('INVALID_INPUT', 'google: duplicate copy within a placement');
        const current = context.assets.filter(value => value.link.fieldType === type), existing = current.map(value => row(value.asset.textAsset).text);
        changes.add.push(...wanted.filter(value => !existing.includes(value)).map(text => ({ field_type: type, text })));
        changes.remove.push(...current.filter(value => !wanted.includes(String(row(value.asset.textAsset).text))).map(value => ({ asset_id: String(value.asset.id), field_type: type })));
      }
      if (!changes.add.length && !changes.remove.length) throw new AdportError('INVALID_INPUT', 'google: supplied copy already matches this group');
      return this.updateAssets(account, changes, context);
    }
    if (op.tool === 'google_add_asset_group_signals' || op.tool === 'google_remove_asset_group_signals') return this.changeSignals(account, op, context);
    if (op.tool === 'google_replace_asset_group_listing_filters') return this.replaceFilters(account, payload, context);
    const input = op.tool === 'google_update_asset_group' ? groupUpdate.parse(payload) : op.tool === 'google_set_asset_group_status' ? z.object({ ...groupRef, status: z.enum(['ENABLED', 'PAUSED']) }).strict().parse(payload) : z.object(groupRef).strict().parse(payload);
    if (context.group_snapshot_hash !== input.expected_group_hash) throw new AdportError('PENDING_MISMATCH', 'google: asset-group or parent configuration changed; read context again');
    if (op.tool === 'google_remove_asset_group') return this.atomic(account, [{ assetGroupOperation: { remove: resource } }], `Remove asset group “${String(group.name)}”`, [`- ${resource}; its associations, signals and listing filters may also be removed. Shared assets, parent campaign and budget are retained.`]);
    const { asset_group_id: _id, expected_group_hash: _hash, ...settings } = input, merged = { ...group, ...fields(settings) };
    this.groupWire({ path1: merged.path1, path2: merged.path2 });
    this.requirements(context.assets, context.brand_assets, context.campaign.brandGuidelinesEnabled === true, Boolean(row(context.campaign.shoppingSetting).merchantId), merged.finalUrls);
    return this.atomic(account, [{ assetGroupOperation: { update: { resourceName: resource, ...fields(settings) }, updateMask: Object.keys(settings).filter(key => settings[key as keyof typeof settings] !== undefined).join(',') } }], `Update asset group “${String(group.name)}”`, Object.entries(fields(settings)).map(([key, value]) => `~ ${key}: ${JSON.stringify(group[key] ?? null)} → ${JSON.stringify(value)}`));
  }
  private async updateBrandAssets(account: string, payload: Row): Promise<Plan> {
    const input = brandUpdate.parse(payload), context = await this.campaignContext({ account_id: account, campaign_id: input.campaign_id });
    if (context.campaign_snapshot_hash !== input.expected_campaign_hash) throw new AdportError('PENDING_MISMATCH', 'google: campaign, budget or brand assets changed; read context again');
    if (context.campaign.brandGuidelinesEnabled !== true) throw new AdportError('INVALID_INPUT', 'google: campaign brand edits require native brand guidelines enabled; disabled campaigns keep branding on each group');
    const remove = input.remove.map(value => `customers/${account}/campaignAssets/${input.campaign_id}~${value.asset_id}~${value.field_type}`);
    if (new Set(remove).size !== remove.length || remove.some(value => !context.brand_assets.some(item => item.link.resourceName === value))) throw new AdportError('INVALID_INPUT', 'google: every removed brand link must belong to this campaign exactly once');
    const resolved = await this.resolveAssets(account, input.add), after = [...context.brand_assets.filter(value => !remove.includes(String(value.link.resourceName))), ...resolved.assets];
    if (new Set(after.map(value => `${value.link.fieldType}:${value.link.asset}`)).size !== after.length || after.filter(value => value.link.fieldType === 'BUSINESS_NAME').length !== 1 || after.filter(value => value.link.fieldType === 'LOGO').length < 1 || after.filter(value => value.link.fieldType === 'LOGO').length > 5) throw new AdportError('INVALID_INPUT', 'google: final campaign branding requires distinct links, one business name and one to five logos');
    return this.atomic(account, [...resolved.operations, ...remove.map(resource => ({ campaignAssetOperation: { remove: resource } })), ...resolved.assets.map(value => ({ campaignAssetOperation: { create: { campaign: context.campaign.resourceName, asset: value.link.asset, fieldType: value.link.fieldType, status: 'ENABLED' } } }))], `Update shared Performance Max branding for campaign “${String(context.campaign.name)}”`, [`- ${remove.length} exact brand links; + ${resolved.assets.length} links atomically. Source assets are retained.`, 'Brand changes affect every asset group in this campaign, including serving creative combinations. Campaign/group statuses and budget are preserved.']);
  }
  private async changeSignals(account: string, op: WriteOperation, context: Awaited<ReturnType<GooglePerformanceMaxService['context']>>): Promise<Plan> {
    const input = op.tool === 'google_add_asset_group_signals' ? signalsAdd.parse(op.payload) : signalsRemove.parse(op.payload);
    if (context.signals_snapshot_hash !== input.expected_signals_hash) throw new AdportError('PENDING_MISMATCH', 'google: group, parent or signals changed; read context again');
    let operations: Row[];
    if ('signals' in input) {
      const key = (value: Row) => value.audience ? `audience:${String(row(value.audience).audience)}` : `theme:${String(row(value.searchTheme).text)}`;
      operations = await this.signalOperations(account, String(context.asset_group.resourceName), input.signals);
      if (operations.some(value => context.signals.some(existing => key(existing) === key(row(row(value.assetGroupSignalOperation).create))))) throw new AdportError('INVALID_INPUT', 'google: a supplied audience or search theme is already linked');
    } else {
      const names = input.signal_ids.map(value => `customers/${account}/assetGroupSignals/${input.asset_group_id}~${value}`);
      if (new Set(names).size !== names.length || names.some(value => !context.signals.some(existing => existing.resourceName === value))) throw new AdportError('INVALID_INPUT', 'google: every removed signal must belong to this group exactly once');
      operations = names.map(resource => ({ assetGroupSignalOperation: { remove: resource } }));
    }
    return this.atomic(account, operations, `${'signals' in input ? 'Add' : 'Remove'} ${operations.length} Performance Max signals`, ['Signals guide optimization and can change delivery, but audiences/search themes do not restrict targeting to only these users or queries.', 'This workflow does not upload customer records, create an audience or change campaign/group status or budget.']);
  }
  private replaceFilters(account: string, payload: Row, context: Awaited<ReturnType<GooglePerformanceMaxService['context']>>): Plan {
    const input = listingReplace.parse(payload);
    if (context.listing_snapshot_hash !== input.expected_listing_hash) throw new AdportError('PENDING_MISMATCH', 'google: group, parent or listing filters changed; read context again');
    if (!row(context.campaign.shoppingSetting).merchantId || context.listing_filters.some(value => value.listingSource !== 'SHOPPING')) throw new AdportError('INVALID_INPUT', 'google: this workflow replaces only SHOPPING product filters in an existing retail campaign; webpage/retail-bundle filters are separate native workflows');
    const byName = new Map(context.listing_filters.map(value => [String(value.resourceName), value]));
    const depth = (value: Row, seen = new Set<string>()): number => {
      const resource = String(value.resourceName); if (seen.has(resource)) throw new AdportError('PROVIDER_ERROR', 'google: cycle in current native listing tree'); seen.add(resource);
      if (!value.parentListingGroupFilter) return 0;
      const parent = byName.get(String(value.parentListingGroupFilter)); if (!parent) throw new AdportError('PROVIDER_ERROR', 'google: current native listing tree has an unavailable parent');
      return 1 + depth(parent, seen);
    };
    const remove = [...context.listing_filters].sort((a, b) => depth(b) - depth(a)).map(value => ({ assetGroupListingGroupFilterOperation: { remove: value.resourceName } }));
    return this.atomic(account, [...remove, ...this.listingOperations(account, String(context.asset_group.resourceName), input.listing_filters)], `Replace product listing tree for group “${String(context.asset_group.name)}”`, [`- ${remove.length} old tree nodes, children first; + ${input.listing_filters.length} new nodes, parents first, in one atomic request.`, 'Included/excluded products can change immediately in serving groups. Shared feeds, Merchant Center records, media assets, campaign/group statuses and budgets are preserved.']);
  }
}

export function googlePerformanceMaxTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  const ref = z.object({ account_id: z.string(), asset_group_id: id });
  return [
    defineTool({ name: 'google_performance_max_context', namespace: 'google', description: 'Read an owned Performance Max campaign, budget, brand-guidelines state, automation settings and campaign brand links. Supply campaign_snapshot_hash to guarded group/brand changes. Does not enable a campaign or access Merchant Center records.', input: z.object({ account_id: z.string(), campaign_id: id }), annotations: { readOnly: true }, handler: input => provider.performanceMax.campaignContext(input) }),
    defineTool({ name: 'google_asset_groups', namespace: 'google', description: 'List owned Performance Max asset groups in one campaign with status, actual landing URLs and native eligibility/ad-strength reasons. Continue next_cursor as after_asset_group_id; use context/creatives for one group.', input: z.object({ account_id: z.string(), campaign_id: id, limit: z.number().int().positive().max(100).default(25), after_asset_group_id: id.optional(), include_removed: z.boolean().default(false) }), annotations: { readOnly: true }, pagination: { cursorInput: 'after_asset_group_id' }, handler: input => provider.performanceMax.list(input) }),
    defineTool({ name: 'google_asset_group_context', namespace: 'google', description: 'Read one owned group, complete scoped creative/brand associations, signals and listing filters with separate group/assets/signals/listing snapshot hashes. Includes draft groups. Fails if a complete context exceeds its bounded read.', input: ref, annotations: { readOnly: true }, handler: input => provider.performanceMax.context(input) }),
    defineTool({ name: 'google_asset_group_creatives', namespace: 'google', description: 'View actual Performance Max group copy, owned image previews and landing URLs, with guarded status/copy-edit actions. The group generates creative combinations; it is not one fixed rendered ad. Previews omit unsupported media origins.', input: ref, output: creativesOutput, presentation: 'creatives', annotations: { readOnly: true }, handler: input => provider.performanceMax.creatives(input) }),
    ...([
      ['google_create_performance_max_campaign', 'Create a complete standard/retail Performance Max campaign, non-shared budget, group, native text assets/associations and optional signals/product tree in one atomic request. Existing image/YouTube assets are account-verified. New brand guidelines use campaign-level business name/logos. Campaign/group creation obeys paused policy; previews use validateOnly. Final URL expansion defaults opted out.', campaignCreate],
      ['google_create_asset_group', 'Create a complete owned-campaign Performance Max group with atomic creative links, optional audience/search-theme signals and a retail product tree. Requires expected_campaign_hash. New group obeys paused policy; enabled child links cannot serve inside a paused group. Brand-guidelines campaigns need existing campaign-level branding.', groupCreate.safeExtend({ campaign_id: id, expected_campaign_hash: hash })],
      ['google_update_asset_group', 'Edit only supplied group name, URLs, display paths and tracking fields with exact masks and expected_group_hash. Omission preserves values. Existing statuses, creative sources, campaign budget and parent are retained.', groupUpdate],
      ['google_set_asset_group_status', 'Enable or pause a verified owned asset group with expected_group_hash. Enabling can serve its generated combinations if the parent campaign is enabled. Does not change campaign status or budget.', z.object({ ...groupRef, status: z.enum(['ENABLED', 'PAUSED']) }).strict()],
      ['google_remove_asset_group', 'Remove a verified asset group and its native child associations/signals/filter tree, using expected_group_hash. Parent campaign, budget and shared source assets are retained. Native constraints still apply.', z.object(groupRef).strict()],
      ['google_update_asset_group_assets', 'Atomically add supplied creative placements/text assets and remove exact owned associations, using expected_assets_hash. Preserves source assets and parent/group status. New links are enabled as an explicit creative edit; serving combinations can change. Final set must meet native minimums; retail can unlink all custom assets to return to feed-only.', assetsUpdate],
      ['google_update_asset_group_copy', 'Replace supplied headline/long-headline/description sets atomically with expected_assets_hash. Retains matching existing text and all unsupplied placements. New immutable text assets precede consecutive association changes; shared old sources are retained. Can affect serving combinations.', copyUpdate],
      ['google_update_performance_max_brand_assets', 'Atomically change campaign-level BUSINESS_NAME/LOGO/LANDSCAPE_LOGO links for brand-guidelines campaigns with expected_campaign_hash. Affects every group in the campaign, including serving creative combinations. Preserves sources/status/budget and native minimum branding.', brandUpdate],
      ['google_add_asset_group_signals', 'Add account-owned audience references or search themes with expected_signals_hash. These guide optimization rather than restrict targeting. No records are uploaded, audiences created or serving statuses changed.', signalsAdd],
      ['google_remove_asset_group_signals', 'Remove exact owned signal IDs from the selected group with expected_signals_hash. Does not delete audiences or upload customer records. Native minimum-signal rules remain authoritative.', signalsRemove],
      ['google_replace_asset_group_listing_filters', 'Replace a retail SHOPPING product tree atomically with expected_listing_hash. Typed brand/category/product type/custom-label/item/channel/condition nodes require unique keys, one root and complete subdivisions. Old children are removed first; new parents created first. Can alter eligible products in serving groups; feeds/status/budgets are retained.', listingReplace],
    ] as const).map(([tool, description, payload]) => guardedWriteTool({ name: tool, namespace: 'google', provider: 'google', kind: kinds[tool], description, payload })),
  ];
}
