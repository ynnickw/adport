import { z } from 'zod';
import { defineTool } from './registry.js';
import { AdportError } from '../errors.js';

export const GA4_SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];
export const GSC_SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
const day = z.string().date();
export const searchConsoleSite = z.string().min(1).max(2048).refine(value => {
  try {
    const domain = value.startsWith('sc-domain:');
    const url = new URL(domain ? `https://${value.slice(10)}` : value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && (!domain || (url.hostname === value.slice(10) && !url.port && url.pathname === '/'));
  } catch { return false; }
}, 'Use the exact Search Console property URL or sc-domain:example.com returned by accounts_list.');
export const gscReportSchema = z.object({
  account_id: searchConsoleSite, start_date: day, end_date: day,
  dimensions: z.array(z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance'])).max(6).default(['date']),
  type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
  filters: z.array(z.object({
    dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']),
    operator: z.enum(['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex']).default('equals'),
    expression: z.string().min(1).max(4096),
  }).strict()).max(10).default([]),
  aggregation_type: z.enum(['auto', 'byPage', 'byProperty']).default('auto'),
  limit: z.number().int().min(1).max(1000).default(100),
  start_row: z.number().int().min(0).max(50_000).default(0),
}).strict().refine(i => i.start_date <= i.end_date, 'start_date must not be after end_date.')
  .refine(i => new Set(i.dimensions).size === i.dimensions.length, 'Dimensions must be unique.');
export type GscReportInput = z.infer<typeof gscReportSchema>;
export interface GscReader {
  site(accountId: string): Promise<unknown>;
  searchAnalytics(input: GscReportInput): Promise<unknown>;
  sitemaps(accountId: string): Promise<unknown>;
  inspectUrl(accountId: string, inspectionUrl: string): Promise<unknown>;
}
export function gscTools(provider: GscReader) {
  return [
    defineTool({ name: 'gsc_get_site', namespace: 'gsc', description: 'Read a selected Google Search Console property and its access level.',
      input: z.object({ account_id: searchConsoleSite }), annotations: { readOnly: true }, handler: i => provider.site(i.account_id) }),
    defineTool({ name: 'gsc_search_analytics', namespace: 'gsc', description: 'Read organic Google Search clicks, impressions, CTR and average position. Dates use Pacific Time; results contain top rows and may omit anonymized queries.',
      input: gscReportSchema, pagination: { cursorInput: 'start_row', cursorOutput: 'next_start_row' }, annotations: { readOnly: true }, handler: i => provider.searchAnalytics(i) }),
    defineTool({ name: 'gsc_sitemaps', namespace: 'gsc', description: 'Read submitted sitemap status, warnings and errors. Does not submit or change sitemaps.',
      input: z.object({ account_id: searchConsoleSite }), annotations: { readOnly: true }, handler: i => provider.sitemaps(i.account_id) }),
    defineTool({ name: 'gsc_inspect_url', namespace: 'gsc', description: 'Inspect Google index status for a URL inside a selected Search Console property. Does not request indexing.',
      input: z.object({ account_id: searchConsoleSite, inspection_url: z.string().url().max(2048) }), annotations: { readOnly: true },
      handler: i => {
        const url = new URL(i.inspection_url);
        const domain = i.account_id.startsWith('sc-domain:') ? i.account_id.slice(10) : undefined;
        const prefix = domain ? undefined : new URL(i.account_id);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
          || !(domain ? url.hostname === domain || url.hostname.endsWith(`.${domain}`) : url.origin === prefix!.origin && url.href.startsWith(prefix!.href))) {
          throw new AdportError('INVALID_INPUT', 'The inspection URL must belong to the selected Search Console property.');
        }
        return provider.inspectUrl(i.account_id, i.inspection_url);
      } }),
  ];
}
