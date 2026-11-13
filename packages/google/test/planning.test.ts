import { createContext, type ToolContext } from '@adport/core';
import { describe, expect, it, vi } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Wire shapes checked against Google's v25 keyword_plan_idea_service.proto,
// GenerateKeywordIdeasRequest / GenerateKeywordHistoricalMetricsRequest (2026-11-03).
async function runtime(reply: unknown = {}, authorizeToolCall?: ToolContext['authorizeToolCall']) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(String(url).includes('oauth2.googleapis.com') ? { access_token: 'token', expires_in: 3600 } : reply);
  }) as unknown as typeof fetch;
  const client = new GoogleAdsRestClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh',
    loginCustomerId: '9999999999', loginCustomerIds: { '1234567890': '8888888888' } }, 'v25', fetchImpl);
  const provider = new GoogleAdsProvider(client);
  return { ...await createContext({ providerModules: [{ provider, tools: googleTools(provider) }], authorizeToolCall }), calls };
}

describe('Google keyword planning', () => {
  it.each([
    [{ type: 'keywords', keywords: ['app launch'] }, { keywordSeed: { keywords: ['app launch'] } }],
    [{ type: 'url', url: 'https://example.com/apps' }, { urlSeed: { url: 'https://example.com/apps' } }],
    [{ type: 'keywords_and_url', keywords: ['app'], url: 'https://example.com' }, { keywordAndUrlSeed: { keywords: ['app'], url: 'https://example.com' } }],
    [{ type: 'site', url: 'https://example.com' }, { siteSeed: { site: 'https://example.com' } }],
  ])('sends exactly one native seed and the account-specific manager for %j', async (seed, wireSeed) => {
    const rt = await runtime({ results: [{ text: 'app launch', keywordIdeaMetrics: { avgMonthlySearches: '9007199254740993' } }], nextPageToken: 'next', totalSize: '9007199254740994' });
    const result = await rt.registry.call('google_keyword_ideas', { account_id: '123-456-7890', seed, language_id: '1000', location_ids: ['2276'], page_size: 2, page_token: 'page-two' }, rt.ctx);
    const request = rt.calls.at(-1)!;
    expect(request.url).toBe('https://googleads.googleapis.com/v25/customers/1234567890:generateKeywordIdeas');
    expect(request.init.headers).toMatchObject({ 'login-customer-id': '8888888888', authorization: 'Bearer token' });
    expect(JSON.parse(String(request.init.body))).toEqual({ ...wireSeed, language: 'languageConstants/1000', geoTargetConstants: ['geoTargetConstants/2276'],
      keywordPlanNetwork: 'GOOGLE_SEARCH', includeAdultKeywords: false, historicalMetricsOptions: { includeAverageCpc: false }, pageSize: 2, pageToken: 'page-two' });
    expect(result).toEqual({ results: [{ text: 'app launch', keywordIdeaMetrics: { avgMonthlySearches: '9007199254740993' } }], next_page_token: 'next', total_size: '9007199254740994', truncated: true });
    expect(rt.calls).toHaveLength(2);
    expect(rt.registry.get('google_keyword_ideas').annotations).toMatchObject({ readOnly: true, destructive: false });
  });

  it('preserves merged variants, native micros and unavailable metrics without adding a plan or mutating', async () => {
    const results = [{ text: 'cars', closeVariants: ['car'], keywordMetrics: { lowTopOfPageBidMicros: '1200000', monthlySearchVolumes: [{ year: '2026', month: 'JANUARY' }] } }];
    const rt = await runtime({ results });
    expect(await rt.registry.call('google_keyword_historical_metrics', { account_id: '1234567890', keywords: ['car', 'cars'], include_average_cpc: true, network: 'GOOGLE_SEARCH_AND_PARTNERS' }, rt.ctx)).toEqual({ results, truncated: false });
    const request = rt.calls.at(-1)!;
    expect(request.url.endsWith('/customers/1234567890:generateKeywordHistoricalMetrics')).toBe(true);
    expect(JSON.parse(String(request.init.body))).toEqual({ keywords: ['car', 'cars'], geoTargetConstants: [], keywordPlanNetwork: 'GOOGLE_SEARCH_AND_PARTNERS', includeAdultKeywords: false, historicalMetricsOptions: { includeAverageCpc: true } });
    expect(rt.calls.some(call => /mutate|keywordPlans/.test(call.url))).toBe(false);
  });

  it('uses the native continuation token even on an empty page and does not request the next page itself', async () => {
    const rt = await runtime({ nextPageToken: 'continue' });
    expect(await rt.registry.call('google_keyword_ideas', { account_id: '1234567890', seed: { type: 'keywords', keywords: ['app'] } }, rt.ctx)).toEqual({ results: [], next_page_token: 'continue', truncated: true });
    expect(rt.calls).toHaveLength(2);
  });

  it('rejects an invalid provider result instead of inventing empty metrics', async () => {
    const rt = await runtime({ results: 'invalid' });
    await expect(rt.registry.call('google_keyword_historical_metrics', { account_id: '1234567890', keywords: ['app'] }, rt.ctx)).rejects.toThrow('invalid response shape');
  });

  it.each([
    { seed: { type: 'keywords', keywords: [] } },
    { seed: { type: 'url', url: 'https://user:secret@example.com' } },
    { seed: { type: 'url', url: 'file:///private/file' } },
    { seed: { type: 'keywords', keywords: ['app'] }, location_ids: Array(11).fill('1') },
    { seed: { type: 'keywords', keywords: ['app'] }, page_size: 10001 },
  ])('validates seed and native limits before any request: %j', async (input) => {
    const rt = await runtime();
    await expect(rt.registry.call('google_keyword_ideas', { account_id: '1234567890', ...input }, rt.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(rt.calls).toHaveLength(0);
  });

  it('runs the existing account authorization boundary before requesting keyword data', async () => {
    const rt = await runtime({}, () => { throw new Error('Account not enabled'); });
    await expect(rt.registry.call('google_keyword_ideas', { account_id: '1234567890', seed: { type: 'keywords', keywords: ['app'] } }, rt.ctx)).rejects.toThrow('Account not enabled');
    expect(rt.calls).toHaveLength(0);
  });
});
