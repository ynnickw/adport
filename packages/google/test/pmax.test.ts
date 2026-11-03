import { createContext, DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it, vi } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Official v25 protos pinned at googleapis/googleapis@492a18f4; native campaign,
// asset-group, association, signal and dimension fields verified 2026-11-04.
type Row = Record<string, any>;
const account = '1234567890', root = `customers/${account}`, groupName = `${root}/assetGroups/70`, campaignName = `${root}/campaigns/42`, guard = { forcePausedCreation: true };
const text = (id: number, value: string) => ({ resourceName: `${root}/assets/${id}`, id: String(id), type: 'TEXT', textAsset: { text: value } });
const sourceAssets = [
  ...[1, 2, 3].map(id => ({ resourceName: `${root}/assets/${id}`, id: String(id), type: 'IMAGE', imageAsset: { fullSize: { url: `https://tpc.googlesyndication.com/image-${id}.png`, widthPixels: '1200', heightPixels: id === 1 ? '628' : '1200' } } })),
  text(4, 'Fixture Company'), text(5, 'Headline one'), text(6, 'Headline two'), text(7, 'Headline three'), text(8, 'Long headline fixture'), text(9, 'Description one'), text(10, 'Description two'),
];
const roles = ['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'LOGO', 'BUSINESS_NAME', 'HEADLINE', 'HEADLINE', 'HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'DESCRIPTION'];
const refs = () => sourceAssets.map((value, index) => ({ field_type: roles[index], asset_id: value.id }));
function fixture() {
  const state: Row = { customer: { resourceName: root, id: account, currencyCode: 'EUR', timeZone: 'Europe/Berlin' }, campaign: { resourceName: campaignName, id: '42', name: 'Fixture campaign', status: 'PAUSED', advertisingChannelType: 'PERFORMANCE_MAX', brandGuidelinesEnabled: false, campaignBudget: `${root}/campaignBudgets/24`, biddingStrategyType: 'MAXIMIZE_CONVERSIONS' }, budget: { resourceName: `${root}/campaignBudgets/24`, amountMicros: '1000000', explicitlyShared: false }, group: { resourceName: groupName, id: '70', campaign: campaignName, name: 'Fixture group', status: 'PAUSED', finalUrls: ['https://example.com/'] }, assets: structuredClone(sourceAssets), brands: [], signals: [], filters: [] };
  state.links = state.assets.map((asset: Row, index: number) => ({ assetGroupAsset: { resourceName: `${root}/assetGroupAssets/70~${asset.id}~${roles[index]}`, assetGroup: groupName, asset: asset.resourceName, fieldType: roles[index], status: 'ENABLED' }, asset }));
  const calls: { url: URL; body: Row }[] = [];
  let override: ((url: URL, body: Row) => unknown) | undefined;
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)), body = url.hostname === 'oauth2.googleapis.com' ? {} : JSON.parse(String(init.body ?? '{}')); calls.push({ url, body });
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    const response = override?.(url, body); if (response !== undefined) return Response.json(response);
    if (url.pathname.endsWith('googleAds:search')) {
      const q = String(body.query); let rows: Row[];
      if (q.includes(' FROM customer ')) rows = [{ customer: state.customer }];
      else if (q.includes(' FROM campaign_asset ')) rows = state.brands;
      else if (q.includes(' FROM campaign ')) rows = [{ campaign: state.campaign, campaignBudget: state.budget }];
      else if (q.includes(' FROM asset_group_asset ')) rows = state.links;
      else if (q.includes(' FROM asset_group_signal ')) rows = state.signals.map((assetGroupSignal: Row) => ({ assetGroupSignal }));
      else if (q.includes(' FROM asset_group_listing_group_filter ')) rows = state.filters.map((assetGroupListingGroupFilter: Row) => ({ assetGroupListingGroupFilter }));
      else if (q.includes(' FROM asset_group ')) rows = [{ assetGroup: state.group }];
      else if (q.includes(' FROM audience ')) rows = [{ audience: { resourceName: `${root}/audiences/55`, status: 'ENABLED' } }];
      else if (q.includes(' FROM asset ')) { const wanted = q.match(/asset.id IN \(([^)]+)\)/)?.[1]?.split(','); rows = state.assets.filter((value: Row) => !wanted || wanted.includes(value.id)).map((asset: Row) => ({ asset })); }
      else throw new Error('Unhandled fixture query');
      return Response.json({ results: rows });
    }
    if (body.validateOnly) return Response.json({});
    const results = body.mutateOperations.map((value: Row) => { const [type, op] = Object.entries(value)[0] as [string, Row], resultKey = type.replace(/Operation$/, 'Result'); return { [resultKey]: { resourceName: op.update?.resourceName ?? op.remove ?? `${root}/assets/999` } }; });
    return Response.json({ mutateOperationResponses: results });
  });
  const provider = new GoogleAdsProvider(new GoogleAdsRestClient({ clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh' }, 'v25', fetcher as typeof fetch));
  return { provider, state, calls, respond(fn: typeof override) { override = fn; } };
}
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(value => value.url.pathname.endsWith('googleAds:mutate'));
async function operation(f: ReturnType<typeof fixture>, tool: string, extra: Row = {}): Promise<WriteOperation> {
  const current = await f.provider.performanceMax.context({ account_id: account, asset_group_id: '70' });
  const hashes = tool === 'google_update_asset_group_assets' || tool === 'google_update_asset_group_copy' ? { expected_assets_hash: current.assets_snapshot_hash } : tool.includes('signals') ? { expected_signals_hash: current.signals_snapshot_hash } : tool.includes('listing_filters') ? { expected_listing_hash: current.listing_snapshot_hash } : { expected_group_hash: current.group_snapshot_hash };
  return { provider: 'google', tool, accountId: account, kind: tool.includes('add_') ? 'create' : tool.includes('remove_') ? 'remove' : 'update', payload: { asset_group_id: '70', ...hashes, ...extra } };
}
const campaignInput = () => ({ name: 'New fixture PMax', daily_budget_micros: 2000000, status: 'ENABLED', bidding: { strategy: 'MAXIMIZE_CONVERSIONS', target_cpa_micros: 1250000 }, asset_group: { name: 'New fixture group', status: 'ENABLED', final_urls: ['https://example.com/'], assets: refs().map(value => value.field_type === 'BUSINESS_NAME' ? { field_type: value.field_type, text: 'Fixture Company' } : value) } });

describe('Performance Max atomic hierarchy', () => {
  it('routes the generic channel-only shortcut to complete hierarchy creation before any native mutation', async () => {
    const f = fixture();
    await expect(f.provider.previewWrite({ tool: 'google_create_campaign', provider: 'google', accountId: account, kind: 'create', payload: { name: 'Partial', channel_type: 'PERFORMANCE_MAX', daily_budget_micros: 1000000 } }, guard)).rejects.toThrow('google_create_performance_max_campaign');
    expect(mutations(f)).toHaveLength(0);
  });
  it('validates budget/campaign/brand/group creation atomically, with text before references and consecutive links', async () => {
    const f = fixture(), preview = await f.provider.previewWrite({ tool: 'google_create_performance_max_campaign', provider: 'google', accountId: account, kind: 'create', payload: campaignInput() }, guard);
    const body = mutations(f)[0]!.body, ops = body.mutateOperations;
    expect(mutations(f)).toHaveLength(1); expect(body).toMatchObject({ partialFailure: false, validateOnly: true });
    expect(ops[0]).toMatchObject({ assetOperation: { create: { textAsset: { text: 'Fixture Company' } } } });
    const ci = ops.findIndex((value: Row) => value.campaignOperation);
    expect(ops[ci].campaignOperation.create).toMatchObject({ status: 'PAUSED', advertisingChannelType: 'PERFORMANCE_MAX', brandGuidelinesEnabled: true, maximizeConversions: { targetCpaMicros: '1250000' }, assetAutomationSettings: [{ assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' }] });
    expect(ops[ci + 1]).toHaveProperty('campaignAssetOperation'); expect(ops[ci + 2]).toHaveProperty('campaignAssetOperation');
    const gi = ops.findIndex((value: Row) => value.assetGroupOperation);
    expect(ops[gi].assetGroupOperation.create).toMatchObject({ status: 'PAUSED', finalUrls: ['https://example.com/'] });
    expect(ops.slice(gi + 1).every((value: Row) => value.assetGroupAssetOperation)).toBe(true);
    expect(ops[1].campaignBudgetOperation.create).toMatchObject({ amountMicros: '2000000', explicitlyShared: false });
    expect(preview).toMatchObject({ serverValidated: true, budgetDeltas: [{ fromMicros: 0, toMicros: 2000000 }] }); expect(preview.coercions).toHaveLength(2);
  });
  it('allows explicitly enabled creation only when paused policy permits and preserves value bidding', async () => {
    const f = fixture(), input = campaignInput(); input.bidding = { strategy: 'MAXIMIZE_CONVERSION_VALUE', target_roas: 2.5 } as any;
    await f.provider.previewWrite({ tool: 'google_create_performance_max_campaign', provider: 'google', accountId: account, kind: 'create', payload: input }, { forcePausedCreation: false });
    const campaign = mutations(f)[0]!.body.mutateOperations.find((value: Row) => value.campaignOperation).campaignOperation.create;
    expect(campaign).toMatchObject({ status: 'ENABLED', maximizeConversionValue: { targetRoas: 2.5 } }); expect(campaign).not.toHaveProperty('maximizeConversions');
  });
  it('creates an owned existing-campaign group without changing its parent or campaign branding', async () => {
    const f = fixture(), context = await f.provider.performanceMax.campaignContext({ account_id: account, campaign_id: '42' });
    await f.provider.previewWrite({ tool: 'google_create_asset_group', provider: 'google', accountId: account, kind: 'create', payload: { campaign_id: '42', expected_campaign_hash: context.campaign_snapshot_hash, name: 'Second group', status: 'ENABLED', final_urls: ['https://example.com/'], assets: refs() } }, guard);
    const ops = mutations(f)[0]!.body.mutateOperations;
    expect(ops[0].assetGroupOperation.create).toMatchObject({ campaign: campaignName, status: 'PAUSED' });
    expect(ops.slice(1).every((value: Row) => value.assetGroupAssetOperation)).toBe(true);
    expect(ops.some((value: Row) => value.campaignOperation || value.campaignAssetOperation || value.campaignBudgetOperation)).toBe(false);
  });
  it('rejects stale parent/brand/budget context and unavailable or wrong-type source assets before mutation', async () => {
    const f = fixture(), context = await f.provider.performanceMax.campaignContext({ account_id: account, campaign_id: '42' }); f.state.budget.amountMicros = '1200000';
    await expect(f.provider.previewWrite({ tool: 'google_create_asset_group', provider: 'google', accountId: account, kind: 'create', payload: { campaign_id: '42', expected_campaign_hash: context.campaign_snapshot_hash, name: 'Second', assets: refs(), final_urls: ['https://example.com/'] } }, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    f.state.assets[0].type = 'TEXT';
    await expect(f.provider.previewWrite({ tool: 'google_create_performance_max_campaign', provider: 'google', accountId: account, kind: 'create', payload: campaignInput() }, guard)).rejects.toThrow('requires IMAGE');
    f.state.assets.shift();
    await expect(f.provider.previewWrite({ tool: 'google_create_performance_max_campaign', provider: 'google', accountId: account, kind: 'create', payload: campaignInput() }, guard)).rejects.toThrow('all supplied assets');
    expect(mutations(f)).toHaveLength(0);
  });
  it('requires complete minimum assets and URLs instead of creating an unusable partial group', async () => {
    const f = fixture();
    for (const modify of [(x: Row) => { x.asset_group.assets = refs().filter(value => value.field_type !== 'HEADLINE'); }, (x: Row) => { x.asset_group.final_urls = []; }, (x: Row) => { x.asset_group.assets = refs().filter(value => value.field_type !== 'LOGO'); }]) {
      const input = campaignInput(); modify(input);
      await expect(f.provider.previewWrite({ tool: 'google_create_performance_max_campaign', provider: 'google', accountId: account, kind: 'create', payload: input }, guard)).rejects.toThrow();
    }
    expect(mutations(f)).toHaveLength(0);
  });
  it('supports retail feed-only creation with Merchant Center settings and a mandatory product root', async () => {
    const f = fixture(), input = { ...campaignInput(), merchant: { merchant_id: '55', feed_label: 'DE' }, asset_group: { name: 'Feed only', assets: [], listing_filters: [{ key: 'root', type: 'UNIT_INCLUDED' }] } };
    await f.provider.previewWrite({ tool: 'google_create_performance_max_campaign', provider: 'google', accountId: account, kind: 'create', payload: input }, guard);
    const ops = mutations(f)[0]!.body.mutateOperations;
    expect(ops.find((value: Row) => value.campaignOperation).campaignOperation.create.shoppingSetting).toEqual({ merchantId: '55', feedLabel: 'DE' });
    expect(ops.at(-1).assetGroupListingGroupFilterOperation.create).toMatchObject({ type: 'UNIT_INCLUDED', listingSource: 'SHOPPING' });
    expect(ops.some((value: Row) => value.assetGroupAssetOperation)).toBe(false);
    delete (input.asset_group as any).listing_filters;
    await expect(f.provider.previewWrite({ tool: 'google_create_performance_max_campaign', provider: 'google', accountId: account, kind: 'create', payload: input }, guard)).rejects.toThrow('require a SHOPPING');
  });
  it.each([false, true])('reads back paused group ownership after creation; mismatched state fails without a retry: %s', async mismatch => {
    const f = fixture(), context = await f.provider.performanceMax.campaignContext({ account_id: account, campaign_id: '42' });
    f.respond((url, body) => {
      if (!url.pathname.endsWith('googleAds:mutate') || body.validateOnly) return undefined;
      const resource = `${root}/assetGroups/80`, setting = body.mutateOperations[0].assetGroupOperation.create;
      f.state.group = { ...setting, resourceName: resource, id: '80', status: mismatch ? 'ENABLED' : 'PAUSED' };
      f.state.links = body.mutateOperations.slice(1).map((value: Row) => { const link = value.assetGroupAssetOperation.create, asset = f.state.assets.find((asset: Row) => asset.resourceName === link.asset); return { assetGroupAsset: { ...link, assetGroup: resource, resourceName: `${root}/assetGroupAssets/80~${asset.id}~${link.fieldType}` }, asset }; });
      return { mutateOperationResponses: [{ assetGroupResult: { resourceName: resource } }, ...f.state.links.map((value: Row) => ({ assetGroupAssetResult: { resourceName: value.assetGroupAsset.resourceName } }))] };
    });
    const op: WriteOperation = { tool: 'google_create_asset_group', provider: 'google', accountId: account, kind: 'create', payload: { campaign_id: '42', expected_campaign_hash: context.campaign_snapshot_hash, name: 'Created group', status: 'ENABLED', final_urls: ['https://example.com/'], assets: refs() } };
    if (mismatch) await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: expect.arrayContaining([`${root}/assetGroups/80`]) } });
    else expect(await f.provider.applyWrite(op, guard)).toMatchObject({ applied: true, resourceIds: expect.arrayContaining([`${root}/assetGroups/80`]) });
    expect(mutations(f)).toHaveLength(1); expect(f.state.campaign.status).toBe('PAUSED');
  });
  it('reads back both newly created campaign and group before confirming a complete atomic apply', async () => {
    const f = fixture(), input = { ...campaignInput(), asset_group: { ...campaignInput().asset_group, assets: refs() } };
    f.respond((url, body) => {
      if (!url.pathname.endsWith('googleAds:mutate') || body.validateOnly) return undefined;
      const results: Row[] = []; f.state.brands = []; f.state.links = [];
      for (const value of body.mutateOperations) {
        if (value.campaignBudgetOperation) { f.state.budget = { ...value.campaignBudgetOperation.create, resourceName: `${root}/campaignBudgets/91` }; results.push({ campaignBudgetResult: { resourceName: f.state.budget.resourceName } }); }
        if (value.campaignOperation) { f.state.campaign = { ...value.campaignOperation.create, resourceName: `${root}/campaigns/90`, id: '90', campaignBudget: `${root}/campaignBudgets/91` }; results.push({ campaignResult: { resourceName: f.state.campaign.resourceName } }); }
        if (value.campaignAssetOperation) { const link = value.campaignAssetOperation.create, asset = f.state.assets.find((item: Row) => item.resourceName === link.asset), resourceName = `${root}/campaignAssets/90~${asset.id}~${link.fieldType}`; f.state.brands.push({ campaignAsset: { ...link, resourceName, campaign: f.state.campaign.resourceName }, asset }); results.push({ campaignAssetResult: { resourceName } }); }
        if (value.assetGroupOperation) { f.state.group = { ...value.assetGroupOperation.create, resourceName: `${root}/assetGroups/80`, id: '80', campaign: f.state.campaign.resourceName }; results.push({ assetGroupResult: { resourceName: f.state.group.resourceName } }); }
        if (value.assetGroupAssetOperation) { const link = value.assetGroupAssetOperation.create, asset = f.state.assets.find((item: Row) => item.resourceName === link.asset), resourceName = `${root}/assetGroupAssets/80~${asset.id}~${link.fieldType}`; f.state.links.push({ assetGroupAsset: { ...link, resourceName, assetGroup: f.state.group.resourceName }, asset }); results.push({ assetGroupAssetResult: { resourceName } }); }
      }
      return { mutateOperationResponses: results };
    });
    const result = await f.provider.applyWrite({ tool: 'google_create_performance_max_campaign', provider: 'google', accountId: account, kind: 'create', payload: input }, guard);
    expect(result).toMatchObject({ applied: true, resourceIds: expect.arrayContaining([`${root}/campaigns/90`, `${root}/assetGroups/80`]) });
    expect(f.state.campaign.status).toBe('PAUSED'); expect(f.state.group.status).toBe('PAUSED'); expect(f.state.brands).toHaveLength(2); expect(f.state.links).toHaveLength(8);
    expect(mutations(f)).toHaveLength(1);
  });
});

describe('Performance Max creative editing and ownership', () => {
  it('renders real text, owned images and hash-bound copy/status actions without running mutations', async () => {
    const f = fixture(), result = await f.provider.performanceMax.creatives({ account_id: account, asset_group_id: '70' });
    expect(result.creatives[0]).toMatchObject({ id: '70', campaign_id: '42', headlines: ['Headline one', 'Headline two', 'Headline three'], media: expect.arrayContaining([{ type: 'image', url: 'https://tpc.googlesyndication.com/image-1.png' }]), actions: expect.arrayContaining([expect.objectContaining({ tool: 'google_set_asset_group_status', arguments: expect.objectContaining({ expected_group_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }) }), expect.objectContaining({ tool: 'google_update_asset_group_copy' })]) });
    expect(mutations(f)).toHaveLength(0);
  });
  it('replaces copy atomically and preserves matching old text plus unsupplied placements', async () => {
    const f = fixture(); await f.provider.previewWrite(await operation(f, 'google_update_asset_group_copy', { headlines: ['Headline one', 'New second', 'New third'] }), guard);
    const ops = mutations(f)[0]!.body.mutateOperations;
    expect(ops.slice(0, 2).every((value: Row) => value.assetOperation)).toBe(true);
    expect(ops.slice(2).every((value: Row) => value.assetGroupAssetOperation)).toBe(true);
    expect(ops.filter((value: Row) => value.assetGroupAssetOperation?.remove).map((value: Row) => value.assetGroupAssetOperation.remove)).toEqual([`${root}/assetGroupAssets/70~6~HEADLINE`, `${root}/assetGroupAssets/70~7~HEADLINE`]);
    expect(ops.some((value: Row) => value.assetGroupOperation || value.campaignOperation)).toBe(false);
    expect(ops.filter((value: Row) => value.assetGroupAssetOperation?.create).every((value: Row) => value.assetGroupAssetOperation.create.status === 'ENABLED')).toBe(true);
  });
  it('rejects duplicate/unchanged copy, stale asset hashes and foreign link removal', async () => {
    const f = fixture(), op = await operation(f, 'google_update_asset_group_copy', { headlines: ['First', 'Second', 'Third'] }); f.state.links[0].asset.name = 'Changed source';
    await expect(f.provider.previewWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await expect(f.provider.previewWrite(await operation(f, 'google_update_asset_group_copy', { headlines: ['First', 'First', 'First'] }), guard)).rejects.toThrow('duplicate copy');
    await expect(f.provider.previewWrite(await operation(f, 'google_update_asset_group_copy', { headlines: ['Headline one', 'Headline two', 'Headline three'] }), guard)).rejects.toThrow('already matches');
    await expect(f.provider.previewWrite(await operation(f, 'google_update_asset_group_assets', { remove: [{ field_type: 'HEADLINE', asset_id: '999' }] }), guard)).rejects.toThrow('belong to this group');
    expect(mutations(f)).toHaveLength(0);
  });
  it('prevents minimum-breaking removal, but retail can return to feed-only with one atomic removal set', async () => {
    const f = fixture();
    await expect(f.provider.previewWrite(await operation(f, 'google_update_asset_group_assets', { remove: [{ field_type: 'MARKETING_IMAGE', asset_id: '1' }] }), guard)).rejects.toThrow('MARKETING_IMAGE');
    f.state.campaign.shoppingSetting = { merchantId: '55' };
    await f.provider.previewWrite(await operation(f, 'google_update_asset_group_assets', { remove: refs() }), guard);
    expect(mutations(f)[0]!.body.mutateOperations).toHaveLength(10);
    expect(mutations(f)[0]!.body.mutateOperations.every((value: Row) => value.assetGroupAssetOperation.remove)).toBe(true);
  });
  it('uses exact metadata/status masks and enforces the merged path/URL state', async () => {
    const f = fixture();
    await f.provider.previewWrite(await operation(f, 'google_update_asset_group', { name: 'Renamed', path1: 'offers', path2: 'today' }), guard);
    expect(mutations(f)[0]!.body.mutateOperations).toEqual([{ assetGroupOperation: { update: { resourceName: groupName, name: 'Renamed', path1: 'offers', path2: 'today' }, updateMask: 'name,path1,path2' } }]);
    await f.provider.previewWrite(await operation(f, 'google_set_asset_group_status', { status: 'ENABLED' }), guard);
    expect(mutations(f)[1]!.body.mutateOperations[0]).toEqual({ assetGroupOperation: { update: { resourceName: groupName, status: 'ENABLED' }, updateMask: 'status' } });
    await expect(f.provider.previewWrite(await operation(f, 'google_update_asset_group', { path2: 'orphan' }), guard)).rejects.toThrow('path2');
    await expect(f.provider.previewWrite(await operation(f, 'google_update_asset_group', { final_urls: [] }), guard)).rejects.toThrow('final URL');
  });
  it('does not trust another account/group in a supposedly owned association', async () => {
    const f = fixture(); f.state.links[0].assetGroupAsset.assetGroup = `${root}/assetGroups/999`;
    await expect(f.provider.performanceMax.context({ account_id: account, asset_group_id: '70' })).rejects.toThrow('identity or status mismatch');
    f.state.links[0].assetGroupAsset.assetGroup = groupName; f.state.links[0].asset.resourceName = 'customers/9999999999/assets/1';
    await expect(f.provider.performanceMax.context({ account_id: account, asset_group_id: '70' })).rejects.toThrow('ownership');
  });
  it('checks campaign brand edits separately and reports every affected group without changing serving status', async () => {
    const f = fixture(); f.state.campaign.brandGuidelinesEnabled = true;
    f.state.brands = [3, 4].map(id => { const asset = f.state.assets.find((value: Row) => value.id === String(id)), type = id === 3 ? 'LOGO' : 'BUSINESS_NAME'; return { campaignAsset: { resourceName: `${root}/campaignAssets/42~${id}~${type}`, campaign: campaignName, asset: asset.resourceName, fieldType: type, status: 'ENABLED' }, asset }; });
    const context = await f.provider.performanceMax.campaignContext({ account_id: account, campaign_id: '42' });
    await f.provider.previewWrite({ tool: 'google_update_performance_max_brand_assets', provider: 'google', accountId: account, kind: 'update', payload: { campaign_id: '42', expected_campaign_hash: context.campaign_snapshot_hash, add: [{ field_type: 'BUSINESS_NAME', text: 'New brand' }], remove: [{ field_type: 'BUSINESS_NAME', asset_id: '4' }] } }, guard);
    const ops = mutations(f)[0]!.body.mutateOperations;
    expect(ops[0]).toMatchObject({ assetOperation: { create: { textAsset: { text: 'New brand' } } } });
    expect(ops.slice(1).every((value: Row) => value.campaignAssetOperation)).toBe(true);
    expect(ops.some((value: Row) => value.campaignOperation || value.assetGroupOperation)).toBe(false);
  });
});

describe('Performance Max signals, retail trees and approval', () => {
  it('verifies account-owned audiences and emits native search-theme/audience signal shapes', async () => {
    const f = fixture();
    await f.provider.previewWrite(await operation(f, 'google_add_asset_group_signals', { signals: [{ type: 'AUDIENCE', audience_id: '55' }, { type: 'SEARCH_THEME', text: 'fixture search theme' }] }), guard);
    expect(mutations(f)[0]!.body.mutateOperations).toEqual([{ assetGroupSignalOperation: { create: { assetGroup: groupName, audience: { audience: `${root}/audiences/55` } } } }, { assetGroupSignalOperation: { create: { assetGroup: groupName, searchTheme: { text: 'fixture search theme' } } } }]);
    await expect(f.provider.previewWrite(await operation(f, 'google_add_asset_group_signals', { signals: [{ type: 'AUDIENCE', audience_id: '99' }] }), guard)).rejects.toThrow('account-owned');
  });
  it('removes only current owned signals and rejects already-linked suggestions', async () => {
    const f = fixture(); f.state.signals = [{ resourceName: `${root}/assetGroupSignals/70~77`, assetGroup: groupName, searchTheme: { text: 'existing theme' } }];
    await expect(f.provider.previewWrite(await operation(f, 'google_add_asset_group_signals', { signals: [{ type: 'SEARCH_THEME', text: 'existing theme' }] }), guard)).rejects.toThrow('already linked');
    await expect(f.provider.previewWrite(await operation(f, 'google_remove_asset_group_signals', { signal_ids: ['88'] }), guard)).rejects.toThrow('belong to this group');
    await f.provider.previewWrite(await operation(f, 'google_remove_asset_group_signals', { signal_ids: ['77'] }), guard);
    expect(mutations(f)[0]!.body.mutateOperations).toEqual([{ assetGroupSignalOperation: { remove: `${root}/assetGroupSignals/70~77` } }]);
  });
  it('replaces a typed product tree atomically, removing children before parents and creating parents first', async () => {
    const f = fixture(); f.state.campaign.shoppingSetting = { merchantId: '55' };
    f.state.filters = [{ resourceName: `${root}/assetGroupListingGroupFilters/70~1`, id: '1', assetGroup: groupName, type: 'SUBDIVISION', listingSource: 'SHOPPING' }, { resourceName: `${root}/assetGroupListingGroupFilters/70~2`, id: '2', assetGroup: groupName, parentListingGroupFilter: `${root}/assetGroupListingGroupFilters/70~1`, type: 'UNIT_INCLUDED', listingSource: 'SHOPPING', caseValue: { productBrand: {} } }];
    await f.provider.previewWrite(await operation(f, 'google_replace_asset_group_listing_filters', { listing_filters: [{ key: 'brand', parent_key: 'root', type: 'UNIT_INCLUDED', case_value: { dimension: 'product_brand', value: 'Fixture' } }, { key: 'root', type: 'SUBDIVISION' }, { key: 'other', parent_key: 'root', type: 'UNIT_EXCLUDED', case_value: { dimension: 'product_brand' } }] }), guard);
    const ops = mutations(f)[0]!.body.mutateOperations;
    expect(ops[0]).toEqual({ assetGroupListingGroupFilterOperation: { remove: `${root}/assetGroupListingGroupFilters/70~2` } });
    expect(ops[1]).toEqual({ assetGroupListingGroupFilterOperation: { remove: `${root}/assetGroupListingGroupFilters/70~1` } });
    expect(ops[2].assetGroupListingGroupFilterOperation.create).toMatchObject({ type: 'SUBDIVISION', listingSource: 'SHOPPING' });
    expect(ops[3].assetGroupListingGroupFilterOperation.create).toMatchObject({ parentListingGroupFilter: ops[2].assetGroupListingGroupFilterOperation.create.resourceName, caseValue: { productBrand: { value: 'Fixture' } } });
    expect(ops[4].assetGroupListingGroupFilterOperation.create.caseValue).toEqual({ productBrand: {} });
    expect(mutations(f)[0]!.body).toMatchObject({ validateOnly: true, partialFailure: false });
  });
  it.each([
    { listing_filters: [{ key: 'one', type: 'UNIT_INCLUDED' }, { key: 'two', type: 'UNIT_INCLUDED' }] },
    { listing_filters: [{ key: 'root', type: 'SUBDIVISION' }, { key: 'child', parent_key: 'root', type: 'UNIT_INCLUDED', case_value: { dimension: 'product_brand', value: 'Only brand' } }] },
    { listing_filters: [{ key: 'root', type: 'SUBDIVISION' }, { key: 'one', parent_key: 'root', type: 'UNIT_INCLUDED', case_value: { dimension: 'product_brand', value: 'Brand' } }, { key: 'two', parent_key: 'root', type: 'UNIT_EXCLUDED', case_value: { dimension: 'product_condition' } }] },
  ])('rejects incomplete/ambiguous retail trees before a native write: %j', async ({ listing_filters }) => {
    const f = fixture(); f.state.campaign.shoppingSetting = { merchantId: '55' };
    await expect(f.provider.previewWrite(await operation(f, 'google_replace_asset_group_listing_filters', { listing_filters }), guard)).rejects.toThrow(); expect(mutations(f)).toHaveLength(0);
  });
  it('rejects foreign mutation receipts rather than reporting an unconfirmed apply', async () => {
    const f = fixture(); f.respond((url, body) => url.pathname.endsWith('googleAds:mutate') && !body.validateOnly ? { mutateOperationResponses: [{ assetGroupResult: { resourceName: 'customers/9999999999/assetGroups/70' } }] } : undefined);
    await expect(f.provider.applyWrite(await operation(f, 'google_set_asset_group_status', { status: 'PAUSED' }), guard)).rejects.toThrow('acknowledgement'); expect(mutations(f)).toHaveLength(1);
  });
  it('gates shared MCP/CLI tools through one-use identical-argument approval and protected accounts', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>(), audits: unknown[] = [];
    const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(key) { return pending.get(key); }, async delete(key) { pending.delete(key); } }, { async append(value) { audits.push(value); } });
    const rt = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] }), op = await operation(f, 'google_set_asset_group_status', { status: 'PAUSED' }), args = { account_id: account, ...op.payload };
    const preview = await rt.registry.call(op.tool, args, rt.ctx) as { pending_operation_id: string };
    expect(mutations(f).every(value => value.body.validateOnly)).toBe(true);
    await expect(rt.registry.call(op.tool, { ...args, status: 'ENABLED', pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await rt.registry.call(op.tool, { ...args, pending_operation_id: preview.pending_operation_id }, rt.ctx);
    await expect(rt.registry.call(op.tool, { ...args, pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
    expect(mutations(f).filter(value => !value.body.validateOnly)).toHaveLength(1); expect(audits.length).toBeGreaterThan(0);
    const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [account] }, { async sweep() {}, async put() {}, async get() { return undefined; }, async delete() {} }, { async append() {} });
    const protectedRt = await createContext({ engine: protectedEngine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    await expect(protectedRt.registry.call(op.tool, args, protectedRt.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  });
  it('reports the campaign budget in micros to the shared absolute cap and issues no applicable token on denial', async () => {
    const f = fixture(), pending: PendingOperation[] = [];
    const engine = new PolicyEngine({ ...DEFAULT_POLICY, max_daily_budget_micros: 1000000 }, { async sweep() {}, async put(value) { pending.push(value); }, async get() { return undefined; }, async delete() {} }, { async append() {} });
    const rt = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    await expect(rt.registry.call('google_create_performance_max_campaign', { account_id: account, ...campaignInput() }, rt.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(pending).toHaveLength(0); expect(mutations(f).every(value => value.body.validateOnly)).toBe(true);
  });
});
