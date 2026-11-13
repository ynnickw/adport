import { AdportError, defineTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import { normalizeCustomerId } from './client.js';
import type { GoogleAdsProvider } from './provider.js';

const identifier = z.string().regex(/^\d+$/);
const keywords = z.array(z.string().trim().min(1).max(500));
const url = z.string().url().refine(value => {
  const parsed = new URL(value);
  return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
}, 'Use an HTTP(S) URL without credentials');
const targeting = {
  account_id: z.string(),
  language_id: identifier.optional(),
  location_ids: z.array(identifier).max(10).default([]),
  network: z.enum(['GOOGLE_SEARCH', 'GOOGLE_SEARCH_AND_PARTNERS']).default('GOOGLE_SEARCH'),
  include_adult_keywords: z.boolean().default(false),
  include_average_cpc: z.boolean().default(false),
};
const nativeResult = z.record(z.string(), z.unknown());
const output = z.object({
  results: z.array(nativeResult),
  aggregate_metric_results: nativeResult.optional(),
  next_page_token: z.string().optional(),
  total_size: z.string().regex(/^\d+$/).optional(),
  truncated: z.boolean(),
});
const ideasInput = z.object({
  ...targeting,
  seed: z.discriminatedUnion('type', [
    z.object({ type: z.literal('keywords'), keywords: keywords.min(1).max(20) }),
    z.object({ type: z.literal('url'), url }),
    z.object({ type: z.literal('keywords_and_url'), keywords: keywords.min(1).max(20), url }),
    z.object({ type: z.literal('site'), url }),
  ]),
  page_size: z.number().int().positive().max(10_000).default(100),
  page_token: z.string().min(1).max(10_000).optional(),
});
const historicalInput = z.object({ ...targeting, keywords: keywords.min(1).max(10_000) });

function target(input: z.infer<typeof historicalInput> | z.infer<typeof ideasInput>) {
  return {
    ...(input.language_id ? { language: `languageConstants/${input.language_id}` } : {}),
    geoTargetConstants: input.location_ids.map(value => `geoTargetConstants/${value}`),
    keywordPlanNetwork: input.network,
    includeAdultKeywords: input.include_adult_keywords,
    historicalMetricsOptions: { includeAverageCpc: input.include_average_cpc },
  };
}

function result(data: Record<string, unknown>) {
  const rows = data.results ?? [];
  const token = data.nextPageToken;
  const total = data.totalSize;
  // Keep native int64 metrics as strings and missing metrics absent. A short
  // page is not evidence of completeness; only the native token determines it.
  const parsed = output.safeParse({
    results: rows,
    ...(data.aggregateMetricResults === undefined ? {} : { aggregate_metric_results: data.aggregateMetricResults }),
    ...(token === undefined || token === '' ? {} : { next_page_token: token }),
    ...(total === undefined ? {} : { total_size: total }),
    truncated: typeof token === 'string' && token.length > 0,
  });
  if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'Google keyword planning returned an invalid response shape');
  return parsed.data;
}

export function googlePlanningTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'google_keyword_ideas', namespace: 'google',
      description: 'Discover keyword ideas from keywords, a URL, both, or a site. Reads one native page; pass next_page_token as page_token with identical targeting and seed. Metrics are historical estimates, not a forecast. No keyword plan or campaign is created.',
      input: ideasInput, output, annotations: { readOnly: true },
      async handler(input) {
        const seed = input.seed;
        const body = {
          ...target(input), pageSize: input.page_size,
          ...(input.page_token ? { pageToken: input.page_token } : {}),
          ...(seed.type === 'keywords' ? { keywordSeed: { keywords: seed.keywords } }
            : seed.type === 'url' ? { urlSeed: { url: seed.url } }
              : seed.type === 'keywords_and_url' ? { keywordAndUrlSeed: { keywords: seed.keywords, url: seed.url } }
                : { siteSeed: { site: seed.url } }),
        };
        return result(await provider.keywordPlanning(normalizeCustomerId(input.account_id), 'generateKeywordIdeas', body));
      },
    }),
    defineTool({
      name: 'google_keyword_historical_metrics', namespace: 'google',
      description: 'Read native historical search volume, competition and bid estimates for up to 10,000 keywords. Google merges close variants; missing values stay unavailable and monetary int64 values remain native micros strings. Does not create a keyword plan or campaign.',
      input: historicalInput, output, annotations: { readOnly: true },
      handler: async input => result(await provider.keywordPlanning(normalizeCustomerId(input.account_id), 'generateKeywordHistoricalMetrics', { ...target(input), keywords: input.keywords })),
    }),
  ];
}
