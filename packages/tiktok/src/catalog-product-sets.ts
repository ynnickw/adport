import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import { catalogId, catalogInput } from './catalog-schema.js';
import { nativeListComplete } from './pagination.js';

const count = z.number().int().nonnegative().safe();
const nativeId = z.union([catalogId, z.number().int().positive().safe()]).transform(String);
const selected = catalogInput.extend({ product_set_id: catalogId }).strict();
export const productSetList = catalogInput.extend({
  product_set_id: catalogId.optional(),
  return_product_count: z.boolean().default(false),
  page_size: z.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(512).optional(),
}).strict();
export const productSetProducts = selected.extend({
  page: z.number().int().min(1).max(100_000).default(1),
  page_size: z.number().int().min(1).max(100).default(20),
}).strict();
export const productSetRename = selected.omit({ account_id: true }).extend({
  product_set_name: z.string().trim().min(1).max(128),
  expected_configuration_hash: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledge_shared_effects: z.literal(true),
}).strict();

const setRow = z.looseObject({
  product_set_id: nativeId, catalog_id: nativeId, bc_id: nativeId.optional(),
  product_set_name: z.string().optional(), name: z.string().optional(),
  conditions: z.record(z.string(), z.unknown()), product_count: count.optional(),
}).refine(row => typeof row.product_set_name === 'string' || typeof row.name === 'string')
  .refine(row => row.product_set_name === undefined || row.name === undefined || row.product_set_name === row.name)
  .transform(({ name, ...row }) => ({ ...row, product_set_name: row.product_set_name ?? name! }));
type ProductSet = z.infer<typeof setRow>;
type CatalogSelection = z.infer<typeof catalogInput>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const configuration = (row: ProductSet) => ({ product_set_id: row.product_set_id, catalog_id: row.catalog_id, product_set_name: row.product_set_name, conditions: row.conditions });
const hash = (input: CatalogSelection, row: ProductSet) => digest({ ...input, configuration: configuration(row) });
const invalid = () => new AdportError('PROVIDER_ERROR', 'TikTok product-set data has an unexpected scope, identifier or shape. No write was retried.');

/** Native set lists are unpaged; Adport pages a bounded, snapshot-bound result. */
export class TikTokCatalogProductSets {
  constructor(
    private readonly client: Pick<TikTokClient, 'get' | 'post'>,
    private readonly authorizeParent: (input: CatalogSelection, write?: boolean) => Promise<unknown>,
  ) {}

  private async request(path: string, params: Record<string, unknown>): Promise<unknown> {
    try { return await this.client.get(path, params, { jsonContentType: path === 'catalog/set/product/get' }); }
    catch (error) {
      if (error instanceof AdportError && ['POLICY_VIOLATION', 'NOT_CONNECTED'].includes(error.code)) throw error;
      throw new AdportError('PROVIDER_ERROR', 'TikTok product-set read failed. Check native catalog permissions. No provider error body is returned and no request was retried.');
    }
  }

  private async native(input: CatalogSelection, productSetId?: string, returnCount = false): Promise<ProductSet[]> {
    const parsed = z.object({ list: z.array(setRow).max(5000), page_info: z.object({ page: count, total_page: count, total_number: count.optional() }).optional() }).safeParse(await this.request('catalog/set/get', {
      bc_id: input.bc_id, catalog_id: input.catalog_id,
      ...(productSetId ? { product_set_id: productSetId } : {}), return_product_count: returnCount,
    }));
    if (!parsed.success) throw invalid();
    const rows = parsed.data.list;
    if (new Set(rows.map(row => row.product_set_id)).size !== rows.length || rows.some(row => row.catalog_id !== input.catalog_id || row.bc_id !== undefined && row.bc_id !== input.bc_id || productSetId && row.product_set_id !== productSetId) || productSetId && rows.length !== 1 || parsed.data.page_info && (parsed.data.page_info.page !== 1 || parsed.data.page_info.total_page > 1 || parsed.data.page_info.total_number !== undefined && parsed.data.page_info.total_number !== rows.length)) throw invalid();
    return rows;
  }

  async list(value: unknown) {
    const input = productSetList.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id });
    await this.authorizeParent(scope);
    const rows = (await this.native(scope, input.product_set_id, input.return_product_count)).sort((a, b) => a.product_set_id.localeCompare(b.product_set_id));
    const snapshot = digest({ ...scope, product_set_id: input.product_set_id, return_product_count: input.return_product_count, page_size: input.page_size, sets: rows.map(configuration) });
    let offset = 0;
    if (input.cursor) {
      let cursor;
      try { cursor = z.object({ offset: count.max(4999), snapshot: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
      catch { throw new AdportError('INVALID_INPUT', 'Invalid product-set cursor. Refresh the first page.'); }
      if (cursor.snapshot !== snapshot || cursor.offset === 0 || cursor.offset >= rows.length || cursor.offset % input.page_size !== 0) throw new AdportError('INVALID_INPUT', 'Product sets or selection changed. Refresh the first page.');
      offset = cursor.offset;
    }
    const sets = rows.slice(offset, offset + input.page_size).map(row => ({ ...row, configuration_hash: hash(scope, row) }));
    const hasMore = offset + sets.length < rows.length;
    return {
      sets, records: sets.map(row => ({ id: row.product_set_id, name: row.product_set_name, catalog_id: row.catalog_id, ...(row.product_count !== undefined ? { product_count: row.product_count } : {}), conditions: row.conditions })),
      complete: !hasMore, truncated: hasMore,
      ...(hasMore ? { next_cursor: Buffer.from(JSON.stringify({ offset: offset + sets.length, snapshot })).toString('base64url') } : {}),
      notes: ['TikTok returns the entire set list; Adport bounds it to 5,000 sets and pages it locally. Product counts are omitted by default to avoid native timeouts.'],
    };
  }

  async products(value: unknown) {
    const input = productSetProducts.parse(value);
    const scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id });
    await this.authorizeParent(scope);await this.native(scope, input.product_set_id);
    const parsed = z.object({
      product_set_id: nativeId, catalog_id: nativeId, product_count: count,
      products: z.array(z.looseObject({ product_id: nativeId, product_name: z.string(), catalog_id: nativeId.optional(), product_set_id: nativeId.optional(), bc_id: nativeId.optional() })).max(input.page_size),
      page_info: z.object({ page: z.number().int().positive().safe(), page_size: z.number().int().min(1).max(100), total_number: count.optional(), total_page: count.optional() }).optional(),
    }).safeParse(await this.request('catalog/set/product/get', { bc_id: input.bc_id, catalog_id: input.catalog_id, product_set_id: input.product_set_id, page: input.page, page_size: input.page_size }));
    if (!parsed.success || parsed.data.catalog_id !== input.catalog_id || parsed.data.product_set_id !== input.product_set_id) throw invalid();
    const data = parsed.data;
    if (new Set(data.products.map(row => row.product_id)).size !== data.products.length || data.page_info && (data.page_info.page !== input.page || data.page_info.page_size !== input.page_size) || data.products.some(row => row.catalog_id !== undefined && row.catalog_id !== input.catalog_id || row.product_set_id !== undefined && row.product_set_id !== input.product_set_id || row.bc_id !== undefined && row.bc_id !== input.bc_id)) throw invalid();
    const complete = data.page_info?.total_number !== undefined && data.page_info.total_number !== data.product_count ? null : nativeListComplete(data.page_info, data.products.length);
    return {
      ...data, records: data.products.map(row => ({ id: row.product_id, name: row.product_name, ...row })), complete, truncated: complete !== true,
      ...(complete === false ? { next_page: input.page + 1 } : {}),
      ...(complete === null ? { pagination_note: 'Native pagination is missing or contradictory; completeness is unknown.' } : {}),
    };
  }

  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'tiktok' || op.kind !== 'update' || op.tool !== 'tiktok_rename_product_set') throw new AdportError('INVALID_INPUT', 'Unsupported TikTok product-set mutation.');
    const input = productSetRename.parse(op.payload), scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id });
    await this.authorizeParent(scope, true);
    const current = (await this.native(scope, input.product_set_id))[0]!;
    if (hash(scope, current) !== input.expected_configuration_hash) throw new AdportError('INVALID_INPUT', 'Product-set configuration changed. Read and preview it again.');
    const notes = ['The set may be reused by other ads or accounts. Only its name changes; filter conditions are preserved.', 'Preview is local. TikTok checks native eligibility on apply. No ads are activated or tracking events sent.', 'An uncertain result retains the known set ID. Inspect it before another write; never replay automatically.'];
    return {
      summary: `Rename TikTok product set ${current.product_set_name}`,
      changes: [`~ Product-set name ${JSON.stringify(current.product_set_name)} → ${JSON.stringify(input.product_set_name)}`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: scope.account_id, kind: 'update', title: 'Rename product set', subject: current.product_set_name, fields: [{ label: 'Name', before: current.product_set_name, after: input.product_set_name }, { label: 'Catalog', after: input.catalog_id }, { label: 'Product set', after: input.product_set_id }], notices: notes },
      execute: async () => {
        await this.authorizeParent(scope, true);
        try {
          const receipt = z.object({ product_set_id: nativeId }).parse(await this.client.post('catalog/set/update', { bc_id: input.bc_id, catalog_id: input.catalog_id, product_set_id: input.product_set_id, product_set_name: input.product_set_name }));
          if (receipt.product_set_id !== input.product_set_id) throw new Error('Set ID differs');
          const actual = (await this.native(scope, input.product_set_id))[0]!;
          if (canonical(configuration(actual)) !== canonical({ ...configuration(current), product_set_name: input.product_set_name })) throw new Error('Configuration differs');
          return [input.product_set_id];
        } catch {
          throw new AdportError('PROVIDER_ERROR', 'TikTok product-set rename outcome is unconfirmed. Read the known set before another write; do not replay automatically.', { resource_ids: [input.product_set_id] });
        }
      },
    };
  }
}
