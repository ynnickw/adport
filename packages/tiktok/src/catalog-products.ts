import { AdportError, csvRows, MAX_PROJECT_MEDIA_BYTES, verifyMedia, type Creative, type MediaResolver, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import type { TikTokCatalogFeeds } from './catalog-feeds.js';
import { catalogId, catalogInput } from './catalog-schema.js';
import { nativeListComplete } from './pagination.js';

const count = z.number().int().nonnegative().safe();
const nativeId = z.union([catalogId, z.number().int().positive().safe()]).transform(String);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uniqueIds = z.array(catalogId).min(1).max(1000).refine(values => new Set(values).size === values.length, 'IDs must be unique');
export const catalogProductList = catalogInput.extend({
  product_ids: uniqueIds.optional(), sku_ids: z.array(z.string().min(1).max(100)).min(1).max(1000).refine(values => new Set(values).size === values.length, 'SKU IDs must be unique').optional(),
  page: z.number().int().positive().max(10_000).default(1), page_size: z.number().int().min(1).max(100).default(20),
}).strict().refine(value => !(value.product_ids && value.sku_ids), 'Choose product_ids or sku_ids, not both')
  .refine(value => value.page * value.page_size <= 10_000, 'TikTok only exposes the first 10,000 matching products');
export const catalogProductLog = catalogInput.extend({ feed_id: catalogId, feed_log_id: catalogId }).strict();
export const catalogFileImport = catalogInput.omit({ account_id: true }).extend({
  feed_id: catalogId, media_id: z.string().uuid(), expected_sha256: hash,
  expected_catalog_hash: hash, expected_feed_hash: hash, update_mode: z.enum(['INCREMENTAL', 'OVERWRITE']),
  acknowledge_shared_effects: z.literal(true), acknowledge_async_processing: z.literal(true), acknowledge_overwrite: z.literal(true).optional(),
}).strict().refine(value => value.update_mode !== 'OVERWRITE' || value.acknowledge_overwrite === true, 'OVERWRITE can delete products missing from the CSV; explicitly acknowledge it');
type Selection = z.infer<typeof catalogInput>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const product = z.object({
  product_id: nativeId, catalog_id: nativeId.optional(), bc_id: nativeId.optional(),
  sku_id: z.string().max(100).optional(), hotel_id: z.string().max(512).optional(), flight_id: z.string().max(512).optional(), destination_id: z.string().max(512).optional(),
  vehicle_id: z.string().max(512).optional(), series_id: z.string().max(512).optional(), item_id: z.string().max(512).optional(), listing_id: z.string().max(512).optional(),
  title: z.string().max(10_000).optional(), name: z.string().max(10_000).optional(), destination_name: z.string().max(10_000).optional(),
  description: z.string().max(10_000).optional(), brand: z.string().max(1000).optional(), availability: z.string().max(100).optional(), active_status: z.string().max(100).optional(),
  available: z.boolean().optional(), ad_creation_eligible: z.string().max(100).optional(), audit: z.object({ audit_status: z.string().max(100).optional() }).optional(),
  image_url: z.string().max(8192).optional(), video_url: z.string().max(8192).optional(),
});
const invalid = () => new AdportError('PROVIDER_ERROR', 'TikTok catalog-product response has an unexpected scope, identifier or shape. No request was retried.');
const mediaUrl = (value?: string) => {
  try { const url = new URL(value ?? '');return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};

/** Native file imports return task IDs. Acceptance never certifies completed ingestion. */
export class TikTokCatalogProducts {
  constructor(
    private readonly client: Pick<TikTokClient, 'get' | 'post'>,
    private readonly authorizeParent: (input: Selection, write?: boolean) => Promise<{ configuration_hash: string; catalog_type: string }>,
    private readonly feeds: Pick<TikTokCatalogFeeds, 'list'>,
    private readonly media?: MediaResolver,
  ) {}
  private async request(path: string, input: Record<string, unknown>): Promise<unknown> {
    try { return await this.client.get(path, input, { jsonContentType: true }); }
    catch (error) {
      if (error instanceof AdportError && ['POLICY_VIOLATION', 'NOT_CONNECTED'].includes(error.code)) throw error;
      throw new AdportError('PROVIDER_ERROR', 'TikTok catalog-product read failed. Check native permissions and the exact catalog/feed/job. Provider bodies and file URLs stay hidden; no request was retried.');
    }
  }
  async list(value: unknown) {
    const input = catalogProductList.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id });
    const parent = await this.authorizeParent(scope);
    if (input.sku_ids && parent.catalog_type !== 'ECOM') throw new AdportError('INVALID_INPUT', 'The SKU filter requires an E-commerce catalog; use native product IDs for other catalog types.');
    const result = z.object({ list: z.array(product).max(input.page_size), page_info: z.object({ page: z.number().int().positive().safe(), page_size: z.number().int().positive().max(500), total_number: count.optional(), total_page: count.optional() }).optional() }).safeParse(await this.request('catalog/product/get', {
      bc_id: input.bc_id, catalog_id: input.catalog_id, page: input.page, page_size: input.page_size,
      ...(input.product_ids ? { product_ids: input.product_ids } : {}), ...(input.sku_ids ? { sku_ids: input.sku_ids } : {}),
    }));
    if (!result.success) throw invalid();
    const rows = result.data.list, page = result.data.page_info;
    if (new Set(rows.map(row => row.product_id)).size !== rows.length || rows.some(row => row.catalog_id !== undefined && row.catalog_id !== input.catalog_id || row.bc_id !== undefined && row.bc_id !== input.bc_id || input.product_ids && !input.product_ids.includes(row.product_id) || input.sku_ids && (!row.sku_id || !input.sku_ids.includes(row.sku_id))) || page && (page.page !== input.page || page.page_size !== input.page_size)) throw invalid();
    const products = rows.map(row => ({ product_id: row.product_id, external_id: row.sku_id ?? row.hotel_id ?? row.flight_id ?? row.destination_id ?? row.vehicle_id ?? row.series_id ?? row.item_id ?? row.listing_id,
      name: row.title ?? row.name ?? row.destination_name ?? row.product_id, availability: row.availability, active_status: row.active_status,
      available: row.available, ad_creation_eligible: row.ad_creation_eligible, audit_status: row.audit?.audit_status, brand: row.brand,
      image_url: mediaUrl(row.image_url), video_url: mediaUrl(row.video_url), description: row.description?.slice(0, 300), description_truncated: (row.description?.length ?? 0) > 300,
    }));
    const complete = nativeListComplete(page, rows.length), ceiling = complete !== true && (input.page + 1) * input.page_size > 10_000;
    const creatives: Creative[] = products.map(row => ({ id: row.product_id, provider: 'tiktok', account_id: input.account_id, type: 'catalog_product', name: row.name,
      ...(row.audit_status ? { status: row.audit_status } : {}), headlines: [], descriptions: row.description ? [row.description] : [], landing_urls: [], actions: [],
      media: [...(row.image_url ? [{ type: 'image' as const, url: row.image_url, alt: row.name }] : []), ...(row.video_url ? [{ type: 'video' as const, url: row.video_url, alt: row.name }] : [])],
    }));
    return { products, creatives, complete, truncated: complete !== true, ...(complete === false && !ceiling ? { next_page: input.page + 1 } : {}),
      ...(page ? { page_info: page } : {}), native_access_limit: 10_000, native_limit_reached: ceiling,
      notes: ['This is a compact product/media view, not full editable configuration. Product audit, stock and advertiser activation are separate from ad-creation eligibility.', 'TikTok exposes at most the first 10,000 matching products. Use ID filters to narrow larger catalogs; no continuation is fabricated beyond that cap.', ...(complete === null ? ['Native pagination is absent or contradictory; completeness is unknown.'] : [])],
    };
  }
  private async selectedFeed(scope: Selection, feedId: string) {
    const result = await this.feeds.list({ ...scope, feed_id: feedId });
    if (result.feeds.length !== 1 || result.feeds[0]!.feed_id !== feedId) throw invalid();
    return result.feeds[0]!;
  }
  async log(value: unknown) {
    const input = catalogProductLog.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id });
    await this.authorizeParent(scope);await this.selectedFeed(scope, input.feed_id);
    const issue = z.object({ field: z.string().max(256 * 1024).nullable().optional(), affected_product_count: count });
    const result = z.object({ product_feed_log: z.object({
      catalog_id: nativeId.optional(), bc_id: nativeId.optional(), feed_id: nativeId.optional(), feeds_id: nativeId.optional(), feed_log_id: nativeId.optional(),
      process_status: z.enum(['WAITING', 'PROCESSING', 'SUCCESS', 'FAILED']), update_mode: z.union([z.enum(['INCREASE', 'REPLACE', 'INCREMENTAL', 'OVERWRITE']), count]).optional(),
      add_count: count.optional(), update_count: count.optional(), delete_count: count.optional(), error_count: count.optional(), warn_count: count.optional(),
      start_time: z.string().max(40).regex(/^[0-9TZ :.+-]*$/).nullable().optional(), end_time: z.string().max(40).regex(/^[0-9TZ :.+-]*$/).nullable().optional(),
      feed_log_data: z.object({ error_affected_products: z.array(issue).max(1000).nullable().optional(), warn_affected_products: z.array(issue).max(1000).nullable().optional() }).nullable().optional(),
    }) }).safeParse(await this.request('catalog/product/log', { bc_id: input.bc_id, catalog_id: input.catalog_id, feed_log_id: input.feed_log_id, language: 'en' }));
    if (!result.success) throw invalid();
    const row = result.data.product_feed_log, feedId = row.feed_id ?? row.feeds_id;
    if (feedId !== input.feed_id || row.feed_id !== undefined && row.feeds_id !== undefined && row.feed_id !== row.feeds_id || row.catalog_id !== undefined && row.catalog_id !== input.catalog_id || row.bc_id !== undefined && row.bc_id !== input.bc_id || row.feed_log_id !== undefined && row.feed_log_id !== input.feed_log_id) throw invalid();
    const { feed_log_data: issues, feeds_id: _legacy, ...fields } = row;
    const publicIssues = (rows: Array<z.infer<typeof issue>>) => rows.slice(0, 50).map(row => ({ field: typeof row.field === 'string' && row.field.length <= 128 && /^[a-zA-Z0-9_.\[\]-]+$/.test(row.field) ? row.field : 'Unrecognized field', affected_product_count: row.affected_product_count }));
    const log = { ...fields, feed_id: input.feed_id, feed_log_id: input.feed_log_id,
      ...(row.update_mode !== undefined ? { update_mode_recognized: typeof row.update_mode === 'string' } : {}),
      ...(issues?.error_affected_products ? { error_fields: publicIssues(issues.error_affected_products) } : {}), ...(issues?.warn_affected_products ? { warning_fields: publicIssues(issues.warn_affected_products) } : {}),
      diagnostic_fields_truncated: (issues?.error_affected_products?.length ?? 0) > 50 || (issues?.warn_affected_products?.length ?? 0) > 50,
    };
    return { log, records: [{ id: input.feed_log_id, name: 'Product import', status: row.process_status === 'SUCCESS' && (row.error_count ?? 0) > 0 ? 'Completed with item errors' : row.process_status, added: row.add_count, updated: row.update_count, removed: row.delete_count, errors: row.error_count, warnings: row.warn_count }],
      processing_complete: ['SUCCESS', 'FAILED'].includes(row.process_status), complete: true, truncated: false,
      notes: ['Counts and processing state are native; missing counts remain unavailable. SUCCESS does not establish ad eligibility or delivery.', 'The native reference labels update_mode as numeric but documents string enum values. Numeric codes are retained without an invented mapping and cannot verify the approved import mode.', 'Diagnostic field/count groups are bounded to 50 per severity. Native download links, free-form error text and product samples are omitted to keep file capabilities private.'],
    };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'tiktok' || op.tool !== 'tiktok_import_catalog_file' || op.kind !== 'update') throw new AdportError('INVALID_INPUT', 'Unsupported TikTok product import operation.');
    const input = catalogFileImport.parse(op.payload), scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id });
    const media = this.media, providerUrl = media?.providerUrl?.bind(media);
    if (!media || !providerUrl) throw new AdportError('NOT_CONNECTED', 'CSV feed imports require the hosted project media library. Stage the file through an agent, widget, dashboard or cloud media CLI, then use its media_id and SHA-256.');
    const prepare = async () => {
      const parent = await this.authorizeParent(scope, true), feed = await this.selectedFeed(scope, input.feed_id);
      if (parent.configuration_hash !== input.expected_catalog_hash || feed.configuration_hash !== input.expected_feed_hash) throw new AdportError('INVALID_INPUT', 'Catalog or feed configuration changed. Read and preview the import again.');
      if (!['DATA_FEED', 'COUNTRY_FEED'].includes(feed.feed_type)) throw new AdportError('INVALID_INPUT', 'Read a feed with a known native DATA_FEED or COUNTRY_FEED type before importing.');
      const source = await media.read(input, { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: ['text/csv'] });
      const file = verifyMedia(source.bytes, source.name, input.expected_sha256, { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: ['text/csv'] });
      const rows = csvRows(file.bytes), first = rows.next();let rowCount = 0;
      if (first.done) throw new AdportError('INVALID_INPUT', 'The catalog CSV needs a header and at least one product row.');
      const header = first.value;
      if (header.some(field => !field.trim()) || new Set(header).size !== header.length) throw new AdportError('INVALID_INPUT', 'The catalog CSV needs nonempty, distinct column headers matching the selected catalog/feed template.');
      for (const row of rows) { if (!row.some(field => field.trim())) throw new AdportError('INVALID_INPUT', 'Remove blank product rows before importing.');rowCount++; }
      if (!rowCount) throw new AdportError('INVALID_INPUT', 'The catalog CSV needs at least one product row.');
      return { parent, feed, file, rowCount, columns: header.length };
    };
    const initial = await prepare();
    const notes = ['Submits a one-time asynchronous import into this existing feed. Native processing validates catalog-specific columns, feed ownership and product eligibility; local CSV validation does not certify the provider template.', input.update_mode === 'OVERWRITE' ? 'OVERWRITE removes existing feed products missing from this file and can change ads using them.' : 'INCREMENTAL adds products and updates matching products; products omitted from the CSV remain.', 'This request does not change the feed’s saved update mode or activate ads. Feed scheduling is managed separately; read fresh feed state before changing automation.', 'The result is an accepted task ID, not completed ingestion. Read tiktok_catalog_product_log until terminal and inspect item errors. Never automatically replay an uncertain import.'];
    return { summary: `Import ${initial.rowCount} product rows into TikTok feed ${input.feed_id}`, changes: [`~ One-time ${input.update_mode} product import into ${initial.feed.feed_type} ${input.feed_id}`, `+ CSV ${JSON.stringify(initial.file.name)}; ${initial.file.bytes.byteLength} bytes; SHA-256 ${initial.file.sha256}`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: scope.account_id, kind: 'update', title: 'Import catalog file', subject: initial.file.name, fields: [{ label: 'Catalog', after: input.catalog_id }, { label: 'Feed', after: input.feed_id }, { label: 'Feed type', after: initial.feed.feed_type }, { label: 'Feed schedule', after: initial.feed.status }, { label: 'Import mode', after: input.update_mode }, { label: 'Product rows', after: String(initial.rowCount) }, { label: 'CSV columns', after: String(initial.columns) }, { label: 'SHA-256', after: initial.file.sha256 }], notices: notes },
      execute: async () => {
        await prepare();
        const grant = await providerUrl(input, { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: ['text/csv'] });
        if (grant.sha256 !== input.expected_sha256 || !mediaUrl(grant.url) || !Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now() + 60_000) throw new AdportError('PROVIDER_ERROR', 'The private CSV download grant could not be verified. No TikTok import was submitted.');
        let jobId: string | undefined;
        try {
          const receipt = z.object({ feed_log_id: nativeId }).parse(await this.client.post('catalog/product/file', { bc_id: input.bc_id, catalog_id: input.catalog_id, feed_id: input.feed_id, file_url: grant.url, update_mode: input.update_mode }));jobId = receipt.feed_log_id;
          const actual = await this.log({ ...scope, feed_id: input.feed_id, feed_log_id: jobId });
          const expectedModes = input.update_mode === 'INCREMENTAL' ? ['INCREMENTAL', 'INCREASE'] : ['OVERWRITE', 'REPLACE'];
          if (actual.log.update_mode !== undefined && (typeof actual.log.update_mode !== 'string' || !expectedModes.includes(actual.log.update_mode))) throw new Error('Native processing mode is unrecognized or differs from approval');
          if (actual.log.process_status === 'FAILED' || actual.log.process_status === 'SUCCESS' && (actual.log.error_count ?? 0) > 0) throw new Error('Native processing reports failure or item errors');
          return [jobId];
        } catch {
          throw new AdportError('PROVIDER_ERROR', 'TikTok product import failed, has item errors or its outcome is unconfirmed. Read the known import job or feed history before another write; do not replay automatically.', jobId ? { resource_ids: [jobId], feed_log_id: jobId, feed_id: input.feed_id } : undefined);
        }
      },
    };
  }
}
