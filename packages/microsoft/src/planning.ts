import { AdportError, defineTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import { MicrosoftAdsClient, type RequestScope } from './client.js';
import { MicrosoftNativeService, microsoftId as id, microsoftRows as rows, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const text = z.string().min(1).max(100).refine(value => value.trim().length > 0, 'Keyword cannot be blank');
const keywords = z.array(text).min(1).max(200);
const date = z.iso.date();
const dateRange = z.object({ start: date, end: date }).refine(value => value.start <= value.end, 'Start date must not follow end date');
const targeting = z.object({ account_id: id, language: z.enum(['English', 'French', 'German']), location_ids: z.array(id).min(1).max(2000).refine(value => new Set(value).size === value.length, 'Location IDs must be unique'), network: z.enum(['OwnedAndOperatedAndSyndicatedSearch', 'OwnedAndOperatedOnly']).default('OwnedAndOperatedAndSyndicatedSearch') });
const baseIdeas = targeting.extend({ date_range: dateRange.optional(), limit: z.number().int().positive().max(3000).default(100) });
const ideas = baseIdeas.extend({ keywords: keywords.optional(), url: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, 'Use an HTTPS URL without credentials').optional(), category_id: id.optional() }).refine(value => value.keywords !== undefined || value.url !== undefined || value.category_id !== undefined, 'Supply keyword, URL or category seeds');
const historical = baseIdeas.extend({ keywords });
const traffic = targeting.extend({ keywords: z.array(z.object({ text, match_type: z.enum(['Phrase', 'Broad']), max_cpc: z.number().positive().optional() })).min(1).max(1000), max_cpc: z.number().positive(), daily_budget: z.number().positive().optional(), negative_keywords: z.array(z.object({ text, match_type: z.enum(['Exact', 'Phrase']) })).max(1000).optional() });
const ideasOutput = z.object({ rows: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean(), returned_count: z.number().int().nonnegative(), native_result_count: z.number().int().nonnegative(), currency: z.string().optional(), date_range: dateRange.optional(), notes: z.array(z.string()) });
const parts = (value: string) => { const [Year, Month, Day] = value.split('-').map(Number); return { Year, Month, Day }; };
function criteria(input: z.infer<typeof targeting>): Row[] {
  return [{ Type: 'LanguageCriterion', Language: input.language }, { Type: 'NetworkCriterion', Network: input.network }, ...input.location_ids.map(LocationId => ({ Type: 'LocationCriterion', LocationId }))];
}

/** Ad Insight REST v13 shapes from MicrosoftDocs/Advertising@fdee2fcf. */
export class MicrosoftPlanningService extends MicrosoftNativeService {
  constructor(client: MicrosoftAdsClient, scope: (account: string) => Promise<RequestScope>, lookupCampaign: (account: string, campaign: string) => Promise<unknown>, private readonly currency: (account: string) => string | undefined) { super(client, scope, lookupCampaign); }
  async keywordIdeas(input: z.infer<typeof ideas> | z.infer<typeof historical>, expand: boolean) {
    const value = expand ? ideas.parse(input) : historical.parse(input);
    const parameters: Row[] = [{ Type: 'LanguageSearchParameter', Languages: [{ Type: 'LanguageCriterion', Language: value.language }] }, { Type: 'LocationSearchParameter', Locations: value.location_ids.map(LocationId => ({ Type: 'LocationCriterion', LocationId })) }, { Type: 'NetworkSearchParameter', Network: { Type: 'NetworkCriterion', Network: value.network } }];
    if (value.keywords) parameters.push({ Type: 'QuerySearchParameter', Queries: value.keywords });
    if ('url' in value && value.url) parameters.push({ Type: 'UrlSearchParameter', Url: value.url });
    if ('category_id' in value && value.category_id) parameters.push({ Type: 'CategorySearchParameter', CategoryId: value.category_id });
    if (value.date_range) parameters.push({ Type: 'DateRangeSearchParameter', StartDate: parts(value.date_range.start), EndDate: parts(value.date_range.end) });
    const result = await this.request(value.account_id, 'KeywordIdeas/Query', { ExpandIdeas: expand, IdeaAttributes: ['Keyword', 'Competition', 'MonthlySearchCounts', 'SuggestedBid', 'AdImpressionShare', 'Relevance', 'Source', 'AdGroupId', 'AdGroupName'], SearchParameters: parameters }, 'POST', 'adinsight');
    if (!Object.hasOwn(result, 'KeywordIdeas')) throw new AdportError('PROVIDER_ERROR', 'microsoft: keyword-idea response did not contain the native result envelope');
    const values = rows(result.KeywordIdeas);
    const currency = this.currency(value.account_id);
    const page = values.slice(0, value.limit);
    return { rows: page, truncated: values.length > page.length, returned_count: page.length, native_result_count: values.length, ...(currency ? { currency } : {}), ...(value.date_range ? { date_range: value.date_range } : {}), notes: ['returned_count is the number of rows displayed here. native_result_count is the native response size before the requested limit. Native results are currently capped at 3000 with no continuation cursor; neither count proves the full search universe.', 'MonthlySearchCounts is newest-first. Without an explicit date range, its exact calendar months cannot be identified; the latest month may lag by up to 72 hours.', 'Suggested bids are estimates in account currency, not observed campaign performance. Missing native metrics remain missing; native numeric zero is preserved without inferring availability.', 'Negative AdGroupId values identify suggested planning groups; they are not existing campaign ad-group IDs.'] };
  }

  async trafficEstimates(input: z.infer<typeof traffic>) {
    const value = traffic.parse(input);
    const estimator = { AdGroupEstimators: [{ KeywordEstimators: value.keywords.map(value => ({ Keyword: { Text: value.text, MatchType: value.match_type }, ...(value.max_cpc !== undefined ? { MaxCpc: value.max_cpc } : {}) })), MaxCpc: value.max_cpc }], Criteria: criteria(value), ...(value.daily_budget !== undefined ? { DailyBudget: value.daily_budget } : {}), ...(value.negative_keywords !== undefined ? { NegativeKeywords: value.negative_keywords.map(value => ({ Text: value.text, MatchType: value.match_type })) } : {}) };
    const result = await this.request(value.account_id, 'KeywordTrafficEstimates/Query', { CampaignEstimators: [estimator] }, 'POST', 'adinsight');
    if (!Object.hasOwn(result, 'CampaignEstimates')) throw new AdportError('PROVIDER_ERROR', 'microsoft: traffic-estimate response did not contain the native result envelope');
    const currency = this.currency(value.account_id);
    return { rows: rows(result.CampaignEstimates), estimate_period: 'week' as const, deprecated_metrics: ['AveragePosition'], ...(currency ? { currency } : {}), notes: ['Clicks, impressions and total cost are estimated per week. The optional DailyBudget input is a daily filter, not the estimate period.', 'AveragePosition is deprecated and native values have been fixed at zero since 2021-03-31; it is not a valid position estimate.', 'These are hypothetical traffic estimates in account currency, not a forecast guarantee or observed performance. No campaigns, ads or keywords are created or edited.', 'CampaignId and AdGroupId are reserved by this API and are intentionally omitted. Only Phrase and Broad keyword estimates are supported.'] };
  }
}

export function microsoftPlanningTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_keyword_ideas', namespace: 'microsoft', description: 'Read Ad Insight keyword ideas from keyword, HTTPS URL or native category seeds. Requires language and location IDs; suggested bids use account currency. Native cap 3000, no pagination; monthly counts newest-first and undated unless date_range supplied.', input: ideas, output: ideasOutput, annotations: { readOnly: true }, handler: input => provider.planning.keywordIdeas(input, true) }),
    defineTool({ name: 'microsoft_keyword_historical_metrics', namespace: 'microsoft', description: 'Read native keyword attributes without expanding seeds: demand history, competition and estimated bids. Monthly counts newest-first; missing values remain unavailable. Exact month labels require explicit date_range.', input: historical, output: ideasOutput, annotations: { readOnly: true }, handler: input => provider.planning.keywordIdeas(input, false) }),
    defineTool({ name: 'microsoft_keyword_traffic_estimates', namespace: 'microsoft', description: 'Estimate hypothetical weekly Phrase/Broad keyword traffic from bids, language, locations and network, optionally daily budget and exclusions. Read-only; no campaign changes. Cost/bids use account currency. AveragePosition is deprecated and always zero.', input: traffic, output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), estimate_period: z.literal('week'), deprecated_metrics: z.array(z.string()), currency: z.string().optional(), notes: z.array(z.string()) }), annotations: { readOnly: true }, handler: input => provider.planning.trafficEstimates(input) }),
  ];
}
