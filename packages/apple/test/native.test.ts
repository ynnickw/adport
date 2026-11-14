import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppleAdsClient } from '../src/client.js';
import { AppleAdsProvider } from '../src/provider.js';
import { appleTools } from '../src/tools.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentials = { clientId: 'test', teamId: 'test', keyId: 'test', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
function setup(reply: (path: string, method: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ path: string; method: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const client = new AppleAdsClient(credentials, (async (url: string | URL, init: RequestInit = {}) => {
    if (String(url).includes('appleid.apple.com')) return Response.json({ access_token: 'test', expires_in: 3600 });
    const path = String(url).replace('https://api.ads.apple.com/v1/', '');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, method: init.method!, body, headers: init.headers as Record<string, string> });
    return Response.json(reply(path, init.method!, body));
  }) as typeof fetch);
  const provider = new AppleAdsProvider(client);
  const tools = appleTools(provider);
  const call = async (name: string, input: unknown) => {
    const tool = tools.find(tool => tool.name === name)!;
    const value = await tool.handler(tool.input.parse(input) as never, {} as never);
    return tool.output ? tool.output.parse(value) : value;
  };
  return { provider, tools, calls, call };
}

// Contracts checked against Apple-owned Node SDK e81717d1 and real v1 responses, 2026-11-03.
describe('Apple native discovery and reporting', () => {
  it('queries search terms with mandatory campaign scope and ORTZ, preserving suppression and native granular rows', async () => {
    const response = { result: { rows: [{ metadata: { searchTermText: '**', searchTermSource: 'AUTO' }, granularMetrics: [{ date: '2026-11-01', taps: 3 }] }] }, pagination: { totalCount: 4 } };
    const { call, calls } = setup(() => response);
    expect(await call('apple_report', { account_id: '1', campaign_id: '2', entity: 'searchterms', start: '2026-11-01', end: '2026-11-02', granularity: 'DAILY', group_by: ['deviceClass'], limit: 10 })).toEqual(response);
    expect(calls[0]).toMatchObject({ path: 'reports/apps/searchterms/query', method: 'POST', headers: { 'X-AP-Context': 'adAccountId=1' }, body: {
      filters: [{ field: 'campaignId', operator: 'EQUALS', value: ['2'] }], timeRange: { start: '2026-11-01', end: '2026-11-02', timeZone: 'ORTZ', granularity: 'DAILY' }, groupBy: ['deviceClass'], options: { includeRows: ['GRAND_TOTAL'] }, pagination: { offset: 0, pageSize: 10 },
    } });
  });
  it.each([
    { entity: 'searchterms', time_zone: 'UTC' }, { entity: 'searchterms', include_empty: true },
    { entity: 'ads', granularity: 'HOURLY' }, { entity: 'ads', group_by: ['deviceClass'] },
    { entity: 'keywords', group_by: ['ageRange'] }, { entity: 'campaigns', granularity: 'HOURLY', group_by: ['gender'] },
    { entity: 'adgroups', campaign_id: undefined }, { entity: 'campaigns', end: '2026-10-01' },
  ])('rejects unsupported report combinations before HTTP: %j', async override => {
    const { call, calls } = setup(() => ({}));
    await expect(call('apple_report', { account_id: '1', campaign_id: '2', start: '2026-11-01', end: '2026-11-02', ...override })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('encodes app discovery criteria as query values and repeated storefronts', async () => {
    const { call, calls } = setup(() => ({ result: [] }));
    await call('apple_search_apps', { account_id: '1', query: 'Closer & Widgets', adam_ids: ['123', '456'], storefronts: ['DE', 'US'], owned_only: true });
    const url = new URL(`https://api.ads.apple.com/v1/${calls[0]!.path}`);
    expect(url.pathname).toBe('/v1/search/apps');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ query: 'Closer & Widgets', cpids: '123,456', returnOwnedApps: 'true' });
    expect(url.searchParams.getAll('storeFronts')).toEqual(['DE', 'US']);
    await expect(call('apple_search_apps', { account_id: '1' })).rejects.toThrow();
  });
  it('uses source-specific geo search parameters, required promoted object filters and audit event ranges', async () => {
    const { call, calls } = setup(() => ({ result: [] }));
    await call('apple_search_geo', { account_id: '1', query: 'Berlin', supply_source: 'MAPS', entity: 'Locality', country_code: 'DE', eligible_only: true });
    expect(Object.fromEntries(new URL(`https://example.test/${calls[0]!.path}`).searchParams)).toMatchObject({ query: 'Berlin', supplySource: 'MAPS', entity: 'Locality', countrycode: 'DE', eligible: 'true', pageSize: '100' });
    await call('apple_recommendations', { account_id: '1', category: 'daily-budgets', promoted_object_id: '123', promoted_object_type: 'APPSTORE_APP' });
    expect(calls[1]).toMatchObject({ path: 'recommendations/daily-budgets/query', body: { filters: [{ field: 'promotedObjectId', operator: 'EQUALS', value: ['123'] }, { field: 'promotedObjectType', operator: 'EQUALS', value: ['APPSTORE_APP'] }] } });
    await call('apple_change_history', { account_id: '1', entity_types: ['Campaign'], start_time: '2026-11-01T00:00:00Z', end_time: '2026-11-02T00:00:00Z' });
    expect(calls[2]).toMatchObject({ path: 'change-history/query', body: { filters: [{ field: 'entityType', operator: 'IN', value: ['Campaign'] }, { field: 'eventTime', operator: 'BETWEEN', value: ['2026-11-01T00:00:00', '2026-11-02T00:00:00'] }] } });
  });
  it('keeps creative configuration and destination visible with account-bound actions and truthful pagination', async () => {
    const creative = { id: 7, adAccountId: 1, name: 'CPP', creativeType: 'CUSTOM_PRODUCT_PAGE', creativeSpec: {}, destination: { url: 'https://apps.apple.com/app/id123' }, systemStatus: 'VALID' };
    const { call } = setup(() => ({ result: [creative], pagination: { totalCount: 2 } }));
    expect(await call('apple_creatives', { account_id: '1', limit: 1 })).toMatchObject({ result: [creative], truncated: true, creatives: [{ id: '7', type: 'CUSTOM_PRODUCT_PAGE', status: 'VALID', landing_urls: ['https://apps.apple.com/app/id123'], media: [], actions: [{ tool: 'apple_update_creative', arguments: { account_id: '1', creative_id: '7' } }] }] });
    await expect(call('apple_creatives', { account_id: '9' })).rejects.toThrow('another account');
  });
  it('hydrates linked creative destinations from the native ad creativeId instead of fabricating copy or media', async () => {
    const { call, calls } = setup(path => path === 'ads/4' ? { result: { id: 4, adAccountId: 1, creativeId: 7, status: 'PAUSED' } } : { result: [{ id: 7, adAccountId: 1, creativeType: 'DEFAULT_PRODUCT_PAGE', destination: { parameters: { adamId: '123' } } }] });
    expect(await call('apple_ads', { account_id: '1', resource_id: '4' })).toMatchObject({ creatives: [{ id: '4', type: 'DEFAULT_PRODUCT_PAGE', landing_urls: ['https://apps.apple.com/app/id123'], media: [], actions: expect.arrayContaining([{ arguments: { account_id: '1', ad_id: '4' }, fields: expect.any(Array), label: 'Rename', tool: 'apple_update_ad' }]) }] });
    expect(calls[1]).toMatchObject({ path: 'creatives/query', body: { filters: [{ field: 'id', operator: 'IN', value: ['7'] }] } });
  });
  it('uses scalar Adam IDs for eligibility, queryType for suggestions and IN for impression share', async () => {
    const { call, calls } = setup(() => ({ result: [] }));
    await call('apple_app_eligibility', { account_id: '1', adam_id: '123' });
    expect(calls.at(-1)!.body.filters).toEqual([{ field: 'adamId', operator: 'EQUALS', value: 123 }]);
    await call('apple_suggestions', { account_id: '1', category: 'phrases', promoted_object_id: '123', promoted_object_type: 'APPSTORE_APP' });
    expect(calls.at(-1)!.body.filters).toContainEqual({ field: 'queryType', operator: 'EQUALS', value: ['SUGGESTION'] });
    await call('apple_search_suggestions', { account_id: '1', category: 'categories', query: 'travel' });
    expect(calls.at(-1)!.body.filters).toEqual([{ field: 'queryType', operator: 'EQUALS', value: ['SEARCH'] }, { field: 'category', operator: 'LIKE', value: ['travel'] }]);
    await call('apple_impression_share', { account_id: '1', promoted_object_id: '123', start: '2026-10-26', end: '2026-11-01' });
    expect(calls.at(-1)!.body.filters).toEqual([{ field: 'promotedObjectId', operator: 'IN', value: ['123'] }]);
    expect(calls.at(-1)!.body.pagination).toEqual({ offset: 0, pageSize: 100 });
  });
});

describe('Apple normalized metrics', () => {
  it.each([['ad_group', 'adgroups'], ['ad', 'ads']] as const)('scopes %s reports to discovered campaigns and marks row truncation', async (level, path) => {
    const { provider, calls } = setup(resource => resource === 'campaigns/query' ? { result: [{ id: 2 }] } : { result: { rows: [{ metadata: { id: 3, name: 'Test', status: 'PAUSED' }, totalMetrics: { localSpend: { amount: '1.23', currency: 'EUR' }, taps: 2 } }] }, pagination: { totalCount: 3 } });
    expect(await provider.report({ accountIds: ['1'], level, dateRange: 'yesterday', metrics: ['spend', 'conversions', 'conversion_value', 'roas', 'cpc'], limit: 1 })).toMatchObject({ truncated: true, rows: [{ entity: { level, id: '3' }, currency: 'EUR', metrics: { spend: 1.23, cpc: 0.62 } }] });
    expect(calls[1]).toMatchObject({ path: `reports/apps/${path}/query`, body: { filters: [{ field: 'campaignId', operator: 'EQUALS', value: ['2'] }] } });
  });
  it('computes requested account ratios from totals while preserving missing metrics and unavailable revenue', async () => {
    const { provider } = setup(() => ({ result: { rows: [
      { totalMetrics: { localSpend: { amount: '2', currency: 'EUR' }, impressions: 10, taps: 2, totalInstalls: 1 } },
      { totalMetrics: { localSpend: { amount: '8', currency: 'EUR' }, impressions: 90, taps: 8 } },
    ] }, pagination: { totalCount: 2 } }));
    const result = await provider.report({ accountIds: ['1'], level: 'account', metrics: ['ctr', 'cpc', 'cpa', 'conversions', 'conversion_value', 'roas'], dateRange: 'yesterday' });
    expect(result.rows[0]!.metrics).toEqual({ ctr: 10, cpc: 1 });
  });
});

describe('Apple guarded configuration writes', () => {
  const guard = { forcePausedCreation: true };
  it('requires an explicit ad-group start time and refuses immutable campaign source or unsupported exclusion fields', () => {
    const { tools } = setup(() => ({}));
    expect(tools.find(tool => tool.name === 'apple_create_ad_group')!.input.safeParse({ account_id: '1', campaign_id: '2', name: 'Test', bid: 1, currency: 'EUR' }).success).toBe(false);
    const tool = tools.find(tool => tool.name === 'apple_update_targeting')!;
    expect(tool.input.safeParse({ account_id: '1', resource_type: 'campaign', resource_id: '2', targeting: { supplySource: { include: ['MAPS'] } } }).success).toBe(false);
    expect(tool.input.safeParse({ account_id: '1', resource_type: 'campaign', resource_id: '2', targeting: { countryOrRegion: { exclude: ['US'] } } }).success).toBe(false);
  });
  it('rejects deletion of a default product-page creative before any mutation', async () => {
    const { provider, calls } = setup(() => ({ result: { id: 2, adAccountId: 1, creativeType: 'DEFAULT_PRODUCT_PAGE' } }));
    await expect(provider.previewWrite({ tool: 'apple_delete_resource', provider: 'apple', accountId: '1', kind: 'remove', payload: { resource_type: 'creative', resource_id: '2' } }, guard)).rejects.toThrow('cannot be deleted');
    expect(calls.map(call => call.method)).toEqual(['GET']);
  });
  it('renders Maps promo copy and edits one locale while preserving shared assets and other locales', async () => {
    const spec = { brandId: 'brand-1', creativeSubtype: 'BUSINESS_ASSET', creativeAssets: [{ assetId: 'asset-1' }], defaultLocale: 'en-US', localizedText: { 'en-US': { promoText: 'Visit today' }, 'de-DE': { promoText: 'Heute besuchen' } } };
    const creative = { id: 2, adAccountId: 1, creativeType: 'LOCAL_ADS_SEARCH_CREATIVE', creativeSpec: spec };
    const { provider, call, calls } = setup(() => ({ result: creative }));
    expect(await call('apple_creatives', { account_id: '1', resource_id: '2' })).toMatchObject({ creatives: [{ descriptions: ['[en-US] Visit today', '[de-DE] Heute besuchen'], actions: expect.arrayContaining([expect.objectContaining({ tool: 'apple_update_brand_creative_copy', arguments: { account_id: '1', creative_id: '2', locale: 'en-US' } })]) }] });
    await provider.applyWrite({ tool: 'apple_update_brand_creative_copy', provider: 'apple', accountId: '1', kind: 'update', payload: { creative_id: '2', locale: 'en-US', promo_text: 'Explore our stores' } }, guard);
    expect(calls.at(-1)!.body).toEqual({ creativeSpec: { ...spec, localizedText: { ...spec.localizedText, 'en-US': { promoText: 'Explore our stores' } } } });
    await expect(provider.previewWrite({ tool: 'apple_update_brand_creative_copy', provider: 'apple', accountId: '1', kind: 'update', payload: { creative_id: '2', locale: 'fr-FR', promo_text: 'Discover' } }, guard)).rejects.toThrow('locale does not exist');
  });
  it('previews targeting against the current resource and writes only the supplied dimensions, including explicit null clears', async () => {
    const { provider, calls, tools } = setup(() => ({ result: { id: 2, adAccountId: 1, name: 'Test', status: 'PAUSED', targeting: { deviceClass: { include: ['IPHONE'] }, gender: { include: ['F'] } } } }));
    const tool = tools.find(tool => tool.name === 'apple_update_targeting')!;
    expect(tool.input.safeParse({ account_id: '1', resource_type: 'campaign', resource_id: '2', targeting: { deviceClass: null } }).success).toBe(false);
    const op = { tool: tool.name, provider: 'apple', accountId: '1', kind: 'update' as const, payload: { resource_type: 'ad_group', resource_id: '2', targeting: { deviceClass: { include: ['IPAD'] }, gender: null } } };
    const preview = await provider.previewWrite(op, guard);
    expect(preview.changes[0]).toContain('IPHONE');
    expect(calls.map(call => call.method)).toEqual(['GET']);
    await provider.applyWrite(op, guard);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: 'adgroups/2', body: { targeting: op.payload.targeting } });
  });
  it.each([
    ['apple_update_ad', { ad_id: '2', name: 'New name' }, 'ads', { name: 'New name' }],
    ['apple_update_creative', { creative_id: '2', creative_spec: { example: 'native spec' } }, 'creatives', { creativeSpec: { example: 'native spec' } }],
    ['apple_set_search_match', { ad_group_id: '2', enabled: false }, 'adgroups', { automatedKeywordsOptIn: false }],
  ] as const)('uses minimal updates for %s and rechecks ownership on apply', async (tool, payload, collection, body) => {
    const { provider, calls } = setup(() => ({ result: { id: 2, adAccountId: 1, name: 'Before', status: 'PAUSED' } }));
    const op = { tool, provider: 'apple', accountId: '1', kind: 'update' as const, payload };
    await provider.previewWrite(op, guard);
    await provider.applyWrite(op, guard);
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET', 'PUT']);
    expect(calls.at(-1)).toMatchObject({ path: `${collection}/2`, body });
    await expect(provider.previewWrite({ ...op, accountId: '9' }, guard)).rejects.toThrow('selected ad account');
  });
  it('refuses to disable required automated keywords and permanently deletes only an identified resource', async () => {
    const { provider, calls } = setup(() => ({ result: { id: 2, adAccountId: 1, automatedKeywordsRequired: true } }));
    await expect(provider.previewWrite({ tool: 'apple_set_search_match', provider: 'apple', accountId: '1', kind: 'update', payload: { ad_group_id: '2', enabled: false } }, guard)).rejects.toThrow('requires automated keywords');
    await provider.applyWrite({ tool: 'apple_delete_resource', provider: 'apple', accountId: '1', kind: 'remove', payload: { resource_type: 'creative', resource_id: '2' } }, guard);
    expect(calls.at(-1)).toMatchObject({ path: 'creatives/2', method: 'DELETE', body: {} });
  });
});
