import { createHash } from 'node:crypto';
import { AdportError, csvRows, MAX_PROJECT_MEDIA_BYTES, verifyMedia, type Creative, type MediaResolver, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import { catalogId, catalogInput } from './catalog-schema.js';
import { nativeListComplete } from './pagination.js';

type Row = Record<string, unknown>;
type Selection = z.infer<typeof catalogInput>;
type Parent = { configuration_hash: string; catalog_type: string; catalog_conf: Row; can_write: boolean };
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const hash = z.string().regex(/^[a-f0-9]{64}$/), count = z.number().int().nonnegative().safe();
const nativeId = z.union([catalogId, z.number().int().positive().safe()]).transform(String);
const videoId = z.string().min(1).max(1024).regex(/^[^\u0000-\u0020\u007f]+$/);
const time = z.string().max(40).regex(/^[0-9TZ :.+-]*$/);
const text = z.string().max(256 * 1024).nullable().optional();
const metadata = { category: text, brand: text, creator: text, video_type: text, description: text, landing_page_url: text, custom_label_0: text, custom_label_1: text, custom_label_2: text, custom_label_3: text, custom_label_4: text };
const metadataKeys = Object.keys(metadata) as Array<keyof typeof metadata>;
const nativeVideo = z.object({ ...metadata, catalog_video_id: videoId, video_name: z.string().max(4000), video_link: z.string().max(256 * 1024).optional(), sku_id_list: z.array(z.string().max(100)).max(20).optional(),
  video_id: videoId.nullable().optional(), video_signature: z.string().max(128).nullable().optional(), status: z.enum(['PENDING', 'SUCCESS', 'FAILED']), active_status: z.enum(['ACTIVATED', 'DEACTIVATED']).optional(), create_time: time.optional(), preview_url: z.string().max(16384).nullable().optional(),
  catalog_id: nativeId.optional(), bc_id: nativeId.optional(),
});
type Video = z.infer<typeof nativeVideo>;
const displayMetadata = (row: Video): Partial<Pick<Video, Exclude<keyof typeof metadata, 'landing_page_url'>>> => Object.fromEntries(metadataKeys.filter(key => key !== 'landing_page_url' && row[key] !== undefined).map(key => [key, typeof row[key] === 'string' ? row[key].slice(0, 1000) : row[key]]));
const source = catalogInput.extend({ media_id: z.string().uuid(), expected_sha256: hash }).strict();
export const catalogVideoImportContext = source;
export const catalogVideoList = catalogInput.extend({ catalog_video_ids: z.array(videoId).min(1).max(50).refine(ids => new Set(ids).size === ids.length, 'Video IDs must be unique').optional(), page: z.number().int().positive().safe().default(1), page_size: z.number().int().min(1).max(50).default(20) }).strict();
export const catalogVideoLog = catalogInput.extend({ feed_log_id: catalogId }).strict();
export const catalogVideoUpload = source.omit({ account_id: true }).extend({ expected_catalog_hash: hash, expected_associations_hash: hash, sync_to_selected_account: z.boolean().default(false), acknowledge_account_copy: z.literal(true).optional(), acknowledge_shared_effects: z.literal(true), acknowledge_possible_delivery: z.literal(true), acknowledge_async_processing: z.literal(true) }).strict().refine(value => !value.sync_to_selected_account || value.acknowledge_account_copy === true, 'Syncing creates separate advertiser-library copies; acknowledge_account_copy is required');
export const catalogVideoDelete = catalogInput.omit({ account_id: true }).extend({ catalog_video_id: videoId, expected_configuration_hash: hash, acknowledge_shared_effects: z.literal(true) }).strict();
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const safeUrl = (value: unknown, httpsOnly = true): string | undefined => {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return;
  try { const url = new URL(value);return (httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) && !url.username && !url.password ? url.href : undefined; } catch { return; }
};
const sourceInfo = (value?: string) => { try { const url = new URL(value ?? '');return { origin: url.origin, sha256: digest(value) }; } catch { return undefined; } };
const config = (row: Video) => ({ ...Object.fromEntries(metadataKeys.filter(key => row[key] !== undefined).map(key => [key, row[key]])), catalog_video_id: row.catalog_video_id, video_name: row.video_name, video_link: row.video_link, sku_id_list: row.sku_id_list, active_status: row.active_status });
const configurationHash = (scope: Selection, row: Video) => digest({ ...scope, configuration: config(row) });
const invalid = () => new AdportError('PROVIDER_ERROR', 'TikTok returned an unexpected catalog-video scope, identifier or shape. No request was retried.');
const failure = (error: unknown, message: string, ids?: string[]) => {
  const details = object(error instanceof AdportError ? error.details : undefined);
  return new AdportError('PROVIDER_ERROR', `${message} Provider bodies and source URLs stay hidden; no request was retried.`, { ...(Number.isSafeInteger(details.code) ? { provider_code: details.code } : {}), ...(typeof details.request_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(details.request_id) ? { request_id: details.request_id } : {}), ...(ids ? { resourceIds: ids } : {}) });
};
const columns = ['video_name', 'video_link', 'sku_id_list', 'category', 'brand', 'creator', 'video_type', 'description', 'landing_page_url', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4'];

/** Official catalog/video file/log/get/delete contracts refreshed 2026-11-05. */
export class TikTokCatalogVideos {
  constructor(private readonly client: Pick<TikTokClient, 'get' | 'post'>, private readonly authorizeParent: (scope: Selection, write?: boolean) => Promise<Parent>, private readonly media?: MediaResolver) {}
  private async parent(scope: Selection, write = false) {
    const parent = await this.authorizeParent(scope, write);
    if (parent.catalog_type !== 'ECOM' || parent.catalog_conf.is_multi_country === true) throw new AdportError('INVALID_INPUT', 'Catalog videos require a single-country E-commerce catalog.');
    return parent;
  }
  private async request(path: string, args: Row) {
    try { return await this.client.get(path, args, { jsonContentType: true }); } catch (error) { throw failure(error, 'TikTok catalog-video read failed. Check native permissions and the selected catalog/job.'); }
  }
  private async native(scope: Selection, ids?: string[], page = 1, size = 20) {
    const result = z.object({ videos: z.array(nativeVideo).max(ids ? ids.length : size), page_info: z.unknown().optional() }).safeParse(await this.request('catalog/video/get', { bc_id: scope.bc_id, catalog_id: scope.catalog_id, ...(ids ? { catalog_video_ids: ids } : { page, page_size: size }) }));
    if (!result.success) throw invalid();
    const pageInfo = ids || result.data.page_info === undefined ? undefined : z.object({ page: z.number().int().positive().safe(), page_size: z.number().int().positive().max(50), total_page: count.optional(), total_number: count.optional() }).safeParse(result.data.page_info);
    if (pageInfo && !pageInfo.success) throw invalid();
    const rows = result.data.videos, info = pageInfo?.data;
    if (new Set(rows.map(row => row.catalog_video_id)).size !== rows.length || rows.some(row => ids && !ids.includes(row.catalog_video_id) || row.catalog_id !== undefined && row.catalog_id !== scope.catalog_id || row.bc_id !== undefined && row.bc_id !== scope.bc_id) || !ids && info && (info.page !== page || info.page_size !== size)) throw invalid();
    return { rows, page_info: info, complete: ids ? true : nativeListComplete(info, rows.length) };
  }
  async list(value: unknown) {
    const input = catalogVideoList.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id }), parent = await this.parent(scope), result = await this.native(scope, input.catalog_video_ids, input.page, input.page_size);
    const videos = result.rows.map(row => ({ catalog_video_id: row.catalog_video_id, video_name: row.video_name, sku_id_list: row.sku_id_list, status: row.status, active_status: row.active_status, video_id: row.video_id, create_time: row.create_time,
      ...displayMetadata(row), source: sourceInfo(row.video_link), landing_page: sourceInfo(typeof row.landing_page_url === 'string' ? row.landing_page_url : undefined),
      metadata_truncated_fields: metadataKeys.filter(key => key !== 'landing_page_url' && typeof row[key] === 'string' && row[key].length > 1000),
      ...(row.video_signature && /^[a-f0-9]{32}$/i.test(row.video_signature) ? { video_signature: row.video_signature } : {}), preview_url: row.status === 'SUCCESS' ? safeUrl(row.preview_url) : undefined, configuration_hash: configurationHash(scope, row) }));
    const creatives: Creative[] = videos.map(row => ({ id: row.catalog_video_id, provider: 'tiktok', account_id: input.account_id, type: 'catalog_video', name: row.video_name, status: row.status + (row.active_status ? ` · ${row.active_status}` : ''), headlines: [], descriptions: typeof row.description === 'string' ? [row.description] : [], landing_urls: [],
      media: row.preview_url ? [{ type: 'video', url: row.preview_url, open_url: row.preview_url, alt: row.video_name }] : [],
      actions: parent.can_write ? [{ label: 'Remove from catalog', tool: 'tiktok_delete_catalog_video', arguments: { ...scope, catalog_video_id: row.catalog_video_id, expected_configuration_hash: row.configuration_hash, acknowledge_shared_effects: true }, fields: [] }] : [],
    }));
    return { videos, creatives, complete: result.complete, truncated: result.complete !== true, ...(result.complete === false && Number.isSafeInteger(input.page + 1) ? { next_page: input.page + 1 } : {}), ...(result.page_info && !input.catalog_video_ids ? { page_info: result.page_info } : {}),
      ...(input.catalog_video_ids ? { missing_ids: input.catalog_video_ids.filter(id => !videos.some(row => row.catalog_video_id === id)) } : {}),
      notes: ['Filtered video IDs ignore pagination and return a complete filtered view, not a complete catalog inventory.', 'Extraction status and activation status are separate. Native preview links last six hours; refresh to renew them.', 'Text metadata is clipped at 1,000 characters with explicit field flags; configuration hashes bind full native values.', 'Deleting a catalog video can affect catalog ads; copies already synced to advertiser libraries are not removed.', ...(parent.catalog_conf.is_multi_country === undefined ? ['The catalog did not report its multi-country flag; native endpoint eligibility remains authoritative.'] : []), ...(result.complete === null ? ['Native pagination is absent or contradictory; completeness is unknown.'] : [])],
    };
  }
  async log(value: unknown) {
    const input = catalogVideoLog.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id });await this.parent(scope);
    const issue = z.object({ field: z.string().max(256 * 1024).optional(), affected_video_count: count });
    const result = z.object({ video_feed_log: z.object({ catalog_id: nativeId, bc_id: nativeId.optional(), feed_log_id: nativeId.optional(), feed_id: nativeId.optional(), add_count: count.optional(), update_count: count.optional(), delete_count: count.optional(), error_count: count.optional(), warn_count: count.optional(), process_status: z.enum(['PROCESSING', 'SUCCESS', 'FAILED', 'WAITING']), start_time: time.optional(), end_time: time.optional() }),
      feed_log_data: z.object({ error_affected_videos: z.array(issue).max(1000).nullable().optional(), warn_affected_videos: z.array(issue).max(1000).nullable().optional() }).nullable().optional(),
    }).safeParse(await this.request('catalog/video/log', { bc_id: input.bc_id, catalog_id: input.catalog_id, feed_log_id: input.feed_log_id, language: 'en' }));
    if (!result.success) throw invalid();const row = result.data.video_feed_log;
    if (row.catalog_id !== input.catalog_id || row.bc_id !== undefined && row.bc_id !== input.bc_id || row.feed_log_id !== undefined && row.feed_log_id !== input.feed_log_id) throw invalid();
    const summarize = (rows: z.infer<typeof issue>[]) => rows.slice(0, 50).map(row => ({ field: row.field && row.field.length <= 128 && /^[a-zA-Z0-9_.\[\]-]+$/.test(row.field) ? row.field : 'Unrecognized field', affected_video_count: row.affected_video_count }));
    const diagnostics = result.data.feed_log_data, log = { ...row, feed_log_id: input.feed_log_id, ...(diagnostics?.error_affected_videos ? { error_fields: summarize(diagnostics.error_affected_videos) } : {}), ...(diagnostics?.warn_affected_videos ? { warning_fields: summarize(diagnostics.warn_affected_videos) } : {}), diagnostic_fields_truncated: (diagnostics?.error_affected_videos?.length ?? 0) > 50 || (diagnostics?.warn_affected_videos?.length ?? 0) > 50 };
    return { log, records: [{ id: input.feed_log_id, name: 'Catalog video import', status: row.process_status, added: row.add_count, removed: row.delete_count, errors: row.error_count, warnings: row.warn_count }], processing_complete: ['SUCCESS', 'FAILED'].includes(row.process_status), has_item_errors: row.error_count === undefined ? null : row.error_count > 0, complete: true, truncated: false,
      notes: ['These are native task states/counts. Missing counts remain unavailable. Processing completion does not establish extraction, ad eligibility or advertiser-library sync.', 'Diagnostic field counts are bounded. Original video links, downloads, free-form errors and sample rows are omitted.'],
    };
  }
  private async source(scope: Selection, mediaId: string, sha: string, write = false) {
    const parent = await this.parent(scope, write), media = this.media;
    if (!media) throw new AdportError('NOT_CONNECTED', 'Catalog-video imports require a CSV staged through Adport agent, widget, dashboard or cloud CLI media tools.');
    let raw;
    try { raw = await media.read({ media_id: mediaId, expected_sha256: sha }, { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: ['text/csv'] }); } catch { throw new AdportError('INVALID_INPUT', 'Catalog-video CSV bytes/checksum could not be verified. Refresh the immutable media reference.'); }
    const file = verifyMedia(raw.bytes, raw.name, sha, { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: ['text/csv'] }), rows = csvRows(file.bytes, { maxRows: 5001, maxColumns: columns.length }), first = rows.next();
    if (first.done || new Set(first.value).size !== first.value.length || first.value.some(key => !columns.includes(key)) || columns.slice(0, 3).some(key => !first.value.includes(key))) throw new AdportError('INVALID_INPUT', 'Use the documented catalog-video CSV headers: video_name, video_link, sku_id_list and optional native metadata columns.');
    const previews: Row[] = [], allSkus = new Set<string>();let rowCount = 0;
    for (const fields of rows) {
      const row = Object.fromEntries(first.value.map((key, i) => [key, fields[i]!]));
      if (!row.video_name?.trim() || row.video_name.length > 500 || !safeUrl(row.video_link, false) || row.landing_page_url && !safeUrl(row.landing_page_url, false) || ['category', 'brand', 'creator', 'video_type', 'description'].some(key => (row[key]?.length ?? 0) > 500)) throw new AdportError('INVALID_INPUT', 'Each catalog-video row needs a nonempty name up to 500 characters and a valid HTTP(S) video URL. Optional metadata up to 500 characters; native would null longer values.');
      const skus = row.sku_id_list!.split(',');
      if (!skus.length || skus.length > 20 || skus.some(sku => !sku || sku !== sku.trim() || sku.length > 100 || /[\u0000-\u001f\u007f]/.test(sku)) || new Set(skus).size !== skus.length) throw new AdportError('INVALID_INPUT', 'Each video needs 1–20 distinct exact SKU IDs, comma-separated without surrounding whitespace. Quote the CSV field when it contains commas.');
      for (const sku of skus) allSkus.add(sku);
      if (allSkus.size > 5000) throw new AdportError('INVALID_INPUT', 'Adport verifies at most 5,000 distinct SKU associations per import. Use smaller CSV batches.');
      if (previews.length < 20) previews.push({ row: rowCount + 2, name: row.video_name, sku_ids: skus, source: sourceInfo(row.video_link) });rowCount++;
    }
    if (!rowCount) throw new AdportError('INVALID_INPUT', 'The catalog-video CSV needs at least one data row.');
    const skuIds = [...allSkus].sort(), found = new Map<string, { sku_id: string; product_id: string; ad_creation_eligible: string }>();
    for (let start = 0; start < skuIds.length; start += 1000) {
      const selected = skuIds.slice(start, start + 1000);
      for (let page = 1; page <= 2; page++) {
        const result = z.object({ list: z.array(z.object({ sku_id: z.string().min(1).max(100), product_id: nativeId, ad_creation_eligible: z.string(), catalog_id: nativeId.optional(), bc_id: nativeId.optional() })).max(500), page_info: z.object({ page: z.number().int().positive(), page_size: z.number().int().positive(), total_page: count.optional(), total_number: count.optional() }).optional() }).safeParse(await this.request('catalog/product/get', { bc_id: scope.bc_id, catalog_id: scope.catalog_id, sku_ids: selected, page, page_size: 500 }));
        if (!result.success || result.data.page_info && (result.data.page_info.page !== page || result.data.page_info.page_size !== 500)) throw invalid();
        for (const row of result.data.list) {
          if (!selected.includes(row.sku_id) || found.has(row.sku_id) || row.catalog_id !== undefined && row.catalog_id !== scope.catalog_id || row.bc_id !== undefined && row.bc_id !== scope.bc_id) throw invalid();
          if (row.ad_creation_eligible !== 'AVAILABLE') throw new AdportError('INVALID_INPUT', 'Every associated SKU must be natively AVAILABLE for ad creation. No import was submitted.');
          found.set(row.sku_id, { sku_id: row.sku_id, product_id: row.product_id, ad_creation_eligible: row.ad_creation_eligible });
        }
        if (selected.every(sku => found.has(sku))) break;
        if (!result.data.list.length || !result.data.page_info || result.data.page_info.total_page === undefined || page >= result.data.page_info.total_page) break;
      }
      if (!selected.every(sku => found.has(sku))) throw new AdportError('INVALID_INPUT', 'Not every selected SKU association could be verified in the catalog. No import was submitted.');
    }
    const associations = [...found.values()].sort((a, b) => a.sku_id.localeCompare(b.sku_id));
    return { parent, file, rowCount, skuCount: skuIds.length, previews, associations_hash: digest({ ...scope, sha256: file.sha256, associations }) };
  }
  async importContext(value: unknown) {
    const input = catalogVideoImportContext.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id }), current = await this.source(scope, input.media_id, input.expected_sha256);
    return { expected_catalog_hash: current.parent.configuration_hash, expected_associations_hash: current.associations_hash, source_media_id: input.media_id, source_sha256: input.expected_sha256, video_rows: current.rowCount, unique_skus: current.skuCount, records: current.previews, complete: true, truncated: current.rowCount > current.previews.length,
      notes: ['Every referenced SKU was found and natively AVAILABLE for ad creation. This is not media ingestion or full catalog verification.', 'Only 20 safe row summaries are displayed. Original video URLs stay private; uploaded CSV bytes are not changed.', 'The CSV parameter structure follows the current official field table. Native media accessibility, dimensions, duration, bitrate and template eligibility are checked asynchronously.'],
    };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'tiktok') throw new AdportError('INVALID_INPUT', 'TikTok catalog-video provider differs.');
    if (op.tool === 'tiktok_upload_catalog_videos' && op.kind === 'create') {
      const input = catalogVideoUpload.parse(op.payload), scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id }), media = this.media, providerUrl = media?.providerUrl?.bind(media);
      if (!providerUrl) throw new AdportError('NOT_CONNECTED', 'Catalog-video CSV imports require the hosted project media library to create a private download grant.');
      const prepare = async () => {
        const result = await this.source(scope, input.media_id, input.expected_sha256, true);
        if (result.parent.configuration_hash !== input.expected_catalog_hash || result.associations_hash !== input.expected_associations_hash) throw new AdportError('PENDING_MISMATCH', 'Catalog configuration or SKU associations changed. Read import context and request a fresh preview.');return result;
      };
      const initial = await prepare(), notes = ['Local preview only. This adds catalog videos asynchronously and may make them available to existing Video Shopping Ads using the associated products. Ad statuses and budgets are not changed.', 'Only one catalog-video file task can run at a time. Wait for prior tasks; uncertain/failed submissions are never automatically retried.', 'Native video extraction, media eligibility and any advertiser-library sync remain separate from task acceptance.', input.sync_to_selected_account ? `Requests a separate video copy in the selected advertiser ${scope.account_id}. TikTok ignores ineligible accounts; this request does not confirm sync. Catalog deletion does not delete advertiser copies.` : 'No advertiser-library sync is requested.'];
      return { summary: `Upload ${initial.rowCount} catalog videos`, changes: [`+ ${initial.rowCount} video rows and ${initial.skuCount} distinct SKU associations in catalog ${input.catalog_id}.`, `CSV SHA-256 ${input.expected_sha256}; selected advertiser sync requested: ${input.sync_to_selected_account}.`], coercions: [], budgetDeltas: [], notes,
        review: { provider: 'tiktok', accountId: scope.account_id, kind: 'create', title: 'Upload catalog videos', subject: initial.file.name, fields: [{ label: 'Catalog', after: input.catalog_id }, { label: 'Video rows', after: initial.rowCount }, { label: 'Associated SKUs', after: initial.skuCount }, { label: 'Ad-account copy requested', after: input.sync_to_selected_account ? scope.account_id : 'No' }, { label: 'CSV SHA-256', after: input.expected_sha256 }, { label: 'SKU association snapshot', after: input.expected_associations_hash }], notices: notes },
        execute: async () => {
          await prepare();let grant;
          try { grant = await providerUrl({ media_id: input.media_id, expected_sha256: input.expected_sha256 }, { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: ['text/csv'] }); } catch { throw new AdportError('PROVIDER_ERROR', 'Private CSV staging failed. No native catalog-video upload was submitted.'); }
          if (grant.sha256 !== input.expected_sha256 || !safeUrl(grant.url) || !(Date.parse(grant.expires_at) > Date.now() + 10 * 60_000)) throw new AdportError('PROVIDER_ERROR', 'The private CSV grant could not be verified. No catalog-video upload was submitted.');
          let job: string | undefined;
          try {
            const result = z.object({ feed_log_id: nativeId }).parse(await this.client.post('catalog/video/file', { bc_id: input.bc_id, catalog_id: input.catalog_id, file_url: grant.url, ...(input.sync_to_selected_account ? { advertiser_ids: [scope.account_id] } : {}) }));job = result.feed_log_id;
            const actual = await this.log({ ...scope, feed_log_id: job });if (actual.log.process_status === 'FAILED' || (actual.log.error_count ?? 0) > 0) throw new Error('Native task failed or has item errors');return [job];
          } catch (error) { throw failure(error, 'Catalog-video upload failed, has item errors or is unconfirmed. Reconcile the known job or native task history before another preview.', job ? [job] : undefined); }
        } };
    }
    if (op.tool === 'tiktok_delete_catalog_video' && op.kind === 'remove') {
      const input = catalogVideoDelete.parse(op.payload), scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id });
      const prepare = async () => {
        await this.parent(scope, true);const result = await this.native(scope, [input.catalog_video_id]);if (result.rows.length !== 1) throw new AdportError('INVALID_INPUT', 'The exact catalog video could not be verified. Refresh the gallery.');
        const row = result.rows[0]!;if (configurationHash(scope, row) !== input.expected_configuration_hash) throw new AdportError('PENDING_MISMATCH', 'The catalog video changed. Read its configuration and request a fresh preview.');return row;
      };
      const current = await prepare(), notes = ['Local preview only. Removes one catalog video and its product associations; existing catalog ads may be affected.', 'Video copies already synced into advertiser creative libraries are not removed. No global/atomic usage guarantee or restore endpoint is available.'];
      return { summary: `Remove catalog video "${current.video_name}"`, changes: [`- Catalog video ${input.catalog_video_id} and its catalog SKU associations.`, 'Advertiser-library copies may remain.'], coercions: [], budgetDeltas: [], notes,
        review: { provider: 'tiktok', accountId: scope.account_id, kind: 'remove', title: 'Remove from catalog', subject: current.video_name, fields: [{ label: 'Catalog video', after: input.catalog_video_id }, { label: 'Associated SKUs', after: current.sku_id_list ?? 'Not reported' }, { label: 'Extraction', after: current.status }, { label: 'Activation', after: current.active_status ?? 'Not reported' }], notices: notes },
        execute: async () => {
          await prepare();
          try {
            const receipt = await this.client.post<unknown>('catalog/video/delete', { bc_id: input.bc_id, catalog_id: input.catalog_id, catalog_video_ids: [input.catalog_video_id] });
            if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Unexpected native acknowledgement');
            if ((await this.native(scope, [input.catalog_video_id])).rows.length) throw new Error('Video remains visible');return [input.catalog_video_id];
          } catch (error) { throw failure(error, 'Catalog-video removal or filtered-view absence is unconfirmed. Inspect the selected video before any new deletion.', [input.catalog_video_id]); }
        } };
    }
    throw new AdportError('INVALID_INPUT', 'Unsupported TikTok catalog-video operation or kind.');
  }
}
