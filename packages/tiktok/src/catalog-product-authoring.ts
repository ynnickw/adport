import { createHash } from 'node:crypto';
import { AdportError, MAX_PROJECT_MEDIA_BYTES, verifyMedia, type MediaResolver, type WriteOperation, type WritePreview, type ReviewField } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import type { TikTokCatalogFeeds } from './catalog-feeds.js';
import type { TikTokCatalogProducts } from './catalog-products.js';
import { catalogId, catalogInput } from './catalog-schema.js';
import { catalogProductFields } from './catalog-product-contract.js';
import { catalogProductKinds, parseProduct, productShape, productIdentityFields, productDeleteFields, type CatalogProductKind } from './catalog-product-shapes.js';

type Row = Record<string, unknown>;
type Selection = z.infer<typeof catalogInput>;
type Parent = { configuration_hash: string; catalog_type: string };
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const hash = z.string().regex(/^[a-f0-9]{64}$/), kind = z.enum(catalogProductKinds);
const nativeId = z.union([catalogId, z.number().int().positive().safe()]).transform(String);
const nativeIds = z.array(catalogId).min(1).max(5000).refine(values => new Set(values).size === values.length, 'Product IDs must be unique');
const jsonRow = z.record(z.string(), z.json());
const mediaAsset = z.strictObject({ product_index: z.number().int().min(0).max(4999), field: z.enum(['image_url', 'video_url', 'additional_image_urls']), image_index: z.number().int().min(0).max(19).optional(), media_id: z.string().uuid(), expected_sha256: hash }).refine(value => value.field === 'additional_image_urls' ? value.image_index !== undefined : value.image_index === undefined, 'image_index is required only for additional_image_urls');
const mediaAssets = z.array(mediaAsset).max(1000).default([]);
const selected = catalogInput.extend({ feed_id: catalogId }).strict();
const payload = selected.omit({ account_id: true }).extend({ catalog_type: kind, expected_catalog_hash: hash, expected_feed_hash: hash, acknowledge_shared_effects: z.literal(true), acknowledge_async_processing: z.literal(true) });
export const catalogProductSchema = catalogInput.extend({ operation: z.enum(['upload', 'update']).default('upload') }).strict();
export const catalogProductContext = selected.extend({ product_ids: nativeIds }).strict();
export const catalogProductUpsert = payload.extend({ products: z.array(jsonRow).min(1).max(5000), media_assets: mediaAssets, acknowledge_replacement: z.literal(true) }).strict();
export const catalogProductUpdate = payload.extend({ expected_products_hash: hash, updates: z.array(z.strictObject({ product_id: catalogId, fields: jsonRow })).min(1).max(5000), media_assets: mediaAssets }).strict();
export const catalogProductDelete = payload.extend({ expected_products_hash: hash, product_ids: nativeIds, acknowledge_removal: z.literal(true) }).strict();
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const fail = () => new AdportError('PROVIDER_ERROR', 'TikTok returned an unexpected product scope, identifier or selection. No request was retried.');
function bound(value: unknown, input = false) {
  let nodes = 0;
  const walk = (item: unknown, depth: number) => {
    if (++nodes > 200000 || depth > 12 || typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) throw new AdportError(input ? 'INVALID_INPUT' : 'PROVIDER_ERROR', 'Catalog product data exceeds safe structural bounds.');
    if (typeof item === 'object' && item !== null) for (const child of Object.values(item)) walk(child, depth + 1);
  };
  walk(value, 0);
  if (Buffer.byteLength(canonical(value)) > 2 * 1024 * 1024) throw new AdportError(input ? 'INVALID_INPUT' : 'PROVIDER_ERROR', 'Catalog product batch exceeds 2 MiB. Use smaller batches.');
}
function publicValue(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(item => publicValue(item, key));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicValue(item, key)]));
  if (typeof value === 'string' && /url|uri|link/i.test(key)) {
    if (value.startsWith('https://adport.invalid/media/')) { const parts = value.split('/');return { media_id: parts[4], sha256: parts[5] }; }
    try { const url = new URL(value);return { origin: url.origin === 'null' ? url.protocol : url.origin, sha256: digest(value) }; } catch { return { sha256: digest(value) }; }
  }
  return value;
}
const identity = (type: CatalogProductKind, value: Row): Row => Object.fromEntries(productIdentityFields[type].map(key => {
  const direct = value[key], nested = object(value.product_detail)[key];
  if (direct !== undefined && nested !== undefined && direct !== nested) throw fail();
  const id = direct ?? nested;
  if (typeof id !== 'string' || !id.trim() || /[\u0000-\u001f\u007f]/.test(id)) throw new AdportError('INVALID_INPUT', 'A product lacks a safe native external identity for its catalog type.');
  return [key, id];
}));
const operationTools = ['tiktok_upsert_catalog_products', 'tiktok_update_catalog_products', 'tiktok_delete_catalog_products'];
const leaves = (value: Row, prefix = ''): Array<[string, unknown]> => Object.entries(value).flatMap(([key, item]) => {
  const path = prefix ? `${prefix}.${key}` : key;
  return item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length ? leaves(item as Row, path) : [[path, item]];
});
const atPath = (value: Row, path: string) => path.split('.').reduce<unknown>((item, key) => object(item)[key], value);

/** Fixed native product endpoints; every apply is a single asynchronous submission. */
export class TikTokCatalogProductAuthoring {
  constructor(private readonly client: Pick<TikTokClient, 'get' | 'post'>, private readonly authorizeParent: (selection: Selection, write?: boolean) => Promise<Parent>, private readonly feeds: Pick<TikTokCatalogFeeds, 'list'>, private readonly products: Pick<TikTokCatalogProducts, 'log'>, private readonly media?: MediaResolver) {}
  supports(tool: string) { return operationTools.includes(tool); }
  private async request(path: string, args: Row) {
    try { return await this.client.get(path, args, { jsonContentType: true }); }
    catch { throw new AdportError('PROVIDER_ERROR', 'TikTok product configuration read failed. Verify native permissions and the selected catalog. Provider bodies and source URLs stay hidden; no request was retried.'); }
  }
  private async feed(scope: z.infer<typeof selected>) {
    const result = await this.feeds.list({ account_id: scope.account_id, bc_id: scope.bc_id, catalog_id: scope.catalog_id, feed_id: scope.feed_id });
    if (result.feeds.length !== 1 || result.feeds[0]!.feed_id !== scope.feed_id) throw fail();
    return result.feeds[0]!;
  }
  async schema(value: unknown) {
    const input = catalogProductSchema.parse(value), { operation, ...scope } = input, parent = await this.authorizeParent(scope), type = kind.parse(parent.catalog_type);
    return { catalog_type: type, operation, schema: z.toJSONSchema(productShape(type, operation === 'update')), identity_fields: productIdentityFields[type], native_batch_limit: 5000, adport_batch_bytes: 2 * 1024 * 1024,
      media_assets_schema: z.toJSONSchema(mediaAsset), source: `https://business-api.tiktok.com/portal/docs?id=${operation === 'upload' ? '1740497429681153' : '1740562287852546'}`,
      notes: ['Structural schema from the official parameter tables; native eligibility, conditional requirements and semantic validation remain authoritative.', operation === 'update' ? 'Update fields are a partial object. External identity is supplied from verified product context, not editable fields. Nested update semantics remain native.' : 'Upload is an incremental upsert and may replace existing products with the same external identity.', 'For flights the native identity is the origin/destination airport pair; flight_id is generated by TikTok.'],
    };
  }
  private async mediaProducts(rows: Row[], assets: Array<z.infer<typeof mediaAsset>>, mint = false): Promise<Row[]> {
    const result = structuredClone(rows), targets = new Set<string>(), resolved = new Map<string, string>();
    if (assets.length && !this.media?.providerUrl) throw new AdportError('INVALID_INPUT', 'Project media URL staging is required for catalog media references. Upload the files through Adport media tools first.');
    for (const asset of assets) {
      const row = result[asset.product_index], key = `${asset.product_index}:${asset.field}:${asset.image_index ?? ''}`;
      if (!row || targets.has(key)) throw new AdportError('INVALID_INPUT', 'Media references require distinct fields on existing product indexes.');targets.add(key);
      if (Object.hasOwn(rows[asset.product_index]!, asset.field)) throw new AdportError('INVALID_INPUT', 'Choose native source URLs or project media references for a field, not both.');
      const options = { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: asset.field === 'video_url' ? ['video/mp4', 'video/quicktime', 'video/webm'] : ['image/png', 'image/jpeg'] };
      const source = { media_id: asset.media_id, expected_sha256: asset.expected_sha256 }, cacheKey = `${asset.media_id}:${asset.expected_sha256}:${options.contentTypes.join(',')}`;
      let url = resolved.get(cacheKey);
      if (!url) {
        let file;
        try { file = await this.media!.read(source, options); } catch { throw new AdportError('INVALID_INPUT', 'Adport media bytes/checksum verification failed. Refresh the immutable media reference before previewing.'); }
        verifyMedia(file.bytes, file.name, asset.expected_sha256, { ...options, contentType: file.contentType });
        url = `https://adport.invalid/media/${asset.media_id}/${asset.expected_sha256}`;
        if (mint) {
          let grant;
          try { grant = await this.media!.providerUrl!(source, options); } catch { throw new AdportError('PROVIDER_ERROR', 'Adport media download staging was not confirmed. No native product request was sent.'); }
          let destination: URL;
          try { destination = new URL(grant.url); } catch { throw new AdportError('PROVIDER_ERROR', 'Project media staging returned an invalid download grant.'); }
          if (destination.protocol !== 'https:' || destination.username || destination.password || grant.sha256 !== asset.expected_sha256 || !(Date.parse(grant.expires_at) > Date.now() + 10 * 60_000)) throw new AdportError('PROVIDER_ERROR', 'Project media staging returned an unverified or short-lived download grant.');
          url = grant.url;
        }
        resolved.set(cacheKey, url);
      }
      if (asset.field === 'additional_image_urls') {
        const array = (row.additional_image_urls ??= []) as string[];array[asset.image_index!] = url;
      } else row[asset.field] = url;
    }
    for (const row of result) if (Array.isArray(row.additional_image_urls) && Array.from(row.additional_image_urls).some(value => typeof value !== 'string')) throw new AdportError('INVALID_INPUT', 'Additional media image indexes must be contiguous starting at zero.');
    return result;
  }
  private async readSet(scope: Selection, type: CatalogProductKind, ids: string[], feedId: string) {
    const rows: Row[] = [], seen = new Set<string>();
    for (let start = 0; start < ids.length; start += 1000) {
      const chunk = ids.slice(start, start + 1000), wanted = new Set(chunk);
      for (let page = 1; page <= 10; page++) {
        const result = z.object({ list: z.array(z.record(z.string(), z.unknown())).max(100), page_info: z.object({ page: z.number().int().positive(), page_size: z.number().int().positive(), total_number: z.number().int().nonnegative().safe().optional(), total_page: z.number().int().nonnegative().safe().optional() }).optional() }).safeParse(await this.request('catalog/product/get', { bc_id: scope.bc_id, catalog_id: scope.catalog_id, product_ids: chunk, page, page_size: 100 }));
        if (!result.success || result.data.page_info && (result.data.page_info.page !== page || result.data.page_info.page_size !== 100 || (result.data.page_info.total_number ?? 0) > chunk.length)) throw fail();
        for (const row of result.data.list) {
          bound(row);const parsed = nativeId.safeParse(row.product_id);
          if (!parsed.success || !wanted.has(parsed.data) || seen.has(parsed.data) || row.catalog_id !== undefined && nativeId.parse(row.catalog_id) !== scope.catalog_id || row.bc_id !== undefined && nativeId.parse(row.bc_id) !== scope.bc_id || row.feed_id !== undefined && nativeId.parse(row.feed_id) !== feedId) throw fail();
          const keys = new Set([...catalogProductFields[type].map(field => field.path.split('.')[0]!), ...productIdentityFields[type], 'flight_id', 'feed_id']);
          const config = Object.fromEntries(Object.entries(row).filter(([key]) => keys.has(key)));
          rows.push({ ...config, product_id: parsed.data });seen.add(parsed.data);
        }
        if (chunk.every(id => seen.has(id))) {
          if (result.data.page_info && ((result.data.page_info.total_number ?? chunk.length) !== chunk.length || (result.data.page_info.total_page ?? page) > page)) throw fail();
          break;
        }
        const info = result.data.page_info;
        if (!result.data.list.length || !info || info.total_page === undefined || page >= info.total_page) break;
      }
      if (!chunk.every(id => seen.has(id))) throw new AdportError('INVALID_INPUT', 'Not every selected native product ID could be verified. Refresh the selection before previewing.');
    }
    rows.sort((a, b) => String(a.product_id).localeCompare(String(b.product_id)));bound(rows);
    return rows;
  }
  async context(value: unknown) {
    const input = catalogProductContext.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id });
    const parent = await this.authorizeParent(scope), type = kind.parse(parent.catalog_type), feed = await this.feed(input), rows = await this.readSet(scope, type, input.product_ids, input.feed_id);
    return { catalog_type: type, expected_catalog_hash: parent.configuration_hash, expected_feed_hash: feed.configuration_hash, products_hash: digest({ ...scope, feed_id: input.feed_id, type, rows }),
      products: rows.map(row => ({ ...publicValue(row) as Row, external_identity: identity(type, row) })), records: rows.map(row => ({ id: String(row.product_id), name: String(row.title ?? row.name ?? row.series_name ?? row.destination_name ?? row.product_id), external_identity: identity(type, row) })), selection_complete: true, truncated: false,
      notes: ['Exact native product IDs verified in this catalog. This is not a complete catalog inventory.', 'Source URLs are represented by origin/fingerprint; native omitted fields remain unavailable. Volatile audit/delivery fields are excluded from the snapshot.', 'Product feed membership is checked by TikTok when processing the submission; a selected feed is not proof that every product belongs to it.'],
    };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'tiktok' || !this.supports(op.tool)) throw new AdportError('INVALID_INPUT', 'Unsupported TikTok product operation.');
    const upload = op.tool === 'tiktok_upsert_catalog_products', remove = op.tool === 'tiktok_delete_catalog_products';
    if (op.kind !== (remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'TikTok product operation kind differs.');
    bound(op.payload, true);
    const input = upload ? catalogProductUpsert.parse(op.payload) : remove ? catalogProductDelete.parse(op.payload) : catalogProductUpdate.parse(op.payload);
    const scope = { account_id: catalogId.parse(op.accountId), bc_id: input.bc_id, catalog_id: input.catalog_id };
    const parent = await this.authorizeParent(scope, true), type = kind.parse(parent.catalog_type), selectedFeed = { ...scope, feed_id: input.feed_id }, feed = await this.feed(selectedFeed);
    if (type !== input.catalog_type || parent.configuration_hash !== input.expected_catalog_hash || feed.configuration_hash !== input.expected_feed_hash) throw new AdportError('PENDING_MISMATCH', 'Catalog type/configuration or feed changed. Read it and request a fresh preview.');
    const updates = 'updates' in input ? input.updates : [], ids = 'product_ids' in input ? input.product_ids : updates.map(item => item.product_id);
    if (new Set(ids).size !== ids.length) throw new AdportError('INVALID_INPUT', 'Product update IDs must be unique.');
    const current = upload ? [] : await this.readSet(scope, type, ids, input.feed_id);
    if ('expected_products_hash' in input && digest({ ...scope, feed_id: input.feed_id, type, rows: current }) !== input.expected_products_hash) throw new AdportError('PENDING_MISMATCH', 'Selected products changed. Read product context and request a fresh preview.');
    let products: Row[] = [], selector: string | undefined;
    const assets = 'media_assets' in input ? input.media_assets : [];
    if ('products' in input) {
      products = (await this.mediaProducts(input.products, assets)).map(row => parseProduct(type, row));
      const keys = products.map(row => canonical(identity(type, row)));
      if (new Set(keys).size !== keys.length) throw new AdportError('INVALID_INPUT', 'Product external identities must be unique.');
    } else if (!remove) {
      const patched = await this.mediaProducts(updates.map(update => update.fields), assets);
      products = updates.map((update, index) => {
        const row = current.find(row => row.product_id === update.product_id)!;
        if (!Object.keys(patched[index]!).length || productIdentityFields[type].some(key => Object.hasOwn(update.fields, key))) throw new AdportError('INVALID_INPUT', 'Supply editable product fields; external identities cannot be changed.');
        return { ...parseProduct(type, patched[index]!, true), ...identity(type, row) };
      });
    } else {
      selector = productDeleteFields[type];
      if (!selector) throw new AdportError('INVALID_INPUT', 'The official product-delete contract does not document an Entertainment selector. No deletion request was sent.');
      const max = ['GENERIC', 'ONLINE_TO_OFFLINE'].includes(type) ? 10000 : 1000;
      if (ids.length > max) throw new AdportError('INVALID_INPUT', `This native catalog deletion permits at most ${max} products. Use smaller batches.`);
    }
    const externalIds = remove ? current.map(row => type === 'FLIGHT' ? row.flight_id : Object.values(identity(type, row))[0]) : [];
    if (externalIds.some(id => typeof id !== 'string' || !id.length) || new Set(externalIds).size !== externalIds.length) throw new AdportError('INVALID_INPUT', 'Deletion requires unique verified external product IDs.');
    const body = { bc_id: input.bc_id, catalog_id: input.catalog_id, feed_id: input.feed_id, ...(remove ? { [selector!]: externalIds } : { products }) };
    bound(body, true);
    const title = remove ? 'Remove catalog products' : upload ? 'Upload catalog products' : 'Edit catalog products', count = remove ? ids.length : products.length;
    const reviewFields: ReviewField[] = [{ label: 'Catalog type', after: type }, { label: 'Feed', after: input.feed_id }, { label: 'Products', after: count }, { label: 'Payload SHA-256', after: digest(body) }];
    let reviewTruncated = count > 20;
    for (let index = 0; index < Math.min(count, 20); index++) {
      const source = upload ? undefined : current.find(row => row.product_id === ids[index]), proposed = products[index];
      if (remove) reviewFields.push({ label: 'Remove product', after: { product_id: source!.product_id, external_identity: identity(type, source!) } });
      else {
        const subject = Object.values(identity(type, proposed!)).join(' → '), fields = leaves(proposed!).filter(([path]) => !productIdentityFields[type].includes(path));
        for (const [path, value] of fields) {
          if (reviewFields.length >= 44) { reviewTruncated = true;break; }
          const before = source ? atPath(source, path) : undefined;
          reviewFields.push({ label: `${subject} · ${path.replaceAll('_', ' ')}`, ...(source ? { before: before === undefined ? 'Not reported' : publicValue(before, path) } : {}), after: publicValue(value, path) });
        }
      }
    }
    if (assets.length) reviewFields.push({ label: 'Adport media', after: assets });
    const notes = ['Local preview only. TikTok validates native permissions, product fields and feed membership during asynchronous processing.', 'Shared catalog changes can change existing ads wherever products or product sets are used; no ad status or budget is changed.', 'Acceptance is not completed processing, product audit approval or ad eligibility. Inspect the exact native job, then read product context.', 'TikTok permits one active product operation per catalog. Wait for prior jobs; busy/uncertain submissions are never automatically retried.', ...(assets.length ? ['Media bytes/checksums are verified at preview and apply. Private download grants are minted only at apply; the payload hash binds logical media references, not an expiring URL.', 'Images require at least 500×500 pixels. Native media fetching/audit and any ongoing URL refetch behavior remain unverified; grants expire.'] : []), ...(upload ? ['Incremental upsert: uploading an existing external identity may replace its product data. Existing configuration was not inspected by this upsert preview.'] : remove ? ['Removal cannot be undone through this operation; historical reporting may remain.'] : ['Only supplied top-level fields are sent. Nested-object merge behavior remains native; no unverified preservation is promised.']), ...(reviewTruncated ? [`Review is limited to 20 products and 40 editable fields from ${count} products; the full submitted payload is bound by its SHA-256 and identical-argument approval.`] : [])];
    return { summary: `${title} · ${count} ${type}`, changes: [`${remove ? '-' : '~'} ${count} selected ${type} products in catalog ${input.catalog_id}, feed ${input.feed_id}.`, `Approved native payload SHA-256 ${digest(body)}.`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: scope.account_id, kind: op.kind, title, subject: `${count} products`, fields: reviewFields, notices: notes }, execute: async () => {
        await this.authorizeParent(scope, true);
        let nativeBody = body;
        if (assets.length) {
          const sourceRows = 'products' in input ? input.products : updates.map(update => update.fields), resolved = await this.mediaProducts(sourceRows, assets, true);
          nativeBody = { ...body, products: resolved.map((row, index) => upload ? parseProduct(type, row) : { ...parseProduct(type, row, true), ...identity(type, current.find(value => value.product_id === ids[index])!) }) };
          bound(nativeBody, true);
        }
        let result: unknown;
        try { result = await this.client.post(`catalog/product/${remove ? 'delete' : upload ? 'upload' : 'update'}`, nativeBody); }
        catch { throw new AdportError('PROVIDER_ERROR', 'TikTok product submission was not confirmed. Inspect native jobs before another preview; no request was retried.'); }
        const parsed = z.object({ feed_log_id: nativeId }).safeParse(result);
        if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'TikTok did not return a safe product task ID. Inspect native jobs before retrying; no request was replayed.');
        const job = parsed.data.feed_log_id;
        try {
          const result = await this.products.log({ ...selectedFeed, feed_log_id: job });
          if (result.log.process_status === 'FAILED' || (result.log.error_count ?? 0) > 0) throw new Error('Native job failed or has item errors');
        } catch { throw new AdportError('PROVIDER_ERROR', 'Product task was accepted but processing or exact feed/catalog readback is unconfirmed. Reconcile this ID; do not replay the mutation.', { resourceIds: [job], feed_log_id: job, feed_id: input.feed_id, catalog_id: input.catalog_id }); }
        return [job];
      } };
  }
}
