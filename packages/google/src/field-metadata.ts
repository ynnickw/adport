import { AdportError, defineTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import { normalizeCustomerId } from './client.js';
import type { GoogleAdsProvider } from './provider.js';

const fieldName = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/).max(200);
const input = z.object({
  account_id: z.string(),
  field_names: z.array(fieldName).min(1).max(20).refine(values => new Set(values).size === values.length, 'Field names must be unique'),
  include_compatibility: z.boolean().default(false),
  page_token: z.string().min(1).max(16384).optional(),
});
const field = z.object({
  name: fieldName, resourceName: z.string().optional(), category: z.string().min(1),
  dataType: z.string().min(1).optional(), typeUrl: z.string().optional(),
  selectable: z.boolean().optional(), filterable: z.boolean().optional(), sortable: z.boolean().optional(), isRepeated: z.boolean().optional(),
  enumValues: z.array(z.string()).optional(), selectableWith: z.array(z.string()).optional(),
  attributeResources: z.array(z.string()).optional(), metrics: z.array(z.string()).optional(), segments: z.array(z.string()).optional(),
}).passthrough();
const nativeOutput = z.object({ results: z.array(field).default([]), nextPageToken: z.string().optional(), totalResultsCount: z.string().regex(/^\d+$/).optional() });
const output = z.object({ api_version: z.string(), results: z.array(field), truncated: z.boolean(), next_page_token: z.string().optional(), total_results_count: z.string().optional() });

/** GoogleAdsFieldService v25, googleapis/googleapis@57aa4dbc: no FROM clause. */
export function googleFieldMetadataTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  return [defineTool({
    name: 'google_field_metadata', namespace: 'google',
    description: 'Look up up to 20 exact GAQL resource or field names in the connected API version. Returns native types, enums and queryability; optional compatibility lists can be large. API-wide metadata, not account performance. Continue next_page_token with identical names/options.',
    input, output, annotations: { readOnly: true }, pagination: { cursorInput: 'page_token' },
    async handler(raw) {
      normalizeCustomerId(raw.account_id);
      const fields = ['name', 'category', 'data_type', 'type_url', 'is_repeated', 'selectable', 'filterable', 'sortable', 'enum_values', ...(raw.include_compatibility ? ['selectable_with', 'attribute_resources', 'metrics', 'segments'] : [])];
      const query = `SELECT ${fields.join(', ')} WHERE name IN (${raw.field_names.map(name => `'${name}'`).join(', ')})`;
      const { apiVersion, response } = await provider.fieldMetadata(query, raw.field_names.length, raw.page_token), parsed = nativeOutput.safeParse(response);
      if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'google: invalid field metadata response');
      const result = parsed.data;
      if (result.results.length > raw.field_names.length || new Set(result.results.map(value => value.name)).size !== result.results.length || result.results.some(value => !raw.field_names.includes(value.name) || (value.resourceName !== undefined && value.resourceName !== `googleAdsFields/${value.name}`))) throw new AdportError('PROVIDER_ERROR', 'google: field metadata identity or requested selection mismatch');
      return { api_version: apiVersion, results: result.results, truncated: Boolean(result.nextPageToken), ...(result.nextPageToken ? { next_page_token: result.nextPageToken } : {}), ...(result.totalResultsCount !== undefined ? { total_results_count: result.totalResultsCount } : {}) };
    },
  })];
}
