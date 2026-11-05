import { z } from 'zod';
import { AdportError, defineTool, type AnyToolDefinition } from '@adport/core';
import { LinkedInAdsClient, type RestliValue } from './client.js';
import type { LinkedInAdsProvider } from './provider.js';
import { linkedinId, NON_DISCRIMINATION_NOTICE } from './schemas.js';

const pivots = ['MEMBER_COMPANY_SIZE', 'MEMBER_INDUSTRY', 'MEMBER_SENIORITY', 'MEMBER_JOB_TITLE', 'MEMBER_JOB_FUNCTION', 'MEMBER_COUNTRY_V2', 'MEMBER_REGION_V2', 'MEMBER_COMPANY'] as const;
const metrics = ['impressions', 'clicks', 'landingPageClicks', 'costInLocalCurrency', 'costInUsd', 'externalWebsiteConversions', 'externalWebsitePostClickConversions', 'externalWebsitePostViewConversions', 'oneClickLeads', 'oneClickLeadFormOpens', 'totalEngagements', 'reactions', 'comments', 'shares', 'follows', 'videoViews', 'videoCompletions', 'opens', 'sends'] as const;
const taxonomyUrn = z.string().regex(/^urn:li:(?:(?:geo|industry|seniority|title|function|organization):[1-9]\d*|staffCountRange:\(\d+,\d+\))$/);
const locale = z.object({ language: z.string().regex(/^[a-z]{2}$/), country: z.string().regex(/^[A-Z]{2}$/) }).strict();
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const range = z.object({ start: z.iso.date(), end: z.iso.date() }).strict().refine(value => value.end >= value.start, 'End must be on or after start');
export const demographicInput = z.object({
  account_id: linkedinId,
  pivot: z.enum(pivots),
  date_range: range,
  time_granularity: z.enum(['ALL', 'DAILY', 'MONTHLY', 'YEARLY']).default('ALL'),
  metrics: z.array(z.enum(metrics)).min(1).max(18).refine(unique, 'Choose distinct metrics').default(['impressions', 'clicks', 'costInLocalCurrency']),
  campaign_ids: z.array(linkedinId).min(1).max(20).refine(unique, 'Choose distinct campaign IDs').optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  resolve_names: z.boolean().default(false),
  locale: locale.optional(),
}).strict();
export const resolveEntitiesInput = z.object({ account_id: linkedinId, urns: z.array(taxonomyUrn).min(1).max(100).refine(unique, 'Choose distinct URNs'), locale: locale.optional() }).strict();
const nativeDate = z.object({ year: z.number().int().min(1).max(9999), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) });
const dateRange = z.object({ start: nativeDate, end: nativeDate });
const count = z.number().int().nonnegative().safe().nullish();
const decimal = z.string().max(100).regex(/^\d+(?:\.\d+)?$/).nullish();
const metricFields = Object.fromEntries(metrics.map(metric => [metric, metric.startsWith('costIn') ? decimal : count])) as Record<(typeof metrics)[number], typeof decimal | typeof count>;
const rowSchema = z.object({ pivotValues: z.array(taxonomyUrn).length(1), dateRange, ...metricFields });
const paging = z.object({ start: z.number().int().nonnegative().safe().optional(), count: z.number().int().nonnegative().safe().optional(), total: z.number().int().nonnegative().safe().optional(), links: z.array(z.object({ rel: z.string() })).optional() });
const responseSchema = z.object({ elements: z.array(rowSchema).max(15_000), paging: paging.optional() });
const entitySchema = z.object({ urn: taxonomyUrn, name: z.string().min(1).max(1000), facetUrn: z.string().optional() });
const cell = z.union([z.string(), z.number().finite(), z.null()]);
const demographicOutput = z.object({
  account_id: linkedinId, currency: z.string().regex(/^[A-Z]{3}$/), request: demographicInput,
  rows: z.array(z.object({ urn: taxonomyUrn, name: z.string().optional(), date_range: range, metrics: z.record(z.string(), cell) })).max(1000),
  records: z.array(z.record(z.string(), cell)).max(1000), returned_native_rows: z.number().int().min(0).max(15_000),
  truncated: z.boolean(), complete: z.literal(false),
  coverage: z.object({ approximate: z.literal(true), minimum_events: z.literal(3), top_values_per_creative_day: z.literal(100), native_row_limit: z.literal(15_000), pagination_supported: z.literal(false) }), notes: z.array(z.string()),
});
const resolveOutput = z.object({ account_id: linkedinId, elements: z.array(entitySchema).max(100), records: z.array(entitySchema).max(100), paging: paging.optional(), unresolved_urns: z.array(taxonomyUrn).max(100), notes: z.array(z.string()) });
const pivotType: Record<(typeof pivots)[number], string> = { MEMBER_COMPANY_SIZE: 'staffCountRange', MEMBER_INDUSTRY: 'industry', MEMBER_SENIORITY: 'seniority', MEMBER_JOB_TITLE: 'title', MEMBER_JOB_FUNCTION: 'function', MEMBER_COUNTRY_V2: 'geo', MEMBER_REGION_V2: 'geo', MEMBER_COMPANY: 'organization' };
const toDate = (iso: string) => { const [year, month, day] = iso.split('-').map(Number); return { year: year!, month: month!, day: day! }; };
const fromDate = (value: z.infer<typeof nativeDate>) => {
  const result = z.iso.date().safeParse(`${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`);
  if (!result.success) throw new AdportError('PROVIDER_ERROR', 'linkedin: analytics returned an invalid calendar date');
  return result.data;
};

/** Marketing202608 analytics/URN finder contracts checked against official docs 2026-11-05. */
export class LinkedInReportingService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider) {}
  private async names(urns: string[], selectedLocale?: z.infer<typeof locale>) {
    const result = await this.client.get('adTargetingEntities', z.object({ elements: z.array(entitySchema).max(100), paging: paging.optional() }), {
      q: 'urns', queryVersion: 'QUERY_USES_URNS', fetchType: 'SINGLE_NODE', urns, ...(selectedLocale ? { locale: selectedLocale } : {}),
    });
    const returned = result.elements.map(entity => entity.urn), unrequested = [...new Set(returned.filter(urn => !urns.includes(urn)))], duplicates = [...new Set(returned.filter((urn, index) => returned.indexOf(urn) !== index))];
    if (unrequested.length || duplicates.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: URN resolution returned an unrequested or duplicate entity', { requested_urns: urns, returned_count: result.elements.length, unrequested_urns: unrequested, duplicate_urns: duplicates, duplicate_variants: result.elements.filter(entity => duplicates.includes(entity.urn)) });
    return { ...result, unresolved_urns: urns.filter(urn => !result.elements.some(entity => entity.urn === urn)) };
  }
  async resolveEntities(raw: z.input<typeof resolveEntitiesInput>) {
    const input = resolveEntitiesInput.parse(raw); await this.provider.getAccount(input.account_id);
    const result = await this.names(input.urns, input.locale);
    return { account_id: input.account_id, ...result, records: result.elements, notes: result.unresolved_urns.length ? ['Some requested URNs were not resolved. Their names are unavailable; no descendant or alternate-identity lookup was made.'] : [] };
  }
  async demographics(raw: z.input<typeof demographicInput>) {
    const input = demographicInput.parse(raw), account = await this.provider.getAccount(input.account_id);
    for (const campaign of input.campaign_ids ?? []) await this.provider.getCampaign(input.account_id, campaign);
    const params: Record<string, RestliValue> = {
      q: 'analytics', pivot: input.pivot, timeGranularity: input.time_granularity,
      dateRange: { start: toDate(input.date_range.start), end: toDate(input.date_range.end) },
      accounts: [`urn:li:sponsoredAccount:${input.account_id}`],
      ...(input.campaign_ids ? { campaigns: input.campaign_ids.map(id => `urn:li:sponsoredCampaign:${id}`) } : {}),
      fields: ['pivotValues', 'dateRange', ...input.metrics].join(','),
    };
    const result = await this.client.get('adAnalytics', responseSchema, params), seen = new Set<string>();
    const rows = result.elements.map(row => {
      const urn = row.pivotValues[0]!, start = fromDate(row.dateRange.start), end = fromDate(row.dateRange.end);
      if (urn.split(':')[2] !== pivotType[input.pivot]) throw new AdportError('PROVIDER_ERROR', 'linkedin: unexpected demographic pivot identity');
      if (start > end || start < input.date_range.start || end > input.date_range.end || input.time_granularity === 'ALL' && (start !== input.date_range.start || end !== input.date_range.end) || input.time_granularity === 'DAILY' && start !== end) throw new AdportError('PROVIDER_ERROR', 'linkedin: native reporting dates differ from the requested scope; older or bucketed queries may need explicit month/year boundaries');
      const key = JSON.stringify([urn, start, end]);
      if (seen.has(key)) throw new AdportError('PROVIDER_ERROR', 'linkedin: duplicate demographic period/identity'); seen.add(key);
      return { urn, date_range: { start, end }, metrics: Object.fromEntries(input.metrics.map(metric => [metric, row[metric] ?? null])) };
    });
    const nativePartial = result.elements.length === 15_000 || Boolean(result.paging?.start || result.paging?.links?.some(link => link.rel === 'next')) || result.paging?.total !== undefined && result.paging.total > result.elements.length;
    const selected = rows.slice(0, input.limit), notes = [
      'Professional-demographic results are approximate, can lag by 12–24 hours, and omit values below LinkedIn’s three-event privacy threshold. Native selection also limits each creative/day to its top 100 demographic values. Do not add segments into an exact account total.',
      'Missing metrics remain null. Empty data can mean no activity or insufficient native data access; it does not establish zero activity. These metrics do not identify individual members.',
      'Demographic spend is in the reported currency and is not adjusted for overdelivery. Conversion value, reach and carousel metrics are unavailable for these pivots.',
    ];
    if (!rows.length) notes.push('No demographic rows returned for this selection.');
    if (nativePartial || rows.length > input.limit) notes.push('The response is partial or locally limited. This endpoint has no supported pagination; narrow dates/campaigns rather than inventing a continuation cursor.');
    const labels = new Map<string, string>();
    if (input.resolve_names && selected.length) {
      const urns = [...new Set(selected.map(row => row.urn))].slice(0, 100);
      try {
        const resolved = await this.names(urns, input.locale);
        resolved.elements.forEach(entity => labels.set(entity.urn, entity.name));
        if (resolved.unresolved_urns.length || new Set(selected.map(row => row.urn)).size > 100) notes.push('Names are unavailable for some values; only the first 100 distinct returned URNs were resolved. Original URNs are preserved.');
      } catch { notes.push('Optional name lookup was not confirmed. Original demographic URNs are preserved; the analytics read was not repeated.'); }
    }
    return {
      account_id: input.account_id, currency: account.currency, request: input,
      rows: selected.map(row => ({ ...row, ...(labels.has(row.urn) ? { name: labels.get(row.urn)! } : {}) })),
      records: selected.map(row => ({ name: labels.get(row.urn) ?? row.urn, ...Object.fromEntries(input.metrics.map(metric => [metric, metric === 'costInLocalCurrency' || metric === 'costInUsd' ? row.metrics[metric] == null ? null : `${row.metrics[metric]} ${metric === 'costInUsd' ? 'USD' : account.currency}` : row.metrics[metric]])), period: `${row.date_range.start} – ${row.date_range.end}` })),
      returned_native_rows: rows.length, truncated: nativePartial || rows.length > input.limit, complete: false,
      coverage: { approximate: true, minimum_events: 3, top_values_per_creative_day: 100, native_row_limit: 15_000, pagination_supported: false }, notes,
    };
  }
}

export function linkedinReportingTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'linkedin_demographic_report', namespace: 'linkedin', description: 'Read native professional-demographic ad metrics by company size, industry, seniority, title, function, country, region or company. UTC dates are inclusive; exact spend strings and missing values are preserved. Results are approximate/privacy-filtered, not complete audience totals. Optional bounded URN name lookup. No native paging. ' + NON_DISCRIMINATION_NOTICE, input: demographicInput, output: demographicOutput, presentation: 'records', annotations: { readOnly: true, openWorld: false }, handler: input => provider.reporting.demographics(input) }),
    defineTool({ name: 'linkedin_resolve_targeting_entities', namespace: 'linkedin', description: 'Resolve up to 100 exact demographic/targeting taxonomy URNs to native localized names. SINGLE_NODE only; no descendant expansion. Unknown names stay unresolved. Verifies selected-account access before the public taxonomy lookup.', input: resolveEntitiesInput, output: resolveOutput, presentation: 'records', annotations: { readOnly: true, openWorld: false }, handler: input => provider.reporting.resolveEntities(input) }),
  ];
}
