import { AdportError, guardedWriteTool, type AnyToolDefinition, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';

type Row = Record<string, unknown>;
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute(validateOnly: boolean): Promise<string[]> }
const id = z.string().regex(/^[1-9]\d*$/);
/** Same rule as ad and asset final URLs: absolute http(s) without embedded credentials. */
const landingUrl = z.string().url().refine(value => { try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; } }, 'Use an http(s) URL without credentials');
// Schemas stay compact for the hosted publisher metadata budget; Google checks lengths in the validate_only dry run.
const urlList = z.array(landingUrl);
/** Optional AdGroupCriterion URL fields accepted when creating keywords. */
export const keywordUrlFields = {
  final_urls: urlList.optional(),
  final_mobile_urls: urlList.optional(),
  tracking_url_template: z.string().min(1).optional(),
  final_url_suffix: z.string().min(1).optional(),
};
const URL_KEYS = ['final_urls', 'final_mobile_urls', 'tracking_url_template', 'final_url_suffix'] as const;
type UrlKey = (typeof URL_KEYS)[number];
const WIRE: Record<UrlKey, 'finalUrls' | 'finalMobileUrls' | 'trackingUrlTemplate' | 'finalUrlSuffix'> = { final_urls: 'finalUrls', final_mobile_urls: 'finalMobileUrls', tracking_url_template: 'trackingUrlTemplate', final_url_suffix: 'finalUrlSuffix' };
const MAX_UPDATES = 1000, LOOKUP_CHUNK = 200;
const urlUpdate = z.object({
  ad_group_id: id, criterion_id: id,
  final_urls: urlList.optional(),
  final_mobile_urls: urlList.optional(),
  tracking_url_template: z.string().min(1).nullable().optional(),
  final_url_suffix: z.string().min(1).nullable().optional(),
}).refine(value => URL_KEYS.some(key => value[key] !== undefined), 'Supply at least one URL field per keyword');
const updatePayload = z.object({ keywords: z.array(urlUpdate).min(1).max(MAX_UPDATES) })
  .refine(value => new Set(value.keywords.map(k => `${k.ad_group_id}~${k.criterion_id}`)).size === value.keywords.length, 'Each keyword may appear once');
const keywordFields = ['resource_name', 'criterion_id', 'type', 'status', 'negative', 'keyword.text', 'keyword.match_type', ...URL_KEYS].map(field => `ad_group_criterion.${field}`);
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const show = (value: unknown) => Array.isArray(value) ? (value.length ? value.join(', ') : '(none)') : typeof value === 'string' && value ? value : '(none)';

export const GOOGLE_KEYWORD_WRITES = new Set(['google_update_keyword_urls']);

export function keywordUrlCreateFields(keyword: Partial<Record<UrlKey, string[] | string>>): Row {
  return Object.fromEntries(URL_KEYS.flatMap(key => keyword[key] !== undefined && keyword[key].length ? [[WIRE[key], keyword[key]]] : []));
}

/** AdGroupCriterion keyword URL updates; Google Ads v25 AdGroupCriterion reference, checked 2026-11-25. */
export class GoogleKeywordService {
  constructor(private readonly client: GoogleAdsRestClient) {}

  async plan(op: WriteOperation): Promise<Plan> {
    const account = normalizeCustomerId(op.accountId), input = updatePayload.parse(op.payload);
    const resource = (k: { ad_group_id: string; criterion_id: string }) => `customers/${account}/adGroupCriteria/${k.ad_group_id}~${k.criterion_id}`;
    const wanted = input.keywords.map(resource);
    const rows: Row[] = [];
    for (let start = 0; start < wanted.length; start += LOOKUP_CHUNK) {
      const chunk = wanted.slice(start, start + LOOKUP_CHUNK);
      rows.push(...await this.client.search(account, `SELECT ad_group.id, ${keywordFields.join(', ')} FROM ad_group_criterion WHERE ad_group_criterion.resource_name IN (${chunk.map(name => `'${name}'`).join(', ')})`, { maxRows: chunk.length + 1, includeDrafts: true }));
    }
    const current = new Map(rows.map(row => { const criterion = record(row.adGroupCriterion); return [String(criterion.resourceName), criterion] as const; }));
    const problems: string[] = [];
    const operations: Row[] = [], changes: string[] = [], fieldChanges: NonNullable<WritePreview['fieldChanges']> = [];
    for (const [index, keyword] of input.keywords.entries()) {
      const name = wanted[index]!, before = current.get(name);
      if (!before || before.status === 'REMOVED') { problems.push(`${keyword.ad_group_id}~${keyword.criterion_id} was not found in the selected account`); continue; }
      if (before.type !== 'KEYWORD') { problems.push(`${keyword.ad_group_id}~${keyword.criterion_id} is not a keyword criterion`); continue; }
      if (before.negative === true) { problems.push(`${keyword.ad_group_id}~${keyword.criterion_id} is a negative keyword; negative keywords have no landing pages`); continue; }
      const update: Row = { resourceName: name }, mask: string[] = [], info = record(before.keyword), label = `"${String(info.text ?? '')}" [${String(info.matchType ?? '')}] ${keyword.ad_group_id}~${keyword.criterion_id}`;
      for (const key of URL_KEYS) {
        const value = keyword[key];
        if (value === undefined) continue;
        mask.push(key);
        // Fields named in the mask but absent from the body are cleared by the API.
        if (value !== null && !(Array.isArray(value) && value.length === 0)) update[WIRE[key]] = value;
        const after = value === null || (Array.isArray(value) && !value.length) ? '(cleared)' : show(value);
        changes.push(`~ keyword ${label} ${key} ${show(before[WIRE[key]])} → ${after}`);
        if (fieldChanges.length < 100) fieldChanges.push({ field: `${label} ${key}`, before: show(before[WIRE[key]]), after });
      }
      const finalUrls = keyword.final_urls ?? (before.finalUrls as string[] | undefined) ?? [], mobileUrls = keyword.final_mobile_urls ?? (before.finalMobileUrls as string[] | undefined) ?? [];
      if (mobileUrls.length && !finalUrls.length) problems.push(`${keyword.ad_group_id}~${keyword.criterion_id} would keep final_mobile_urls without final_urls`);
      operations.push({ update, updateMask: mask.join(',') });
    }
    if (problems.length) throw new AdportError('INVALID_INPUT', `google: keyword URL update rejected: ${problems.join('; ')}`);
    return {
      summary: `Update landing-page URLs on ${operations.length} keyword${operations.length === 1 ? '' : 's'}`,
      changes, fieldChanges, notes: ['Only the listed URL fields change; keyword text, match type, status and bids are preserved. Keyword URLs override ad final URLs for clicks on that keyword.'],
      coercions: [], budgetDeltas: [],
      execute: async validateOnly => {
        const result = await this.client.mutate(account, 'adGroupCriteria', operations, { validateOnly });
        const resources = (result.results ?? []).map(item => item.resourceName ?? '');
        if (!validateOnly && (resources.length !== wanted.length || resources.some((name, index) => name !== wanted[index]))) throw new AdportError('PROVIDER_ERROR', 'google: keyword URL mutation receipt mismatch; reconcile before retrying', { resource_ids: resources });
        return resources;
      },
    };
  }
}

export function googleKeywordTools(): AnyToolDefinition[] {
  return [
    guardedWriteTool({
      name: 'google_update_keyword_urls', namespace: 'google', provider: 'google', kind: 'update',
      description: 'Set or clear landing-page URLs on existing keywords across ad groups. Omitted fields stay; [] or null clears.',
      payload: updatePayload,
    }),
  ];
}
