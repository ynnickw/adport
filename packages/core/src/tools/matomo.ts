import { z } from 'zod';
import { defineTool } from './registry.js';
import { AdportError } from '../errors.js';

/** Normalized Matomo base URL: https origin plus optional sub-path, no trailing slash or index.php. */
export function normalizeMatomoUrl(value: string): string {
  const raw = value.trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new AdportError('INVALID_INPUT', 'MATOMO_URL must be an absolute https URL, e.g. https://example.matomo.cloud.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || raw.includes('?') || raw.includes('#')) {
    throw new AdportError('INVALID_INPUT', 'MATOMO_URL must be an https URL without credentials, query or fragment.');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/index\.php$/i, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}
export const matomoBaseUrl = z.string().min(1).max(2048).transform((value, ctx) => {
  try { return normalizeMatomoUrl(value); }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER; }
});

const site = z.string().regex(/^[1-9]\d{0,9}$/).describe('Matomo site ID (idSite), also returned as account ID by accounts_list.');
const day = z.string().date();
/**
 * Visitor-level modules expose personal data, and MultiSites reads every site the
 * token can view regardless of account_id. Adport reads aggregated, per-site reports only.
 */
export const MATOMO_BLOCKED_MODULES = ['Live', 'UserId', 'MultiSites', 'HeatmapSessionRecording', 'AbTesting'] as const;
const BLOCKED_MODULES = new Set(MATOMO_BLOCKED_MODULES.map(name => name.toLowerCase()));
/** Case-insensitive, since Matomo's module matching may change between versions. */
export function isMatomoBlockedModule(value: unknown): boolean {
  return typeof value === 'string' && BLOCKED_MODULES.has(value.toLowerCase());
}
const reportModule = z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/)
  .refine(value => !isMatomoBlockedModule(value), 'This module is outside the supported per-site analytics reports.');
/**
 * Segments that narrow a report to one visitor or visit: the ones Matomo's segment
 * metadata restricts to higher permissions (User ID, Visitor ID, Visit ID, Visitor IP, Fingerprint).
 */
export const MATOMO_BLOCKED_SEGMENTS = ['userId', 'visitorId', 'visitId', 'visitIp', 'fingerprint'] as const;
const BLOCKED_SEGMENTS = new Set(MATOMO_BLOCKED_SEGMENTS.map(name => name.toLowerCase()));
/** Lenient, repeated percent-decoding: malformed sequences elsewhere cannot hide an encoded name. */
function decodeSegment(value: string): string {
  let current = value;
  for (let i = 0; i < 5; i++) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) break;
    current = next;
  }
  return current;
}
/** True when any condition of the segment (raw or URL-decoded) names a visitor-identifying dimension. */
export function matomoSegmentNamesVisitor(segment: string): boolean {
  return [segment, decodeSegment(segment)].some(value => value.split(/[;,]/)
    .some(condition => BLOCKED_SEGMENTS.has(/^\s*([A-Za-z0-9_.]+)/.exec(condition)?.[1]?.toLowerCase() ?? '')));
}
const reportAction = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/);
const column = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
export const matomoReportSchema = z.object({
  account_id: site,
  module: reportModule.describe('Report module from matomo_report_metadata, e.g. VisitsSummary, Referrers, Goals, Actions.'),
  action: reportAction.describe('Report action, e.g. get, getReferrerType, getCampaigns, getPageUrls.'),
  start_date: day, end_date: day,
  period: z.enum(['range', 'day', 'week', 'month', 'year']).default('range')
    .describe('range sums the dates; day/week/month/year returns rows per period.'),
  segment: z.string().min(1).max(2000).optional()
    .refine(value => value === undefined || !matomoSegmentNamesVisitor(value), 'Segments on visitor-identifying dimensions (userId, visitorId, visitId, visitIp, fingerprint) are not available.')
    .describe('Matomo segment definition, e.g. deviceType==smartphone;countryCode==fr.'),
  id_goal: z.union([z.number().int().min(1).max(1_000_000), z.enum(['ecommerceOrder', 'ecommerceAbandonedCart'])]).optional()
    .describe('Goal ID or ecommerceOrder/ecommerceAbandonedCart. Only valid with module Goals.'),
  flat: z.boolean().optional().describe('Flatten hierarchical reports. Defaults to true for Actions reports.'),
  filter_sort_column: column.optional(),
  filter_sort_order: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).max(10_000_000).default(0),
}).strict().refine(i => i.start_date <= i.end_date, 'start_date must not be after end_date.')
  .refine(i => i.id_goal === undefined || i.module === 'Goals', { message: 'id_goal is only valid with module Goals.', path: ['id_goal'] })
  .refine(i => i.period !== 'day' || (Date.parse(i.end_date) - Date.parse(i.start_date)) / 86_400_000 < 93, 'Daily rows are limited to 93 days; use week or month.');
export const matomoReportMetadataSchema = z.object({
  account_id: site,
  module: reportModule.optional().describe('Only list reports of this module.'),
}).strict();
export type MatomoReportInput = z.infer<typeof matomoReportSchema>;
export type MatomoReportMetadataInput = z.infer<typeof matomoReportMetadataSchema>;
export interface MatomoReader {
  site(accountId: string): Promise<unknown>;
  reportMetadata(input: MatomoReportMetadataInput): Promise<unknown>;
  processedReport(input: MatomoReportInput): Promise<unknown>;
  goals(accountId: string): Promise<unknown>;
  segments(accountId: string): Promise<unknown>;
}
export function matomoTools(provider: MatomoReader) {
  return [
    defineTool({ name: 'matomo_site', namespace: 'matomo', description: 'Read a Matomo site: URL, time zone, currency and ecommerce setting.',
      input: z.object({ account_id: site }), annotations: { readOnly: true }, handler: i => provider.site(i.account_id) }),
    defineTool({ name: 'matomo_report_metadata', namespace: 'matomo', description: 'List the Matomo reports available for a site, with module, action, dimension and metrics.',
      input: matomoReportMetadataSchema, annotations: { readOnly: true }, handler: i => provider.reportMetadata(i) }),
    defineTool({ name: 'matomo_report', namespace: 'matomo', description: 'Read an aggregated Matomo report (visits, referrers, campaigns, goals, pages). Dates use the site time zone; revenue uses the site currency; paginate with offset.',
      input: matomoReportSchema, pagination: { cursorInput: 'offset', cursorOutput: 'next_offset' }, annotations: { readOnly: true }, handler: i => provider.processedReport(i) }),
    defineTool({ name: 'matomo_goals', namespace: 'matomo', description: 'Read Matomo goal definitions for a site. Use matomo_report with module Goals for conversions.',
      input: z.object({ account_id: site }), annotations: { readOnly: true }, handler: i => provider.goals(i.account_id) }),
    defineTool({ name: 'matomo_segments', namespace: 'matomo', description: 'Read stored Matomo segment definitions usable as the segment of matomo_report.',
      input: z.object({ account_id: site }), annotations: { readOnly: true }, handler: i => provider.segments(i.account_id) }),
  ];
}
