import { creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { MicrosoftAdsProvider } from './provider.js';

const id = z.string().regex(/^\d+$/);
const parent = { campaign_id: id, ad_group_id: id };
const status = z.enum(['Active', 'Paused']);
export const microsoftAdTypes = ['ResponsiveSearch', 'Responsive', 'DynamicSearch', 'ExpandedText', 'AppInstall', 'Product'] as const;
const headlines = z.array(z.string().min(1).max(30)).min(3).max(15).refine(value => new Set(value).size === value.length, 'Headlines must be unique');
const descriptions = z.array(z.string().min(1).max(90)).min(2).max(4).refine(value => new Set(value).size === value.length, 'Descriptions must be unique');
const urls = z.array(z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol))).min(1).max(10);
const copy = { headlines, descriptions, final_urls: urls, path1: z.string().max(15).optional(), path2: z.string().max(15).optional() };
const rows = z.object({ rows: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean() });

export function microsoftChildTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  const write = (name: string, description: string, payload: z.ZodObject<z.ZodRawShape>, kind: 'create' | 'update' | 'remove' = 'update') =>
    guardedWriteTool({ name, namespace: 'microsoft', provider: 'microsoft', description, payload, kind });
  return [
    defineTool({ name: 'microsoft_ad_groups', namespace: 'microsoft', description: 'Read ad groups and their bids/statuses after verifying the campaign belongs to the selected account.',
      input: z.object({ account_id: id, campaign_id: id }), output: rows, annotations: { readOnly: true }, handler: input => provider.children.listGroups(input) }),
    defineTool({ name: 'microsoft_ads', namespace: 'microsoft', description: 'Read ad configuration and creative copy with visual edit actions. Verifies the campaign/ad-group hierarchy in the selected account.',
      input: z.object({ account_id: id, ...parent, ad_types: z.array(z.enum(microsoftAdTypes)).min(1).default(['ResponsiveSearch']), limit: z.number().int().positive().max(200).default(50) }),
      output: creativesOutput.extend({ ads: z.array(z.record(z.string(), z.unknown())) }), presentation: 'creatives', annotations: { readOnly: true }, handler: input => provider.children.listAds(input) }),
    defineTool({ name: 'microsoft_keywords', namespace: 'microsoft', description: 'Read ad-group keywords, including bids, match types, statuses and URLs, within the selected campaign/account.',
      input: z.object({ account_id: id, ...parent }), output: rows, annotations: { readOnly: true }, handler: input => provider.children.listKeywords(input) }),
    write('microsoft_create_ad_group', 'Create a SearchStandard ad group in an account-owned campaign. CPC bid uses whole account-currency units; policy may force Paused.',
      z.object({ campaign_id: id, name: z.string().min(1).max(256), language: z.string().min(1).describe('Microsoft language name, e.g. English or German; chosen explicitly for ad-group targeting'), cpc_bid: z.number().positive().optional(), status: status.default('Paused') }), 'create'),
    write('microsoft_set_ad_group_status', 'Activate or pause an account-owned ad group; the parent campaign status remains unchanged.', z.object({ ...parent, status })),
    write('microsoft_update_ad_group', 'Rename an ad group or change its CPC bid in whole currency units. Campaign and ad-group status remain unchanged.',
      z.object({ ...parent, name: z.string().min(1).max(256).optional(), cpc_bid: z.number().positive().optional() }).refine(value => value.name !== undefined || value.cpc_bid !== undefined, 'Provide name or cpc_bid')),
    write('microsoft_create_responsive_search_ad', 'Create a responsive search ad using 3–15 unique headlines and 2–4 unique descriptions in a SearchStandard ad group. Policy may force Paused.',
      z.object({ ...parent, ...copy, status: status.default('Paused') }), 'create'),
    write('microsoft_update_responsive_search_ad', 'Edit supplied responsive search ad fields. Omitted fields and serving status are preserved; existing positional pinning is retained.',
      z.object({ ...parent, ad_id: id, headlines: headlines.optional(), descriptions: descriptions.optional(), final_urls: urls.optional(), path1: copy.path1, path2: copy.path2 })
        .refine(value => ['headlines', 'descriptions', 'final_urls', 'path1', 'path2'].some(key => value[key as keyof typeof value] !== undefined), 'Provide a content field')),
    write('microsoft_set_ad_status', 'Activate or pause an ad after verifying its exact parent hierarchy. Parent delivery settings remain unchanged.',
      z.object({ ...parent, ad_id: id, ad_type: z.enum(microsoftAdTypes).default('ResponsiveSearch'), status })),
    write('microsoft_add_keywords', 'Create up to 100 keywords in an account-owned ad group. Bids use whole currency units. Policy may force Paused.',
      z.object({ ...parent, keywords: z.array(z.object({ text: z.string().min(1).max(100), match_type: z.enum(['Broad', 'Phrase', 'Exact']), bid: z.number().positive().optional(), status: status.default('Paused') })).min(1).max(100) }), 'create'),
    write('microsoft_set_keyword_status', 'Activate or pause one verified keyword without replacing its text, match type or bid.', z.object({ ...parent, keyword_id: id, status })),
    write('microsoft_set_keyword_bid', 'Change one verified keyword bid in whole currency units; keyword and parent statuses remain unchanged.', z.object({ ...parent, keyword_id: id, bid: z.number().positive() })),
    write('microsoft_remove_keywords', 'Permanently remove verified keyword IDs from an ad group. This cannot be undone; use microsoft_set_keyword_status to pause instead.',
      z.object({ ...parent, keyword_ids: z.array(id).min(1).max(100).refine(value => new Set(value).size === value.length, 'Keyword IDs must be unique') }), 'remove'),
  ];
}
