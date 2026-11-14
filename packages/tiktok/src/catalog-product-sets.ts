import { createHash } from 'node:crypto';
import { AdportError, csvRows, MAX_PROJECT_MEDIA_BYTES, mediaSourceFields, verifyMedia, type MediaResolver, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import { catalogId, catalogInput } from './catalog-schema.js';
import { nativeListComplete } from './pagination.js';
import { describeProductSetConditions, nativeProductSetConditions, productSetConditions } from './product-set-conditions.js';

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
export const productSetCreate = catalogInput.omit({ account_id: true }).extend({
  product_set_name: z.string().trim().min(1).max(128), conditions: productSetConditions,
  expected_catalog_hash: z.string().regex(/^[a-f0-9]{64}$/), acknowledge_shared_effects: z.literal(true),
}).strict();
export const productSetUpload = catalogInput.omit({ account_id: true }).extend({
  ...mediaSourceFields, product_set_name: z.string().trim().min(1).max(28),
  expected_catalog_hash: z.string().regex(/^[a-f0-9]{64}$/), acknowledge_shared_effects: z.literal(true),
}).strict().refine(value => Number(!!value.media_id) + Number(!!value.file_path) === 1, 'Choose one project media_id or local file_path');
export const productSetUpdateConditions = selected.omit({ account_id: true }).extend({
  conditions: productSetConditions, expected_configuration_hash: z.string().regex(/^[a-f0-9]{64}$/), acknowledge_shared_effects: z.literal(true),
}).strict();
export const productSetDelete = catalogInput.omit({ account_id: true }).extend({
  sets: z.array(z.object({ product_set_id: catalogId, expected_configuration_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(10).refine(rows => new Set(rows.map(row => row.product_set_id)).size === rows.length, 'Product-set IDs must be unique'),
  acknowledge_shared_effects: z.literal(true),
}).strict();

const setRow = z.looseObject({
  product_set_id: nativeId, catalog_id: nativeId, bc_id: nativeId.optional(),
  product_set_name: z.string().optional(), name: z.string().optional(),
  conditions: nativeProductSetConditions, product_count: count.optional(),
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
    private readonly client: Pick<TikTokClient, 'get' | 'post'> & Partial<Pick<TikTokClient, 'postMultipart'>>,
    private readonly authorizeParent: (input: CatalogSelection, write?: boolean) => Promise<{ configuration_hash: string; catalog_type?: string }>,
    private readonly media?: MediaResolver,
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
    if (op.provider !== 'tiktok') throw new AdportError('INVALID_INPUT', 'TikTok product-set provider mismatch.');
    if (op.tool === 'tiktok_upload_product_set' && op.kind === 'create') return this.uploadPlan(op);
    if (op.tool === 'tiktok_create_product_set' && op.kind === 'create') return this.createPlan(op);
    if (op.tool === 'tiktok_update_product_set_conditions' && op.kind === 'update') return this.conditionsPlan(op);
    if (op.tool === 'tiktok_delete_product_sets' && op.kind === 'remove') return this.deletePlan(op);
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

  private async uploadPlan(op: WriteOperation): Promise<Plan> {
    const input = productSetUpload.parse(op.payload), scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id });
    const media = this.media, multipart = this.client.postMultipart?.bind(this.client);
    if (!media || !multipart) throw new AdportError('NOT_CONNECTED', 'This runtime does not support checksum-bound catalog file uploads.');
    const prepare = async () => {
      const parent = await this.authorizeParent(scope, true);
      if (parent.configuration_hash !== input.expected_catalog_hash) throw new AdportError('INVALID_INPUT', 'Catalog configuration changed. Read and preview creation again.');
      if (parent.catalog_type !== 'ECOM') throw new AdportError('INVALID_INPUT', 'CSV product-set creation requires an E-commerce (ECOM) catalog.');
      if ((await this.native(scope)).some(row => row.product_set_name === input.product_set_name)) throw new AdportError('INVALID_INPUT', 'This catalog already has a product set with that name. Choose a unique name.');
      const source = await media.read(input, { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: ['text/csv'] });
      const file = verifyMedia(source.bytes, source.name, input.expected_sha256, { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: ['text/csv'] });
      const rows = csvRows(file.bytes, { maxRows: 5001, maxColumns: 1 }), header = rows.next().value;
      if (header?.[0] !== 'sku_id') throw new AdportError('INVALID_INPUT', 'Use TikTok’s CSV template: one column named sku_id and 1–5,000 distinct SKU IDs.');
      const skus = new Set<string>();
      for (const row of rows) {
        const sku = row[0]!;
        if (!sku.trim() || skus.has(sku)) throw new AdportError('INVALID_INPUT', 'The sku_id column must contain 1–5,000 nonempty, distinct IDs. Values are preserved as text.');
        skus.add(sku);
      }
      if (!skus.size) throw new AdportError('INVALID_INPUT', 'The sku_id column needs at least one SKU ID.');
      return { file, count: skus.size };
    };
    const prepared = await prepare();
    const notes = ['Creates an E-commerce set from the exact approved CSV; no ads are activated or budgets changed.', 'Adport caps the template at 5,000 SKU rows. TikTok checks SKU eligibility and membership on apply; independent readback confirms the set ID/name, not full membership or ingestion.', 'No automatic retry. Reconcile an uncertain creation by its known ID or unique name before another upload.'];
    return {
      summary: `Create TikTok product set ${input.product_set_name} from CSV`, changes: [`+ Product set ${JSON.stringify(input.product_set_name)} from ${prepared.count} SKU rows`, `+ File ${JSON.stringify(prepared.file.name)}; ${prepared.file.bytes.byteLength} bytes; SHA-256 ${prepared.file.sha256}`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: scope.account_id, kind: 'create', title: 'Upload product set', subject: input.product_set_name, fields: [{ label: 'Catalog', after: input.catalog_id }, { label: 'File', after: prepared.file.name }, { label: 'SKU rows', after: String(prepared.count) }, { label: 'SHA-256', after: prepared.file.sha256 }], notices: notes },
      execute: async () => {
        const { file } = await prepare();
        const form = new FormData();
        form.set('bc_id', input.bc_id); form.set('catalog_id', input.catalog_id); form.set('product_set_name', input.product_set_name);
        form.set('file', new Blob([file.bytes], { type: 'text/csv' }), 'product-set.csv');
        form.set('file_signature', createHash('md5').update(file.bytes).digest('hex'));
        let createdId: string | undefined;
        try {
          const receipt = z.looseObject({ product_set_id: nativeId }).parse(await multipart('catalog/set/upload', form));
          createdId = receipt.product_set_id;
          if (receipt.product_set_name !== input.product_set_name) throw new Error('Receipt name differs');
          const actual = (await this.native(scope, createdId))[0]!;
          if (actual.product_set_name !== input.product_set_name) throw new Error('Readback name differs');
          return [createdId];
        } catch {
          throw new AdportError('PROVIDER_ERROR', 'TikTok CSV product-set creation outcome is unconfirmed. Inspect catalog sets by the approved unique name or known ID before another write; do not replay automatically.', createdId ? { resource_ids: [createdId] } : undefined);
        }
      },
    };
  }

  private async createPlan(op: WriteOperation): Promise<Plan> {
    const input = productSetCreate.parse(op.payload), scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id });
    const verifyParent = async () => {
      const parent = await this.authorizeParent(scope, true);
      if (parent.configuration_hash !== input.expected_catalog_hash) throw new AdportError('INVALID_INPUT', 'Catalog configuration changed. Read the catalog and review creation again.');
    };
    await verifyParent();
    const notes = ['Creates a filter-defined set in the selected catalog; it does not create or activate an ad.', 'Field names and catalog-specific values are checked by TikTok on apply; this is a local preview. Adport allows up to 1,024 combined values.', 'No automatic retry. An unknown creation outcome must be reconciled before another create.'];
    return {
      summary: `Create TikTok product set ${input.product_set_name}`, changes: [`+ Product set ${JSON.stringify(input.product_set_name)}`, `+ Product selection ${canonical(input.conditions)}`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: scope.account_id, kind: 'create', title: 'Create product set', subject: input.product_set_name, fields: [{ label: 'Catalog', after: input.catalog_id }, { label: 'Product selection', after: describeProductSetConditions(input.conditions), format: 'text' }], notices: notes },
      execute: async () => {
        await verifyParent();let createdId: string | undefined;
        try {
          const receipt = z.object({ product_set_id: nativeId }).parse(await this.client.post('catalog/set/create', { bc_id: input.bc_id, catalog_id: input.catalog_id, product_set_name: input.product_set_name, conditions: input.conditions }));
          createdId = receipt.product_set_id;
          const actual = (await this.native(scope, createdId))[0]!;
          if (actual.product_set_name !== input.product_set_name || canonical(actual.conditions) !== canonical(input.conditions)) throw new Error('Creation readback differs');
          return [createdId];
        } catch {
          throw new AdportError('PROVIDER_ERROR', 'TikTok product-set creation outcome is unconfirmed. Inspect catalog sets before another create; do not replay automatically.', createdId ? { resource_ids: [createdId] } : undefined);
        }
      },
    };
  }

  private async conditionsPlan(op: WriteOperation): Promise<Plan> {
    const input = productSetUpdateConditions.parse(op.payload), scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id });
    await this.authorizeParent(scope, true);
    const current = (await this.native(scope, input.product_set_id))[0]!;
    if (hash(scope, current) !== input.expected_configuration_hash) throw new AdportError('INVALID_INPUT', 'Product-set configuration changed. Read and review it again.');
    const notes = ['Replaces the complete filter definition. Existing ads using this shared set may select different products after apply.', 'The name is preserved. No ad is activated and no budget or tracking event is changed.', 'Catalog-specific fields and values are checked by TikTok on apply; preview is local. No automatic retry after an uncertain result.'];
    return {
      summary: `Change TikTok product selection for ${current.product_set_name}`, changes: [`~ Product selection ${canonical(current.conditions)} → ${canonical(input.conditions)}`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: scope.account_id, kind: 'update', title: 'Change product selection', subject: current.product_set_name, fields: [{ label: 'Product selection', before: describeProductSetConditions(current.conditions), after: describeProductSetConditions(input.conditions), format: 'text' }, { label: 'Catalog', after: input.catalog_id }, { label: 'Product set', after: input.product_set_id }], notices: notes },
      execute: async () => {
        await this.authorizeParent(scope, true);
        try {
          const receipt = z.object({ product_set_id: nativeId }).parse(await this.client.post('catalog/set/update', { bc_id: input.bc_id, catalog_id: input.catalog_id, product_set_id: input.product_set_id, conditions: input.conditions }));
          if (receipt.product_set_id !== input.product_set_id) throw new Error('Set ID differs');
          const actual = (await this.native(scope, input.product_set_id))[0]!;
          if (canonical(configuration(actual)) !== canonical({ ...configuration(current), conditions: input.conditions })) throw new Error('Filter or name preservation differs');
          return [input.product_set_id];
        } catch {
          throw new AdportError('PROVIDER_ERROR', 'TikTok product-set filter change outcome is unconfirmed. Read the known set before another write; do not replay automatically.', { resource_ids: [input.product_set_id] });
        }
      },
    };
  }

  private async deletePlan(op: WriteOperation): Promise<Plan> {
    const input = productSetDelete.parse(op.payload), scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id });
    await this.authorizeParent(scope, true);
    const current: ProductSet[] = [];
    for (const target of input.sets) {
      const row = (await this.native(scope, target.product_set_id))[0]!;
      if (hash(scope, row) !== target.expected_configuration_hash) throw new AdportError('INVALID_INPUT', 'A product-set configuration changed. Read and review every selected set again.');
      current.push(row);
    }
    const ids = current.map(row => row.product_set_id);
    const notes = ['Permanently deletes the selected shared set definitions. Existing ads may reference them; there is no automatic restoration.', 'The full selected set list and each configuration hash are checked before apply. TikTok checks native dependencies and eligibility.', 'No automatic retry after a partial or uncertain result. Reconcile every known ID before another delete.'];
    return {
      summary: `Delete ${current.length} TikTok product set${current.length === 1 ? '' : 's'}`, changes: current.map(row => `- Product set ${row.product_set_id}: ${JSON.stringify(row.product_set_name)}`), coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: scope.account_id, kind: 'remove', title: 'Delete product sets', subject: current.length === 1 ? current[0]!.product_set_name : `${current.length} product sets`, fields: current.map(row => ({ label: `Product set ${row.product_set_id}`, before: row.product_set_name, after: 'Permanently deleted' })), notices: notes },
      execute: async () => {
        await this.authorizeParent(scope, true);
        try {
          const receipt = z.object({ product_set_ids: z.array(nativeId).min(1).max(10) }).parse(await this.client.post('catalog/set/delete', { bc_id: input.bc_id, catalog_id: input.catalog_id, product_set_ids: ids }));
          if (receipt.product_set_ids.length !== ids.length || new Set(receipt.product_set_ids).size !== ids.length || receipt.product_set_ids.some(id => !ids.includes(id))) throw new Error('Deletion receipt differs');
          const remaining = await this.native(scope);
          if (remaining.some(row => ids.includes(row.product_set_id))) throw new Error('Deleted set remains in catalog');
          return ids;
        } catch {
          throw new AdportError('PROVIDER_ERROR', 'TikTok product-set deletion outcome is partial or unconfirmed. Inspect every known set ID before another write; do not replay automatically.', { resource_ids: ids });
        }
      },
    };
  }
}
