import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AdportError, MAX_PROJECT_MEDIA_BYTES, verifyMedia, type Creative, type MediaResolver, type WriteOperation, type WritePreview } from '@adport/core';
import type { PinterestAdsClient } from './client.js';
import type { PinterestCatalogService } from './catalogs.js';
import { catalogType, groupHash } from './product-group-schemas.js';
import { itemUpdateMask } from './catalog-item-attributes.js';
import { attributeSchema, batchReference, itemBatchApply, itemContext, itemCopy, itemIdField, itemIdsField, itemNamedApply, itemOperation, itemRead, itemRequest, itemSelection, itemWriteOperations, sourceId } from './catalog-item-schemas.js';

type Row = Record<string, unknown>;
type Selection = z.infer<typeof itemSelection>;
type Request = z.infer<typeof itemRequest>;
type Kind = z.infer<typeof catalogType>;
type Current = { id: string; state: 'PRESENT' | 'NATIVE_ITEM_ERROR' | 'NOT_RETURNED'; attributes?: Row; pins?: unknown[] | null; diagnostics: unknown; diagnostic_hash?: string };
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]>; resultDetails?(): unknown; resultWarnings?(): string[] };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const batchId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const diagnostic = z.object({ code: z.number().int().safe().optional(), attribute: z.string().max(256).optional(), message: z.string().max(100_000).optional() });
const diagnostics = (value: unknown) => z.array(diagnostic).max(10_000).parse(value ?? []).map(({ message, ...row }) => ({ ...row, message_present: !!message }));
const nativeBatch = z.object({ catalog_type: catalogType, batch_id: batchId.optional(), created_time: z.string().max(100).nullable().optional(), completed_time: z.string().max(100).nullable().optional(), status: z.enum(['PROCESSING', 'COMPLETED', 'FAILED']).optional(), items: z.array(z.record(z.string(), z.json())).max(1000).optional() });
const manifestRow = z.object({ source_id: sourceId, operation: itemOperation, desired_keys: z.array(z.string()).max(108), clear_keys: z.array(z.string()).max(100), desired_hash: groupHash.optional(), preserved_hash: groupHash.optional() }).strict();
const receiptSchema = itemSelection.extend({ version: z.literal('pinterest_items_v1'), scope_id: z.string().min(1).max(200), catalog_type: catalogType, owner_context_hash: groupHash, batch_id: batchId, expires_at: z.number().int().safe(), manifest: z.array(manifestRow).min(1).max(1000), media_expires_at: z.string().max(100).optional() }).strict();
const notes = ['Catalog item changes can publish product Pins and affect groups or ads using these items. DELETE removes the item across all data sources; UPSERT supplies the full replacement attributes. No ad is activated and no budget or bid is changed.', 'The preview is local. Batch submission, per-item processing, independent configuration readback and Pin/ad readiness are separate states. Missing item responses and native item errors never establish absence.', 'Native updates are not atomic conditional writes. No native mutation is automatically replayed after partial, failed or uncertain outcomes. Retain the signed batch receipt for scoped status and reconciliation.'];
const failure = (error: unknown, ids: string[] = [], extra: Row = {}) => { const data = error instanceof AdportError ? object(error.details) : {};return new AdportError('PROVIDER_ERROR', 'Pinterest catalog item operation is unconfirmed. No write was retried; reconcile known batch IDs before another preview. Native bodies and private media URLs are hidden.', { ...(ids.length ? { resource_ids: ids } : {}), ...(typeof data.http_status === 'number' ? { http_status: data.http_status } : {}), ...extra }); };
function bounded(value: unknown) { if (Buffer.byteLength(canonical(value)) > 2 * 1024 * 1024) throw new AdportError('INVALID_INPUT', 'Catalog batch exceeds the 2 MiB Adport bound; use smaller batches.'); }
function publicValue(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(item => publicValue(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, publicValue(item, name)]));
  if (typeof value === 'string' && /link|url/i.test(key)) {
    const match = value.match(/^https:\/\/adport\.invalid\/media\/([a-f0-9-]+)\/([a-f0-9]+)$/);if (match) return { media_id: match[1], sha256: match[2] };
    try { const url = new URL(value);return { origin: url.origin, fingerprint: hash(value) }; } catch { return { fingerprint: hash(value) }; }
  }
  return value;
}
function normalized(type: Kind, values: Row) { return { ...values, ...(type === 'RETAIL' && typeof values.image_link === 'string' ? { image_link: [values.image_link] } : {}) }; }
function wantedValues(type: Kind, attrs: Row, keys: string[], clears: string[]) { return normalized(type, Object.fromEntries(keys.map(key => [key, clears.includes(key) ? null : attrs[key] ?? null]))); }
function preserved(attrs: Row, keys: string[]) { return Object.fromEntries(Object.entries(attrs).filter(([key]) => !keys.includes(key) && key !== 'last_updated_time')); }
const safeMediaUrl = (value: string) => { try { const url = new URL(value);return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch { return false; } };

/** Native vertical item batches, Pinterest OpenAPI 5.28.0 at 51aca009. */
export class PinterestCatalogItems {
  constructor(private readonly client: PinterestAdsClient, private readonly catalogs: PinterestCatalogService, private readonly media: MediaResolver) {}
  supports(tool: string) { return tool === 'pinterest_apply_catalog_items_batch' || tool === 'pinterest_update_catalog_item_copy' || Object.hasOwn(itemWriteOperations, tool); }
  private scopeId() { const value = (this.media as { scopeId?: unknown }).scopeId;return typeof value === 'string' && value ? value : 'local'; }
  private params(account: string) { return new URLSearchParams({ ad_account_id: account }); }
  private snapshot(selection: Selection, type: Kind, owner: string, row: Current) { return hash({ selection, catalog_type: type, owner, id: row.id, state: row.state, attributes: row.attributes, diagnostic_hash: row.diagnostic_hash }); }
  private async selected(selection: Selection) { const result = await this.catalogs.getCatalog(selection.account_id, selection.catalog_id);return { catalog: result.catalog, owner: result.context_hash }; }
  private async readSet(selection: Selection, type: Kind, ids: string[]): Promise<Current[]> {
    const result = await this.client.mutate('catalogs/items', 'POST', { country: selection.country, language: selection.language, filters: { catalog_id: selection.catalog_id, catalog_type: type, [itemIdsField[type]]: ids } }, z.object({ items: z.array(z.record(z.string(), z.json())).max(1000) }), this.params(selection.account_id)).catch(error => { throw failure(error); });
    const found = new Map<string, Current>();
    for (const raw of result.items) {
      const id = sourceId.parse(raw[itemIdField[type]]), errors = diagnostics(raw.errors), kind = raw.item_response_kind, family = type === 'RETAIL' ? 'retail' : type === 'HOTEL' ? 'hotel' : 'creative_assets';
      if (!ids.includes(id) || found.has(id) || raw.catalog_type !== type || raw.catalog_id !== undefined && raw.catalog_id !== selection.catalog_id || kind !== undefined && ![family + '_item', family + '_item_error'].includes(String(kind)) || errors.length && raw.attributes !== undefined || kind === family + '_item_error' && raw.attributes !== undefined) throw failure(undefined);
      const attrs = raw.attributes === undefined ? undefined : z.record(z.string(), z.json()).parse(raw.attributes), state = attrs ? 'PRESENT' : 'NATIVE_ITEM_ERROR';
      found.set(id, { id, state, attributes: attrs, pins: raw.pins === null ? null : raw.pins === undefined ? undefined : z.array(z.unknown()).max(11).parse(raw.pins), diagnostics: errors, diagnostic_hash: errors.length ? hash(raw.errors) : undefined });
    }
    return ids.map(id => found.get(id) ?? { id, state: 'NOT_RETURNED', diagnostics: [] });
  }
  private previewMedia(pins: unknown[] | null | undefined): Creative['media'] {
    const result: Creative['media'] = [];
    for (const pin of pins ?? []) for (const image of Object.values(object(object(object(pin).media).images))) {
      const url = object(image).url;if (typeof url !== 'string') continue;let parsed: URL;try { parsed = new URL(url); } catch { continue; }
      if (safeMediaUrl(url) && (parsed.hostname === 'i.pinimg.com' || parsed.hostname.endsWith('.pinimg.com'))) { result.push({ type: 'image', url });break; }
    }
    return result.slice(0, 11);
  }
  async list(value: unknown) {
    const input = itemRead.parse(value), selection = itemSelection.parse(Object.fromEntries(Object.entries(input).filter(([key]) => ['account_id', 'catalog_id', 'country', 'language'].includes(key)))), { catalog, owner } = await this.selected(selection), key = hash({ selection, ids: input.item_ids, limit: input.limit });let offset = 0;
    if (input.cursor) { let navigation;try { navigation = z.object({ selection: groupHash, offset: z.number().int().min(1).max(999) }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); } catch { throw new AdportError('INVALID_INPUT', 'Invalid catalog item cursor.'); }if (navigation.selection !== key || navigation.offset >= input.item_ids.length) throw new AdportError('PENDING_MISMATCH', 'Catalog item selection changed; restart its first page.');offset = navigation.offset; }
    const ids = input.item_ids.slice(offset, offset + input.limit), current = await this.readSet(selection, catalog.catalog_type, ids), records = current.map(row => ({ id: row.id, name: String(row.attributes?.title ?? row.attributes?.name ?? row.id), status: row.state, attributes: publicValue(row.attributes), diagnostics: row.diagnostics, snapshot_hash: this.snapshot(selection, catalog.catalog_type, owner, row) }));
    const creatives: Creative[] = current.map((row, index) => { const title = row.attributes?.title ?? row.attributes?.name, description = row.attributes?.description;return { id: row.id, provider: 'pinterest', account_id: input.account_id, name: records[index]!.name, type: 'CATALOG_' + catalog.catalog_type, status: row.state, headlines: typeof title === 'string' ? [title] : [], descriptions: typeof description === 'string' ? [description] : [], landing_urls: [], media: this.previewMedia(row.pins), actions: row.state === 'PRESENT' ? [{ label: 'Edit copy', tool: 'pinterest_update_catalog_item_copy', arguments: { ...selection, source_id: row.id, expected_snapshot_hash: records[index]!.snapshot_hash, confirm_publication: true, acknowledge_catalog_effects: true }, fields: [{ key: 'title', label: catalog.catalog_type === 'HOTEL' ? 'Name' : 'Title', type: 'text', value: typeof title === 'string' ? title : '' }, { key: 'description', label: 'Description', type: 'text', value: typeof description === 'string' ? description : '' }] }] : [] }; });
    const next = offset + ids.length;return { records, creatives, catalog_type: catalog.catalog_type, truncated: next < input.item_ids.length, ...(next < input.item_ids.length ? { next_cursor: Buffer.from(JSON.stringify({ selection: key, offset: next })).toString('base64url') } : {}), notes: ['This pages only the requested item IDs, not the whole catalog. Missing rows and native item errors do not prove absence. Media-source URLs are fingerprinted; only native Pinterest CDN Pin previews are displayed.'] };
  }
  private async materialize(request: Request, type: Kind, mint: boolean) {
    const rows = structuredClone(request.operations), targets = new Set<string>(), resolved = new Map<string, string>(), sources: Row[] = [];let expires: string | undefined;
    if (request.media_assets.length && !this.media.providerUrl) throw new AdportError('INVALID_INPUT', 'Upload project media first; this runtime has no private provider URL staging.');
    for (const asset of request.media_assets) {
      const row = rows[asset.item_index], key = `${asset.item_index}:${asset.field}:${asset.image_index ?? ''}`;if (!row?.attributes || row.operation === 'DELETE' || targets.has(key)) throw new AdportError('INVALID_INPUT', 'Media references require distinct existing non-delete item slots.');targets.add(key);
      const options = { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: /video/.test(asset.field) ? ['video/mp4'] : ['image/png', 'image/jpeg', 'image/webp'] }, source = { media_id: asset.media_id, expected_sha256: asset.expected_sha256 }, file = await this.media.read(source, options), verified = verifyMedia(file.bytes, file.name, source.expected_sha256, { ...options, contentType: file.contentType });
      const cacheKey = canonical({ source, type: verified.contentType });let url = resolved.get(cacheKey);
      if (!url) {
        url = `https://adport.invalid/media/${asset.media_id}/${asset.expected_sha256}`;
        if (mint) { const grant = await this.media.providerUrl!(source, options);if (!safeMediaUrl(grant.url) || grant.sha256 !== verified.sha256 || !(Date.parse(grant.expires_at) > Date.now() + 10 * 60_000)) throw new AdportError('PROVIDER_ERROR', 'Media staging returned an invalid or short-lived grant.');url = grant.url;if (!expires || Date.parse(grant.expires_at) < Date.parse(expires)) expires = grant.expires_at; }
        resolved.set(cacheKey, url);
      }
      const parts = asset.field.split('.'), attrs = parts.length === 2 ? object(row.attributes[parts[0]!]) : row.attributes, field = parts.at(-1)!;
      if (parts.length === 2) { const parent = row.attributes[parts[0]!];if (parent !== undefined && (!parent || typeof parent !== 'object' || Array.isArray(parent))) throw new AdportError('INVALID_INPUT', 'A nested media reference requires an object field.');row.attributes[parts[0]!] = attrs as typeof row.attributes; }
      const array = field === 'additional_image_link' || field === 'image_link' && type === 'RETAIL';
      if (array) { if (asset.image_index === undefined) throw new AdportError('INVALID_INPUT', 'An array media field requires image_index.');const values = attrs[field] === undefined ? [] : Array.isArray(attrs[field]) ? attrs[field] as unknown[] : [attrs[field]];if (values[asset.image_index] != null) throw new AdportError('INVALID_INPUT', 'A media slot already has a native URL.');values[asset.image_index] = url;attrs[field] = values; }
      else { if (asset.image_index !== undefined || attrs[field] !== undefined) throw new AdportError('INVALID_INPUT', 'Scalar media fields cannot have image_index or an existing URL.');attrs[field] = url; }
      sources.push({ source_id: row.source_id, field: asset.field, image_index: asset.image_index, media_id: asset.media_id, sha256: verified.sha256, name: verified.name, content_type: verified.contentType, byte_length: verified.bytes.length });
    }
    for (const row of rows) {
      if (row.operation === 'DELETE') { if (type !== 'RETAIL' && row.last_updated_time !== undefined) throw new AdportError('INVALID_INPUT', 'Only RETAIL deletion supports last_updated_time.');continue; }
      if (!attributeSchema(type, row.operation).safeParse(row.attributes).success) throw new AdportError('INVALID_INPUT', 'Attributes do not match this native catalog type/operation. Use pinterest_catalog_item_schema; no field is silently dropped.');
      if (row.attributes?.id !== undefined && row.attributes.id !== row.source_id) throw new AdportError('INVALID_INPUT', 'Deprecated attribute id cannot differ from the selected source_id.');
      if (row.clear_fields?.length && (type !== 'RETAIL' || Object.keys(row.attributes!).some(key => !itemUpdateMask.safeParse(key).success))) throw new AdportError('INVALID_INPUT', 'Explicit unsetting is RETAIL-only; all supplied fields must be native update-mask fields when combined with clears.');
    }
    bounded(rows);return { rows, sources, expires };
  }
  private manifest(type: Kind, rows: Request['operations'], before: Current[]) {
    const result = rows.map(row => { const desired_keys = [...new Set([...Object.keys(row.attributes ?? {}), ...(row.clear_fields ?? [])])].sort(), clear_keys = row.clear_fields ?? [], current = before.find(value => value.id === row.source_id)!;return { source_id: row.source_id, operation: row.operation, desired_keys, clear_keys, ...(row.operation !== 'DELETE' ? { desired_hash: hash(wantedValues(type, row.attributes!, desired_keys, clear_keys)) } : {}), ...(row.operation === 'UPDATE' ? { preserved_hash: hash(preserved(normalized(type, current.attributes!), desired_keys)) } : {}) }; });
    if (Buffer.byteLength(canonical(result)) > 1_000_000) throw new AdportError('INVALID_INPUT', 'Batch proof exceeds its bound; split this batch before previewing.');return result;
  }
  async context(value: unknown) {
    const input = itemContext.parse(value), selection = itemSelection.parse(Object.fromEntries(Object.entries(input).filter(([key]) => ['account_id', 'catalog_id', 'country', 'language'].includes(key)))), request = itemRequest.parse(Object.fromEntries(Object.entries(input).filter(([key]) => ['operations', 'media_assets', 'acknowledge_replacement', 'acknowledge_unconfirmed_existing'].includes(key))));bounded(request);
    const { catalog, owner } = await this.selected(selection), current = await this.readSet(selection, catalog.catalog_type, request.operations.map(row => row.source_id));
    for (const row of request.operations) {
      const before = current.find(value => value.id === row.source_id)!;
      if (row.operation === 'CREATE' && before.state === 'PRESENT') throw new AdportError('INVALID_INPUT', 'CREATE cannot overwrite an existing item.');
      if (['UPDATE', 'DELETE'].includes(row.operation) && before.state !== 'PRESENT') throw new AdportError('INVALID_INPUT', 'UPDATE/DELETE require a positively read current item; native item errors cannot establish ownership/configuration.');
      if (row.operation === 'UPSERT' && (!request.acknowledge_replacement || before.state !== 'PRESENT' && !request.acknowledge_unconfirmed_existing)) throw new AdportError('INVALID_INPUT', 'UPSERT requires replacement acknowledgement and, for unconfirmed current items, acknowledge_unconfirmed_existing.');
    }
    const prepared = await this.materialize(request, catalog.catalog_type, false);this.manifest(catalog.catalog_type, prepared.rows, current);
    const scope_id = this.scopeId();return { context_hash: hash({ selection, owner, catalog: { id: catalog.id, name: catalog.name, type: catalog.catalog_type }, scope: scope_id, request, current: current.map(({ pins: _pins, ...row }) => row) }), scope_id, selection, request, catalog, owner, current, prepared, records: current.map(row => ({ id: row.id, name: String(row.attributes?.title ?? row.attributes?.name ?? row.id), status: row.state, snapshot_hash: this.snapshot(selection, catalog.catalog_type, owner, row), diagnostics: row.diagnostics })), notes };
  }
  async publicContext(value: unknown) { const result = await this.context(value);return { context_hash: result.context_hash, catalog_type: result.catalog.catalog_type, records: result.records, media: result.prepared.sources, changes: result.prepared.rows.map(row => ({ source_id: row.source_id, operation: row.operation, attributes: publicValue(row.attributes), clear_fields: row.clear_fields })), notes }; }
  private batchRows(data: z.infer<typeof nativeBatch>, manifest: z.infer<typeof manifestRow>[]) {
    const seen = new Set<string>(), values = new Map<string, Row>();
    for (const row of data.items ?? []) {
      const id = sourceId.parse(row[itemIdField[data.catalog_type]]);if (seen.has(id) || !manifest.some(value => value.source_id === id)) throw failure(undefined);seen.add(id);
      const status = z.enum(['SUCCESS', 'FAILURE', 'PROCESSING']).optional().parse(row.status), errors = diagnostics(row.errors), warnings = diagnostics(row.warnings);if (status === 'SUCCESS' && errors.length) throw failure(undefined);
      values.set(id, { id, source_id: id, status: status ?? 'UNCONFIRMED', errors, warnings });
    }
    return manifest.map(row => values.get(row.source_id) ?? { id: row.source_id, source_id: row.source_id, status: data.status === 'FAILED' ? 'BATCH_FAILED' : 'UNCONFIRMED', errors: [], warnings: [] });
  }
  private async verifiedReceipt(value: unknown) {
    const input = batchReference.parse(value), proof = receiptSchema.parse(this.client.verifyCatalogBatchReceipt(input.batch_receipt));if (proof.account_id !== input.account_id || proof.scope_id !== this.scopeId() || proof.expires_at <= Math.floor(Date.now() / 1000) || proof.expires_at > Math.floor(Date.now() / 1000) + 30 * 86400) throw new AdportError('INVALID_INPUT', 'Batch receipt is expired or belongs to another advertiser/project.');
    const { catalog, owner } = await this.selected(proof);if (catalog.catalog_type !== proof.catalog_type || owner !== proof.owner_context_hash) throw new AdportError('POLICY_VIOLATION', 'Current catalog ownership/type differs from the batch receipt.');return proof;
  }
  async status(value: unknown, reconcile = false) {
    const proof = await this.verifiedReceipt(value), data = await this.client.get(`catalogs/items/batch/${proof.batch_id}`, nativeBatch, this.params(proof.account_id)).catch(error => { throw failure(error, [proof.batch_id]); });if (data.batch_id !== proof.batch_id || data.catalog_type !== proof.catalog_type) throw failure(undefined);
    const records = this.batchRows(data, proof.manifest);let readback_error: Row | undefined;
    if (reconcile) {
      try {
        const current = await this.readSet(proof, proof.catalog_type, proof.manifest.map(row => row.source_id));
        for (const record of records) {
          const expected = proof.manifest.find(row => row.source_id === record.id)!, actual = current.find(row => row.id === record.id)!;
          record.observed_state = actual.state;
          if (record.status !== 'SUCCESS') { record.readback = 'NATIVE_ITEM_NOT_SUCCESSFUL';continue; }
          if (expected.operation === 'DELETE') { record.readback = actual.state === 'PRESENT' ? 'STILL_PRESENT' : 'ABSENCE_UNCONFIRMED';continue; }
          if (!actual.attributes) { record.readback = 'CURRENT_ITEM_UNCONFIRMED';continue; }
          const matches = hash(wantedValues(proof.catalog_type, actual.attributes, expected.desired_keys, expected.clear_keys)) === expected.desired_hash, retains = !expected.preserved_hash || hash(preserved(normalized(proof.catalog_type, actual.attributes), expected.desired_keys)) === expected.preserved_hash;
          record.readback = matches && retains ? 'REQUESTED_CONFIGURATION_VERIFIED' : 'CONFIGURATION_UNCONFIRMED';record.omitted_fields_preserved = expected.preserved_hash ? retains : undefined;
        }
      } catch (error) { const details = error instanceof AdportError ? object(error.details) : {};readback_error = { status: 'READBACK_UNAVAILABLE', ...(typeof details.http_status === 'number' ? { http_status: details.http_status } : {}) }; }
    }
    return { batch_id: proof.batch_id, catalog_type: proof.catalog_type, status: data.status ?? 'UNCONFIRMED', records, submitted_items: proof.manifest.length, terminal_items: records.filter(row => ['SUCCESS', 'FAILURE', 'BATCH_FAILED'].includes(String(row.status))).length, all_items_native_successful: data.status === 'COMPLETED' && records.every(row => row.status === 'SUCCESS'), ...(readback_error ? { readback_error } : {}), media_expires_at: proof.media_expires_at, notes: [...notes, 'A native SUCCESS is not proof of Pin publication, ad eligibility or permanent media hosting. Missing/error item reads never independently certify deletion.'] };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const copy = op.tool === 'pinterest_update_catalog_item_copy', operation = itemWriteOperations[op.tool as keyof typeof itemWriteOperations], expectedKind = operation === 'CREATE' ? 'create' : operation === 'DELETE' ? 'remove' : 'update';
    if (op.provider !== 'pinterest' || !this.supports(op.tool) || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'Invalid catalog item mutation/provider kind.');
    const parsed = copy ? itemCopy.parse(op.payload) : operation ? itemNamedApply(operation).parse(op.payload) : itemBatchApply.parse(op.payload);
    const selection = itemSelection.parse({ account_id: op.accountId, catalog_id: parsed.catalog_id, country: parsed.country, language: parsed.language });
    const request: Request = 'source_id' in parsed ? { operations: [{ source_id: parsed.source_id, operation: 'UPDATE', attributes: {} }], media_assets: [] } : itemRequest.parse('operations' in parsed ? { operations: parsed.operations, media_assets: parsed.media_assets, acknowledge_replacement: parsed.acknowledge_replacement, acknowledge_unconfirmed_existing: parsed.acknowledge_unconfirmed_existing } : { operations: parsed.items.map(row => ({ ...row, operation })), media_assets: parsed.media_assets, acknowledge_replacement: parsed.acknowledge_replacement, acknowledge_unconfirmed_existing: parsed.acknowledge_unconfirmed_existing });
    if (copy) { const input = parsed as z.infer<typeof itemCopy>, parent = await this.selected(selection);request.operations[0]!.attributes = { ...(input.title !== undefined ? { [parent.catalog.catalog_type === 'HOTEL' ? 'name' : 'title']: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}) }; }
    const prepare = async () => { const result = await this.context({ ...selection, ...request });
      if (copy ? result.records[0]!.snapshot_hash !== (parsed as z.infer<typeof itemCopy>).expected_snapshot_hash : result.context_hash !== (parsed as z.infer<typeof itemBatchApply>).expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'Catalog items, selection, owner or media changed; read context and preview again.');return result; }, before = await prepare();let receipt: Row | undefined;
    const title = copy ? 'Update catalog item copy' : 'Submit catalog item batch';
    return { summary: `${title} · ${request.operations.length} items`, changes: before.prepared.rows.map(row => `${row.operation} ${row.source_id}`), coercions: [], budgetDeltas: [], notes,
      review: { provider: 'pinterest', accountId: op.accountId, kind: op.kind, title, subject: before.catalog.name, fields: [{ label: 'Catalog and market', after: { id: selection.catalog_id, type: before.catalog.catalog_type, country: selection.country, language: selection.language } }, ...before.prepared.rows.map(row => ({ label: row.source_id + ' · ' + row.operation, before: publicValue(before.current.find(value => value.id === row.source_id)!.attributes) ?? 'Current item unconfirmed; no absence inferred', after: row.operation === 'DELETE' ? 'Remove across all data sources' : { attributes: publicValue(row.attributes), clear_fields: row.clear_fields } })), ...(before.prepared.sources.length ? [{ label: 'Adport media', after: before.prepared.sources }] : [])], notices: [...notes, ...(request.media_assets.length ? ['Media links are minted only during approved apply and expire. Native retrieval may outlast the link; inspect batch/item errors before a new approval.'] : [])] },
      execute: async () => { const fresh = await prepare();let id: string | undefined;try {
        const materialized = await this.materialize(request, fresh.catalog.catalog_type, true), manifest = this.manifest(fresh.catalog.catalog_type, materialized.rows, fresh.current);if (this.scopeId() !== fresh.scope_id) throw new AdportError('PENDING_MISMATCH', 'Media scope changed before batch submission.');
        const items = materialized.rows.map(row => ({ [itemIdField[fresh.catalog.catalog_type]]: row.source_id, operation: row.operation, ...(row.attributes !== undefined ? { attributes: row.attributes } : {}), ...(row.clear_fields?.length ? { update_mask: [...new Set([...Object.keys(row.attributes!), ...row.clear_fields])] } : {}), ...(row.last_updated_time !== undefined ? { last_updated_time: row.last_updated_time } : {}) }));
        const data = await this.client.mutate('catalogs/items/batch', 'POST', { catalog_id: selection.catalog_id, catalog_type: fresh.catalog.catalog_type, country: selection.country, language: selection.language, items }, nativeBatch, this.params(op.accountId));id = data.batch_id;
        if (!id || !data.status || data.catalog_type !== fresh.catalog.catalog_type || data.created_time === null) throw failure(undefined, id ? [id] : []);
        const batch_receipt = this.client.catalogBatchReceipt({ ...selection, version: 'pinterest_items_v1', scope_id: fresh.scope_id, catalog_type: fresh.catalog.catalog_type, owner_context_hash: fresh.owner, batch_id: id, expires_at: Math.floor(Date.now() / 1000) + 30 * 86400, manifest, ...(materialized.expires ? { media_expires_at: materialized.expires } : {}) }), results = this.batchRows(data, manifest);
        if (data.status === 'FAILED' || results.every(row => row.status === 'FAILURE')) throw failure(undefined, [id], { batch_receipt, item_results: results, native_status: data.status });
        receipt = { status: 'ACCEPTED_FOR_PROCESSING', processed: false, native_status: data.status, batch_id: id, batch_receipt, records: results, native_item_count: results.filter(row => row.status !== 'UNCONFIRMED').length, source_items: manifest.length, configuration_verified: false, publication_verified: false, ...(materialized.expires ? { media_expires_at: materialized.expires } : {}), next_tool: 'pinterest_catalog_item_batch_status', next_arguments: { account_id: op.accountId, batch_receipt } };return [id];
      } catch (error) { const details = error instanceof AdportError ? object(error.details) : {};throw failure(error, id ? [id] : Array.isArray(details.resource_ids) ? details.resource_ids as string[] : [], details.batch_receipt ? { batch_receipt: details.batch_receipt, item_results: details.item_results, native_status: details.native_status } : {}); }
      }, resultDetails: () => receipt, resultWarnings: () => notes };
  }
}
