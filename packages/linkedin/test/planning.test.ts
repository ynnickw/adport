import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '@adport/core';
import { LinkedInAdsClient } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';
import { forecastInput, pricingInput } from '../src/planning.js';

// Native Marketing202608 wire contracts: LinkedIn Ad Budget Pricing,
// Ad Supply Forecasts and Allowable Type Combinations, fetched2026-11-04.
const A = '518121035', C = '145282384', NOW = 1_800_000_000_000, START = NOW + 86_400_000, END = START + 7 * 86_400_000;
const targeting = { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278'] } }] }, exclude: { or: { 'urn:li:adTargetingFacet:staffCountRanges': ['urn:li:staffCountRange:(10001,2147483647)'] } } };
const money = (amount: string, currencyCode = 'EUR') => ({ amount, currencyCode });
const prices = { bidLimits: { min: money('4.0'), max: money('100.0') }, dailyBudgetLimits: { min: money('10.00'), max: money('1000000.00'), default: money('25.00') }, suggestedBid: { min: money('7.10'), max: money('11.14'), default: money('7.10') } };
const point = { timestamp: START, value: 180, adForecastRange: { lowEnd: 38, highEnd: 210 } };
const forecast = { elements: [{ metricType: 'IMPRESSION', granularity: 'DAILY', timeSeries: [point] }], paging: { start: 0, count: 10, links: [] } };
const pricingArgs = { account_id: A, campaign_type: 'SPONSORED_UPDATES' as const, bid_type: 'CPM' as const, targeting_criteria: targeting };
const forecastArgs = { account_id: A, campaign_type: 'SPONSORED_UPDATES' as const, targeting_criteria: targeting, time_range: { start: START, end: END }, daily_budget_micros: 10_000_001, competing_bid: { bid_type: 'CPM' as const, bid_micros: 1_000_001 } };
type Call = { url: URL; init: RequestInit };
function fixture(handler?: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new LinkedInAdsClient({ accessToken: 'qa-access' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.url.pathname === `/rest/adAccounts/${A}`) return Response.json({ id: Number(A), name: 'QA advertiser', currency: 'EUR', status: 'DRAFT' });
    if (call.url.pathname === `/rest/adAccounts/${A}/adCampaigns/${C}`) return Response.json({ id: Number(C), account: `urn:li:sponsoredAccount:${A}`, name: 'QA campaign', status: 'PAUSED' });
    if (call.url.pathname === '/rest/adBudgetPricing') return Response.json({ elements: [prices], paging: { start: 0, count: 10, links: [] } });
    if (call.url.pathname === '/rest/adSupplyForecasts') return Response.json(forecast);
    throw new Error(`Unexpected ${init.method} ${call.url.pathname}`);
  });
  return { provider: new LinkedInAdsProvider(client), calls };
}
afterEach(() => vi.restoreAllMocks());

describe('LinkedIn native planning reads', () => {
  it('registers named read-only planning views without contacting the provider', () => {
    const tools = linkedinTools(new Proxy({} as LinkedInAdsProvider, { get() { throw new Error('eager native access'); } }));
    for (const name of ['linkedin_budget_pricing', 'linkedin_supply_forecast']) expect(tools.find(tool => tool.name === name)).toMatchObject({ presentation: 'planning', annotations: { readOnly: true, destructive: false } });
    expect(pricingInput.safeParse({ ...pricingArgs, objective_type: 'WEBSITE_VISITS' }).success).toBe(false);
    expect(pricingInput.safeParse({ ...pricingArgs, country_code: 'US' }).success).toBe(false);
  });
  it('uses account currency, native finder/version headers and structured Rest.li with encoded range leaves', async () => {
    const { provider, calls } = fixture();
    const result = await provider.planning.pricing({ ...pricingArgs, country_code: 'us', daily_budget_micros: 300_000_001, objective_type: 'WEBSITE_VISIT', optimization_target_type: 'MAX_CLICK' });
    const request = calls.at(-1)!;
    expect(request.init).toMatchObject({ method: 'GET', redirect: 'error', headers: { authorization: 'Bearer qa-access', 'Linkedin-Version': '202608', 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'FINDER' } });
    expect(request.init.body).toBeUndefined();
    expect(Object.fromEntries(request.url.searchParams)).toMatchObject({ q: 'criteriaV2', account: `urn:li:sponsoredAccount:${A}`, campaignType: 'SPONSORED_UPDATES', bidType: 'CPM', currency: 'EUR', countryCode: 'us', matchType: 'EXACT', dailyBudget: '(amount:300.000001,currencyCode:EUR)', objectiveType: 'WEBSITE_VISIT', optimizationTargetType: 'MAX_CLICK' });
    expect(request.url.href).toContain('urn%3Ali%3AstaffCountRange%3A%2810001%2C2147483647%29');
    expect(request.url.href).toContain('targetingCriteria=(include:(and:List(');
    expect(result.planning.rows[0]).toMatchObject({ minimum: '4.0', maximum: '100.0', suggested: null, unit: 'EUR per 1,000 impressions' });
    expect(result.planning.rows[1]?.unit).toBe('EUR per day');
    expect(result.planning.notes.join(' ')).toContain('not universally a hard rejection');
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('preserves exact sub-micro and oversized native decimals without rounding or inventing micros', async () => {
    const { provider } = fixture(call => call.url.pathname === '/rest/adBudgetPricing' ? { elements: [{ suggestedBid: { min: money('7.10000001'), max: money('9007199254740992.001'), default: money('7.12345678') } }] } : undefined);
    const result = await provider.planning.pricing(pricingArgs);
    expect(result.planning.rows[0]).toMatchObject({ minimum: '7.10000001', maximum: '9007199254740992.001', suggested: '7.12345678' });
    expect(result.planning.notes.join(' ')).toContain('no rounding');
  });
  it.each([{ bidLimits: { min: money('4', 'USD') } }, { bidLimits: { min: money('10'), max: money('9') } }, { suggestedBid: { min: money('1'), max: money('2'), default: money('3') } }])('rejects mixed currency/inverted pricing bounds %#', async row => {
    const { provider } = fixture(call => call.url.pathname === '/rest/adBudgetPricing' ? { elements: [row] } : undefined);
    await expect(provider.planning.pricing(pricingArgs)).rejects.toThrow('linkedin: pricing');
  });
  it('keeps empty/partial responses explicit instead of fabricating zero or claiming completion', async () => {
    const { provider } = fixture(call => call.url.pathname === '/rest/adBudgetPricing' ? { elements: [], paging: { start: 0, count: 10, total: 2, links: [{ rel: 'next' }] } } : undefined);
    const result = await provider.planning.pricing(pricingArgs); expect(result.truncated).toBe(true); expect(result.planning.rows).toEqual([]); expect(result.planning.notes.join(' ')).toContain('no pricing amounts');
  });
  it('verifies advertiser ID before requesting pricing', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/rest/adAccounts/${A}` ? { id: 99, name: 'Foreign', currency: 'EUR', status: 'ACTIVE' } : undefined);
    await expect(provider.planning.pricing(pricingArgs)).rejects.toThrow('ID mismatch'); expect(calls).toHaveLength(1);
  });
  it('uses exact future range, account-currency Money and explicit inventory flags for manual forecasts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { provider, calls } = fixture();
    const result = await provider.planning.forecast({ ...forecastArgs, campaign_id: C, objective_type: 'BRAND_AWARENESS', creative_type: 'STANDARD_UPDATE', enable_audience_expansion: true });
    const request = calls.at(-1)!;
    expect(request.url.pathname).toBe('/rest/adSupplyForecasts'); expect(Object.fromEntries(request.url.searchParams)).toMatchObject({ q: 'criteriaV2', account: `urn:li:sponsoredAccount:${A}`, campaign: `urn:li:sponsoredCampaign:${C}`, timeRange: `(start:${START},end:${END})`, dailyBudget: '(amount:10.000001,currencyCode:EUR)', competingBid: '(bidType:CPM,bidPrice:(amount:1.000001,currencyCode:EUR))', optimizationTarget: 'NONE', enableAudienceNetwork: 'false', enableAudienceExpansion: 'true', connectedTelevisionOnly: 'false' });
    expect(result.planning.rows[0]).toMatchObject({ metric: 'IMPRESSION', period: 'DAILY', value: '180', low: '38', high: '210', unit: 'count', timestamp: new Date(START).toISOString() });
    expect(result.request.time_range).toEqual({ start: START, end: END }); expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('preserves native per-million metrics, zero, missing values and overlapping periods', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const entries = [
      { metricType: 'COST_PER_MILLION_CLICKS', granularity: 'DAILY', timeSeries: [{ timestamp: START, value: 1_234_567 }] },
      { metricType: 'CLICK_PER_MILLION_IMPRESSIONS', granularity: 'DAILY', timeSeries: [{ timestamp: START, value: 0, adForecastRange: { lowEnd: 0, highEnd: 0 } }] },
      { metricType: 'IMPRESSION', granularity: 'SEVEN_DAY', timeSeries: [{ timestamp: START, value: null }] },
      { metricType: 'SPENDING', granularity: 'CUSTOM', timeSeries: [{ timestamp: START }] },
      { metricType: 'FUTURE_NATIVE_METRIC', granularity: 'DAILY', timeSeries: [{ timestamp: START, value: 20 }] },
    ];
    const { provider } = fixture(call => call.url.pathname === '/rest/adSupplyForecasts' ? { elements: entries } : undefined);
    const result = await provider.planning.forecast(forecastArgs);
    expect(result.planning.rows.map(row => row.value)).toEqual(['1234567', '0', null, null, '20']);
    expect(result.planning.rows.map(row => row.unit)).toEqual(['EUR per 1,000,000 clicks', 'CLICK per 1,000,000 impressions', 'count', 'EUR currency units', 'native unit not documented']);
    expect(result.planning.notes.join(' ')).toContain('do not add them together');
  });
  it.each([
    { optimization_target: 'MAX_IMPRESSION', competing_bid: undefined },
    { optimization_target: 'TARGET_COST_PER_CLICK', competing_bid: undefined, target_cost_micros: 1_000_001 },
    { optimization_target: 'CAP_COST_AND_MAXIMIZE_IMPRESSIONS', competing_bid: undefined, cost_cap_micros: 2_000_001 },
  ] as const)('encodes native auto/target/cap forecasting without a manual bid: %s', async extra => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { provider, calls } = fixture(); await provider.planning.forecast({ ...forecastArgs, ...extra });
    const query = calls.at(-1)!.url.searchParams; expect(query.has('competingBid')).toBe(false); expect(query.get('optimizationTarget')).toBe(extra.optimization_target);
    if ('target_cost_micros' in extra) expect(query.get('targetCost')).toBe('1.000001');
    if ('cost_cap_micros' in extra) expect(query.get('costCap')).toBe('2.000001');
  });
  it.each([
    { daily_budget_micros: undefined }, { competing_bid: undefined },
    { optimization_target: 'MAX_IMPRESSION' }, { target_cost_micros: 1 },
    { optimization_target: 'TARGET_COST_PER_CLICK', competing_bid: undefined },
    { optimization_target: 'CAP_COST_AND_MAXIMIZE_CLICKS', competing_bid: undefined },
    { connected_television_only: true }, { campaign_type: 'TEXT_AD' },
    { time_range: { start: END, end: START } }, { daily_budget_micros: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects incomplete or contradictory native forecast inputs before fetch %#', async extra => {
    const { provider, calls } = fixture(); await expect(provider.planning.forecast({ ...forecastArgs, ...extra } as never)).rejects.toThrow(); expect(calls).toEqual([]);
  });
  it('rejects a past start and a foreign campaign before requesting any forecast', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(START);
    const past = fixture(); await expect(past.provider.planning.forecast(forecastArgs)).rejects.toThrow('after the current'); expect(past.calls).toEqual([]);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const foreign = fixture(call => call.url.pathname.endsWith(`/adCampaigns/${C}`) ? { id: Number(C), account: 'urn:li:sponsoredAccount:999', name: 'Foreign', status: 'PAUSED' } : undefined);
    await expect(foreign.provider.planning.forecast({ ...forecastArgs, campaign_id: C })).rejects.toThrow(); expect(foreign.calls.some(call => call.url.pathname.endsWith('/adSupplyForecasts'))).toBe(false);
  });
  it.each([
    { elements: [{ ...forecast.elements[0], timeSeries: [point, point] }], error: 'repeated' },
    { elements: [{ ...forecast.elements[0], timeSeries: [{ ...point, adForecastRange: { lowEnd: 10, highEnd: 1 } }] }], error: 'inverted' },
    { elements: [{ ...forecast.elements[0], timeSeries: [{ ...point, timestamp: Number.MAX_SAFE_INTEGER }] }], error: 'malformed API response' },
    { elements: [{ ...forecast.elements[0], timeSeries: [{ ...point, value: -1 }] }], error: 'malformed API response' },
  ])('rejects repeated or malformed native forecast points %#', async ({ elements, error }) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW); const { provider } = fixture(call => call.url.pathname === '/rest/adSupplyForecasts' ? { elements } : undefined);
    await expect(provider.planning.forecast(forecastArgs)).rejects.toThrow(error);
  });
  it('preserves a native forecast denial and performs no mutation or automatic replay', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW); const { provider, calls } = fixture(call => call.url.pathname === '/rest/adSupplyForecasts' ? Response.json({ code: 'END_DATE_MAX_HORIZON_FOR_FORECAST', status: 422, message: 'Unsupported horizon' }, { status: 422 }) : undefined);
    await expect(provider.planning.forecast(forecastArgs)).rejects.toThrow('HTTP 422'); expect(calls.filter(call => call.url.pathname.endsWith('/adSupplyForecasts'))).toHaveLength(1); expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('runs real registry reads behind the hosted account authorizer without an approval token', async () => {
    const { provider, calls } = fixture(), authorize = vi.fn(async (): Promise<void> => { throw new Error('Account not enabled'); });
    const runtime = await createContext({ providerModules: [{ provider, tools: linkedinTools(provider) }], authorizeToolCall: authorize });
    await expect(runtime.registry.call('linkedin_budget_pricing', pricingArgs, runtime.ctx)).rejects.toThrow('Account not enabled'); expect(calls).toEqual([]);
    authorize.mockImplementation(async () => {});
    const result = await runtime.registry.call('linkedin_budget_pricing', pricingArgs, runtime.ctx) as Record<string, unknown>;
    expect(result).not.toHaveProperty('pending_operation_id'); expect(result.planning).toBeDefined();
    expect(forecastInput.safeParse({ ...forecastArgs, connected_television_only: true, enable_audience_network: true }).success).toBe(true);
  });
});
