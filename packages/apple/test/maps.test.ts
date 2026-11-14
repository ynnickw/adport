import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppleAdsClient } from '../src/client.js';
import { AppleAdsProvider } from '../src/provider.js';
import { appleTools } from '../src/tools.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const creds = { clientId: 'test', teamId: 'test', keyId: 'test', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
function fixture(overrides: Record<string, unknown> = {}) {
  const records: Record<string, unknown> = {
    'business-brands/brand-1': { id: 'brand-1', name: 'Brand' },
    'campaigns/2': { id: 2, adAccountId: 1, promotedObjectType: 'BUSINESS_BRAND', promotedObjectId: 'brand-1', billingEvent: 'TAPS', bidStrategy: { bidStrategyType: 'MAX_ENGAGEMENTS', bidStrategyGoal: 'TAP' }, dailyBudget: { value: { amount: '10', currency: 'EUR' } } },
    'location-groups/LG-1': { id: 'LG-1', adAccountId: '1', name: 'Stores', brandId: 'brand-1', groupType: 'STATIC', systemStatus: 'VALID' },
    'locations/loc-1': { id: 'loc-1', brandId: 'brand-1' },
    'assets/asset-1': { id: 'asset-1', promotedObjectId: 'brand-1', promotedObjectType: 'BUSINESS_BRAND' },
    ...overrides,
  };
  const calls: Array<{ path: string; method: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const provider = new AppleAdsProvider(new AppleAdsClient(creds, (async (url: string | URL, init: RequestInit = {}) => {
    if (String(url).includes('appleid.apple.com')) return Response.json({ access_token: 'test', expires_in: 3600 });
    const path = String(url).replace('https://api.ads.apple.com/v1/', '');
    calls.push({ path, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : {}, headers: init.headers as Record<string, string> });
    if (init.method === 'GET' && !(path in records)) throw new Error(`Unexpected read: ${path}`);
    return Response.json({ result: init.method === 'GET' ? records[path] : { id: 9 } });
  }) as typeof fetch));
  const tools = appleTools(provider);
  const op = (name: string, input: Record<string, unknown>, kind: 'create' | 'update' = 'create') => {
    const { account_id, ...payload } = tools.find(tool => tool.name === name)!.input.parse({ account_id: '1', ...input }) as Record<string, unknown>;
    return { tool: name, provider: 'apple', accountId: String(account_id), kind, payload };
  };
  return { provider, calls, op };
}

// Primary contracts: Apple's Maps journey and Node SDK e81717d1; account grant must support BUSINESS_BRAND_MANUAL.
describe('Apple Maps native workflows', () => {
  const guard = { forcePausedCreation: true };
  it.each([['MAX_ENGAGEMENTS', 'TAPS', 'TAP'], ['MANUAL_CPT', 'TAPS', 'TAP'], ['MANUAL_CPM', 'IMPRESSIONS', 'IMPRESSION']])('creates a guarded %s campaign with whole-currency Money and micros policy deltas', async (strategy, billingEvent, goal) => {
    const { provider, calls, op } = fixture();
    const input = op('apple_create_brand_campaign', { brand_id: 'brand-1', name: 'Maps QA', countries_or_regions: ['US'], strategy, daily_budget: 12.5, currency: 'USD', status: 'ENABLED' });
    const preview = await provider.previewWrite(input, guard);
    expect(preview.budgetDeltas).toEqual([{ target: 'new Maps campaign "Maps QA" daily budget', toMicros: 12_500_000, currency: 'USD' }]);
    expect(preview.coercions).toHaveLength(1);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    await provider.applyWrite(input, guard);
    expect(calls.at(-1)).toMatchObject({ path: 'campaigns', method: 'POST', headers: { 'X-AP-Context': 'adAccountId=1' }, body: { adAccountId: 1, promotedObjectType: 'BUSINESS_BRAND', promotedObjectId: 'brand-1', dailyBudget: { value: { amount: '12.5', currency: 'USD' } }, billingEvent, status: 'PAUSED', bidStrategy: { bidStrategyType: strategy, bidStrategyGoal: goal }, targeting: { supplySource: { include: ['MAPS'] }, countryOrRegion: { include: ['US'] } } } });
    expect((calls.at(-1)!.body.targeting as Record<string, unknown>).supplyPlacement).toBeUndefined();
  });
  it('inherits automatic bidding and requires VALID location groups for the promoted brand', async () => {
    const { provider, calls, op } = fixture();
    const input = op('apple_create_brand_ad_group', { campaign_id: '2', location_group_ids: ['LG-1'], start_time: '2026-11-03T00:00:00.000Z', name: 'Stores', status: 'ENABLED' });
    await provider.applyWrite(input, guard);
    expect(calls.at(-1)).toMatchObject({ path: 'adgroups', method: 'POST', body: { campaignId: 2, name: 'Stores', startTime: '2026-11-03T00:00:00.000', pricingModel: 'CPT', status: 'PAUSED', bidStrategy: { bidStrategyType: 'MAX_ENGAGEMENTS', bidStrategyGoal: 'TAP' }, targeting: { locationGroup: { include: ['LG-1'] } } } });
    const wrong = fixture({ 'location-groups/LG-1': { id: 'LG-1', brandId: 'other', systemStatus: 'VALID' } });
    await expect(wrong.provider.previewWrite(input, guard)).rejects.toThrow('promoted brand');
    expect(wrong.calls.some(call => call.method === 'POST')).toBe(false);
  });
  it('policy-reports a manual Maps group bid and derives CPM pricing from the campaign', async () => {
    const { provider, calls, op } = fixture({ 'campaigns/2': { id: 2, adAccountId: 1, promotedObjectType: 'BUSINESS_BRAND', promotedObjectId: 'brand-1', billingEvent: 'IMPRESSIONS', bidStrategy: { bidStrategyType: 'MANUAL_CPM', bidStrategyGoal: 'IMPRESSION' }, dailyBudget: { value: { amount: '10', currency: 'EUR' } } } });
    const input = op('apple_create_brand_ad_group', { campaign_id: '2', location_group_ids: ['LG-1'], start_time: '2026-11-03T00:00:00.000Z', name: 'Stores', bid: 1.25 });
    expect((await provider.previewWrite(input, guard)).budgetDeltas[0]).toMatchObject({ toMicros: 1_250_000, currency: 'EUR' });
    await provider.applyWrite(input, guard);
    expect(calls.at(-1)!.body).toMatchObject({ pricingModel: 'CPM', bidStrategy: { bid: { amount: '1.25', currency: 'EUR' } } });
  });
  it('creates localized Maps content only with brand-owned assets and place-card destination', async () => {
    const { provider, calls, op } = fixture();
    const input = op('apple_create_brand_creative', { brand_id: 'brand-1', name: 'Summer', subtype: 'BUSINESS_ASSET', asset_ids: ['asset-1'], localized_text: { 'en-US': { promoText: 'Visit today' } }, default_locale: 'en-US' });
    await provider.applyWrite(input, guard);
    expect(calls.at(-1)!.body).toEqual({ name: 'Summer', creativeType: 'LOCAL_ADS_SEARCH_CREATIVE', creativeSpec: { brandId: 'brand-1', creativeSubtype: 'BUSINESS_ASSET', creativeAssets: [{ assetId: 'asset-1' }], localizedText: { 'en-US': { promoText: 'Visit today' } }, defaultLocale: 'en-US' }, destination: { destinationType: 'LOCAL_ADS_PLACECARD' } });
    const foreign = fixture({ 'assets/asset-1': { id: 'asset-1', promotedObjectId: 'other', promotedObjectType: 'BUSINESS_BRAND' } });
    await expect(foreign.provider.previewWrite(input, guard)).rejects.toThrow('selected brand');
    expect(foreign.calls.some(call => call.method === 'POST')).toBe(false);
  });
  it('creates and updates static membership with exact brand checks; rejects mixing dynamic rules', async () => {
    const { provider, calls, op } = fixture();
    await provider.applyWrite(op('apple_create_location_group', { brand_id: 'brand-1', name: 'Stores', group_type: 'STATIC', location_ids: ['loc-1'] }), guard);
    expect(calls.at(-1)!.body).toEqual({ adAccountId: '1', brandId: 'brand-1', name: 'Stores', groupType: 'STATIC', locationIds: ['loc-1'] });
    await provider.applyWrite(op('apple_update_location_group', { location_group_id: 'LG-1', location_ids: ['loc-1'] }, 'update'), guard);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { locationIds: ['loc-1'] } });
    await expect(provider.previewWrite(op('apple_update_location_group', { location_group_id: 'LG-1', rules: [{ field: 'locality', operator: 'IN', value: ['Berlin'] }] }, 'update'), guard)).rejects.toThrow('existing location group type');
    expect(() => op('apple_create_location_group', { brand_id: 'brand-1', name: 'Wrong', group_type: 'DYNAMIC', location_ids: ['loc-1'] })).toThrow();
  });
});
