import { describe, expect, it } from 'vitest';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// MicrosoftDocs/Advertising@fdee2fcf: Ad Insight REST v13 and derived JSON types.
type Row = Record<string, unknown>;
type Call = { path: string; url: string; body: Row; init: RequestInit };
const account = '777', target = { account_id: account, language: 'English', location_ids: ['190'], network: 'OwnedAndOperatedAndSyndicatedSearch' } as const;
function fixture(override?: (call: Call) => unknown, sandbox = false) {
  const calls: Call[] = [];
  const client = new MicrosoftAdsClient({ developerToken: 'dev', clientId: 'client', refreshToken: 'refresh', sandbox }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    const call = { path: url.pathname.replace(/^.*\/v13\//, ''), url: String(input), body: JSON.parse(String(init.body ?? '{}')) as Row, init }; calls.push(call);
    const custom = override?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (call.path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001', CurrencyCode: 'EUR' }] });
    if (call.path === 'KeywordIdeas/Query') return Response.json({ KeywordIdeas: [{ Keyword: 'ad tools', Competition: 'Medium', MonthlySearchCounts: ['100', '0', null], SuggestedBid: 1.25, AdGroupId: '-1' }] });
    if (call.path === 'KeywordTrafficEstimates/Query') return Response.json({ CampaignEstimates: [{ AdGroupEstimates: [{ KeywordEstimates: [{ Keyword: { Text: 'ad tools', MatchType: 'Phrase' }, Minimum: { AverageCpc: 0.5, Clicks: 5 }, Maximum: null }] }] }] });
    throw new Error(`Unexpected native path ${call.path}`);
  });
  return { provider: new MicrosoftAdsProvider(client), calls };
}
const input = () => ({ ...target, location_ids: [...target.location_ids], keywords: ['ad tools'], limit: 100 });

describe('Microsoft read-only keyword planning', () => {
  it('uses lazy definitions, native language/network enums and read-only annotations', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    const planning = tools.filter(value => /microsoft_keyword_(ideas|historical_metrics|traffic_estimates)$/.test(value.name));
    expect(planning).toHaveLength(3); expect(planning.every(value => value.annotations?.readOnly)).toBe(true);
    const schema = planning.find(value => value.name === 'microsoft_keyword_ideas')!.input;
    expect(schema.safeParse({ ...input(), network: undefined }).success).toBe(true);
    expect(schema.safeParse({ ...input(), keywords: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...input(), language: 'en' }).success).toBe(false);
    expect(schema.safeParse({ ...input(), network: 'SyndicatedSearchOnly' }).success).toBe(false);
    expect(schema.safeParse({ ...input(), date_range: { start: '2026-02-30', end: '2026-03-01' } }).success).toBe(false);
    expect(schema.safeParse({ ...input(), date_range: { start: '2026-03-01', end: '2026-02-28' } }).success).toBe(false);
  });

  it('uses the scoped AdInsight host and arrays of concrete search parameters', async () => {
    const f = fixture(), output = await f.provider.planning.keywordIdeas({ ...input(), date_range: { start: '2026-01-01', end: '2026-09-30' } }, true), call = f.calls.at(-1)!;
    expect(call.url).toBe('https://adinsight.api.bingads.microsoft.com/AdInsight/v13/KeywordIdeas/Query');
    expect(call.init).toMatchObject({ method: 'POST', headers: { CustomerAccountId: account, CustomerId: '9001', DeveloperToken: 'dev' } });
    expect(call.body).toMatchObject({ ExpandIdeas: true, SearchParameters: [
      { Type: 'LanguageSearchParameter', Languages: [{ Type: 'LanguageCriterion', Language: 'English' }] },
      { Type: 'LocationSearchParameter', Locations: [{ Type: 'LocationCriterion', LocationId: '190' }] },
      { Type: 'NetworkSearchParameter', Network: { Type: 'NetworkCriterion', Network: target.network } },
      { Type: 'QuerySearchParameter', Queries: ['ad tools'] },
      { Type: 'DateRangeSearchParameter', StartDate: { Year: 2026, Month: 1, Day: 1 }, EndDate: { Year: 2026, Month: 9, Day: 30 } },
    ] });
    expect(call.body.IdeaAttributes).toContain('Competition');
    expect(output.rows[0]).toMatchObject({ AdGroupId: '-1', MonthlySearchCounts: ['100', '0', null], SuggestedBid: 1.25 });
    expect(output).toMatchObject({ returned_count: 1, native_result_count: 1, truncated: false, currency: 'EUR', date_range: { start: '2026-01-01', end: '2026-09-30' } });
  });

  it('uses nonexpanding ideas for history and does not invent calendar labels or fill missing metrics', async () => {
    const f = fixture(call => call.path === 'KeywordIdeas/Query' ? { KeywordIdeas: [{ Keyword: 'ad tools', Competition: null }] } : undefined);
    const output = await f.provider.planning.keywordIdeas(input(), false);
    expect(f.calls.at(-1)!.body.ExpandIdeas).toBe(false);
    expect(output.rows).toEqual([{ Keyword: 'ad tools', Competition: null }]);
    expect(output).not.toHaveProperty('date_range'); expect(output.notes.join(' ')).toContain('exact calendar months cannot be identified');
  });

  it('sends URL and category seeds without manufacturing a query seed', async () => {
    const f = fixture();
    await f.provider.planning.keywordIdeas({ ...input(), keywords: undefined, url: 'https://example.com', category_id: '100' }, true);
    expect(f.calls.at(-1)!.body.SearchParameters).toContainEqual({ Type: 'UrlSearchParameter', Url: 'https://example.com' });
    expect(f.calls.at(-1)!.body.SearchParameters).toContainEqual({ Type: 'CategorySearchParameter', CategoryId: '100' });
    expect((f.calls.at(-1)!.body.SearchParameters as Row[]).some(value => value.Type === 'QuerySearchParameter')).toBe(false);
  });

  it('makes truncation explicit without inventing an unsupported continuation', async () => {
    const f = fixture(call => call.path === 'KeywordIdeas/Query' ? { KeywordIdeas: [{ Keyword: 'one' }, { Keyword: 'two' }] } : undefined);
    const output = await f.provider.planning.keywordIdeas({ ...input(), limit: 1 }, true);
    expect(output).toMatchObject({ rows: [{ Keyword: 'one' }], returned_count: 1, native_result_count: 2, truncated: true }); expect(output).not.toHaveProperty('next_cursor');
  });

  it('builds hypothetical traffic estimators in account units without IDs or mutation fields', async () => {
    const f = fixture(), output = await f.provider.planning.trafficEstimates({ ...target, location_ids: [...target.location_ids], max_cpc: 1.5, daily_budget: 20, keywords: [{ text: 'ad tools', match_type: 'Phrase' }, { text: 'paid media', match_type: 'Broad', max_cpc: 2 }], negative_keywords: [{ text: 'free', match_type: 'Exact' }] });
    expect(f.calls.at(-1)!).toMatchObject({ url: 'https://adinsight.api.bingads.microsoft.com/AdInsight/v13/KeywordTrafficEstimates/Query', body: { CampaignEstimators: [{ AdGroupEstimators: [{ MaxCpc: 1.5, KeywordEstimators: [{ Keyword: { Text: 'ad tools', MatchType: 'Phrase' } }, { Keyword: { Text: 'paid media', MatchType: 'Broad' }, MaxCpc: 2 }] }], DailyBudget: 20, NegativeKeywords: [{ Text: 'free', MatchType: 'Exact' }], Criteria: [{ Type: 'LanguageCriterion', Language: 'English' }, { Type: 'NetworkCriterion', Network: target.network }, { Type: 'LocationCriterion', LocationId: '190' }] }] } });
    expect(JSON.stringify(f.calls.at(-1)!.body)).not.toMatch(/CampaignId|AdGroupId|Status/); expect(output.rows[0]).toHaveProperty('AdGroupEstimates');
    expect(output).toMatchObject({ estimate_period: 'week', deprecated_metrics: ['AveragePosition'] }); expect(output.notes.join(' ')).toContain('2021-03-31');
    expect(f.calls.every(value => !/\/(CampaignManagement|Reporting)\//.test(value.url))).toBe(true);
  });

  it('rejects unsupported Exact traffic estimates before any native request', async () => {
    const f = fixture(); await expect(f.provider.planning.trafficEstimates({ ...target, location_ids: [...target.location_ids], max_cpc: 1, keywords: [{ text: 'ad tools', match_type: 'Exact' }] } as never)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it('uses the native sandbox host and refuses unverifiable account scope', async () => {
    const f = fixture(undefined, true); await f.provider.planning.keywordIdeas(input(), true);
    expect(f.calls.at(-1)!.url).toContain('https://adinsight.api.sandbox.bingads.microsoft.com/AdInsight/v13/');
    expect(f.calls.at(-1)!.init.headers).toMatchObject({ DeveloperToken: 'BBD37VB98' });
    const foreign = fixture(); await expect(foreign.provider.planning.keywordIdeas({ ...input(), account_id: '888' }, true)).rejects.toThrow('ownership');
    expect(foreign.calls.some(value => value.path === 'KeywordIdeas/Query')).toBe(false);
  });

  it('does not mistake a missing native envelope for a successful empty result', async () => {
    const f = fixture(call => call.path.endsWith('/Query') && call.path.startsWith('Keyword') ? { Type: 'ApiFaultDetail', OperationErrors: [{ Code: 1, Message: 'Native fault' }] } : undefined);
    await expect(f.provider.planning.keywordIdeas(input(), true)).rejects.toThrow('result envelope');
    await expect(f.provider.planning.trafficEstimates({ ...target, location_ids: [...target.location_ids], max_cpc: 1, keywords: [{ text: 'ad tools', match_type: 'Phrase' }] })).rejects.toThrow('result envelope');
  });
});
