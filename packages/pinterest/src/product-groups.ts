import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { PinterestAdsClient } from './client.js';
import type { PinterestCatalogService } from './catalogs.js';
import { catalogType, groupAction, groupChanges, groupContext, groupCreate, groupDelete, groupId, groupList, groupPaging, groupReference, groupUpdate, nativeGroup, productGroupFilterSchema } from './product-group-schemas.js';

type Group = z.infer<typeof nativeGroup>;
type Action = z.infer<typeof groupAction>;
type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]>; resultDetails?(): unknown; resultWarnings?(): string[] };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const normalizeFilters = (filters: unknown): unknown => {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return filters;
  return Object.fromEntries(Object.entries(filters).map(([key, raw]) => {
    // Pinterest explicitly defaults these two pricing criteria to inclusion:true.
    const value = ['MIN_PRICE', 'MAX_PRICE'].includes(key) && raw && typeof raw === 'object' && !Array.isArray(raw) ? { inclusion: true, ...raw } : raw;
    return [key, Array.isArray(value) && ['any_of', 'all_of', 'values'].includes(key) ? value.map(item => key === 'values' && Array.isArray(item) ? item : normalizeFilters(item)).sort((a, b) => canonical(a).localeCompare(canonical(b))) : normalizeFilters(value)];
  }));
};
const configuration = (value: Group): Row => ({ ...Object.fromEntries(Object.entries(value).filter(([key]) => !['created_at', 'updated_at'].includes(key))), filters: normalizeFilters(value.filters) });
const mismatch = () => new AdportError('PROVIDER_ERROR', 'pinterest: product group scope, native response or pagination could not be verified.');
const notes = ['Product group edits change matching products and can affect existing ads using the group. No ad is activated and no budget, bid or source item is changed.', 'Native catalog/Creative Assets eligibility remains authoritative. Local preview and configuration readback do not prove final matched inventory, product Pin publication or serving.', 'No atomic compare-and-set is available. No native write is automatically retried; reconcile known IDs after an uncertain result.'];
const cursor = z.object({ selection: z.string().regex(/^[a-f0-9]{64}$/), native: z.string().min(1).max(4096) }).strict();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counts = z.discriminatedUnion('catalog_type', [z.object({ catalog_type: z.literal('RETAIL'), in_stock: count, out_of_stock: count, preorder: count, total: count, videos: count.optional() }).strict(), z.object({ catalog_type: z.literal('HOTEL'), total: count }).strict(), z.object({ catalog_type: z.literal('CREATIVE_ASSETS'), total: count, videos: count, images: count, app_links: count }).strict()]);
const product = z.object({ catalog_type: catalogType, metadata: z.record(z.string(), z.json()), pin: z.record(z.string(), z.json()) });

/** Pinterest-owned OpenAPI 5.28.0 at 51aca009, fetched 2026-11-06. */
export class PinterestProductGroups {
  constructor(private readonly client: PinterestAdsClient, private readonly catalogs: PinterestCatalogService) {}
  private params(account: string, extra: Record<string, string> = {}) { return new URLSearchParams({ ad_account_id: groupId.parse(account), ...extra }); }
  private scope(group: Group, catalog: { id: string; catalog_type: string }, wanted?: string) {
    if (group.catalog_id !== catalog.id || group.catalog_type !== catalog.catalog_type || wanted && group.id !== wanted || group.catalog_type !== 'RETAIL' && group.feed_id != null) throw mismatch();return group;
  }
  private snapshot(account: string, group: Group) { return hash({ account_id: account, configuration: configuration(group) }); }
  private async read(account: string, catalog: { id: string; catalog_type: string }, id: string) { return this.scope(await this.client.get(`catalogs/product_groups/${groupId.parse(id)}`, nativeGroup, this.params(account)), catalog, id); }
  private async page<S extends z.ZodType>(path: string, schema: S, account: string, selection: Row, input: { page_size: number; bookmark?: string }, query: Record<string, string>) {
    const key = hash({ account, selection, page_size: input.page_size });let native: string | undefined;
    if (input.bookmark) { let parsed: z.infer<typeof cursor>;try { parsed = cursor.parse(JSON.parse(Buffer.from(input.bookmark, 'base64url').toString('utf8'))); } catch { throw new AdportError('INVALID_INPUT', 'Invalid product group cursor; restart this selection.'); }if (parsed.selection !== key) throw new AdportError('PENDING_MISMATCH', 'Product group selection changed; restart its first page.');native = parsed.native; }
    const params = this.params(account, { ...query, page_size: String(input.page_size), ...(native ? { bookmark: native } : {}) }), value = await this.client.get(path, z.object({ items: z.array(schema).max(250), bookmark: z.string().min(1).max(4096).nullable().optional() }), params);
    if (value.items.length > input.page_size || value.bookmark && (value.bookmark === native || !value.items.length)) throw mismatch();
    const complete = value.bookmark === null ? true : value.bookmark === undefined ? null : false;
    return { items: value.items, complete, truncated: complete !== true, ...(value.bookmark ? { next_cursor: Buffer.from(JSON.stringify({ selection: key, native: value.bookmark })).toString('base64url') } : {}) };
  }
  async list(value: unknown) {
    const input = groupList.parse(value), context = await this.catalogs.getCatalog(input.account_id, input.catalog_id);
    if (input.feed_id) { if (context.catalog.catalog_type !== 'RETAIL') throw new AdportError('INVALID_INPUT', 'Feed-based groups are RETAIL only.');await this.catalogs.getFeed(input.account_id, input.catalog_id, input.feed_id); }
    const selected = { catalog_id: input.catalog_id, feed_id: input.feed_id, product_group_ids: input.product_group_ids ? [...input.product_group_ids].sort() : undefined }, page = await this.page('catalogs/product_groups', nativeGroup, input.account_id, selected, input, { catalog_id: input.catalog_id, ...(input.feed_id ? { feed_id: input.feed_id } : {}), ...(input.product_group_ids ? { product_group_ids: input.product_group_ids.join(',') } : {}) });
    if (new Set(page.items.map(row => row.id)).size !== page.items.length || page.items.some(row => input.feed_id && row.feed_id !== input.feed_id || input.product_group_ids && !input.product_group_ids.includes(row.id))) throw mismatch();
    const items = page.items.map(row => ({ ...this.scope(row, context.catalog), snapshot_hash: this.snapshot(input.account_id, row) }));return { ...page, items, records: items, notes };
  }
  async get(value: unknown) { const input = groupReference.parse(value), context = await this.catalogs.getCatalog(input.account_id, input.catalog_id), row = await this.read(input.account_id, context.catalog, input.product_group_id), group = { ...row, snapshot_hash: this.snapshot(input.account_id, row) };return { group, records: [group], notes }; }
  async counts(value: unknown) {
    const input = groupReference.parse(value), { group } = await this.get(input), data = await this.client.get(`catalogs/product_groups/${input.product_group_id}/product_counts`, counts, this.params(input.account_id));if (data.catalog_type !== group.catalog_type) throw mismatch();
    return { counts: data, group_snapshot_hash: group.snapshot_hash, records: [{ id: group.id, name: group.name ?? group.id, ...data }], notes: ['Native counts are a separate observation, not a frozen membership snapshot or proof of ad eligibility.'] };
  }
  async products(value: unknown) {
    const input = groupReference.extend(groupPaging).parse(value), { group } = await this.get({ account_id: input.account_id, catalog_id: input.catalog_id, product_group_id: input.product_group_id }), page = await this.page(`catalogs/product_groups/${group.id}/products`, product, input.account_id, { catalog_id: input.catalog_id, product_group_id: group.id, snapshot_hash: group.snapshot_hash }, input, {});
    const records = page.items.map(row => { const key = row.catalog_type === 'RETAIL' ? 'item_id' : row.catalog_type === 'HOTEL' ? 'hotel_id' : 'creative_assets_id', nativeId = row.metadata[key];if (row.catalog_type !== group.catalog_type || typeof nativeId !== 'string' || !nativeId || nativeId.length > 1024) throw mismatch();return { id: `${row.catalog_type}:${nativeId}:${hash(row)}`, name: typeof row.pin.title === 'string' ? row.pin.title : nativeId, source_id: nativeId, catalog_type: row.catalog_type, metadata: row.metadata, pin: row.pin }; });
    if (new Set(records.map(row => row.id)).size !== records.length) throw mismatch();return { ...page, records, group_snapshot_hash: group.snapshot_hash, notes: ['Native product/Pin fields are preserved as data. No preview URL, product ID alias or publication state is invented.'] };
  }
  private mutable(row: Group) { if (row.catalog_type !== 'CREATIVE_ASSETS' && row.type !== 'MERCHANT_CREATED') throw new AdportError('INVALID_INPUT', 'Only merchant-created retail/hotel product groups can be edited or deleted; automatic groups are read-only.'); }
  private references(filters: unknown): string[] {
    const result = new Set<string>();
    const walk = (value: unknown) => { if (!value || typeof value !== 'object') return;if (Array.isArray(value)) { value.forEach(walk);return; }for (const [key, item] of Object.entries(value)) { if (key === 'PRODUCT_GROUP') { const parsed = z.object({ values: z.array(groupId).min(1).max(100) }).safeParse(item);if (!parsed.success) throw mismatch();parsed.data.values.forEach(id => result.add(id)); }else walk(item); } };walk(filters);return [...result].sort();
  }
  async context(value: unknown) {
    const input = groupContext.parse(value), owner = await this.catalogs.getCatalog(input.account_id, input.catalog_id), catalog = owner.catalog, action = input.action;
    const current = action.kind === 'create' ? undefined : await this.read(input.account_id, catalog, action.product_group_id);if (current) this.mutable(current);
    let body: Row = {}, feed: unknown;
    if (action.kind === 'create') {
      const { mode, catalog_type, feed_id, confirm_all_products: _all, ...fields } = action.definition;if (catalog_type !== catalog.catalog_type) throw new AdportError('INVALID_INPUT', 'Product group type differs from selected catalog.');
      if (mode === 'FEED') { const currentFeed = (await this.catalogs.getFeed(input.account_id, catalog.id, feed_id!)).feed;feed = { id: feed_id, snapshot_hash: currentFeed.snapshot_hash }; }
      body = mode === 'FEED' ? { feed_id, ...fields } : { catalog_id: catalog.id, catalog_type, ...fields };
    } else if (action.kind === 'update') {
      const { confirm_all_products, ...changes } = groupChanges.parse(action.changes);
      if ((current!.catalog_type !== 'RETAIL' || current!.feed_id != null) && (changes.country !== undefined || changes.locale !== undefined)) throw new AdportError('INVALID_INPUT', 'Country/locale apply only to catalog-based RETAIL groups.');
      if (changes.filters && !productGroupFilterSchema(current!.catalog_type, current!.catalog_type !== 'RETAIL' && confirm_all_products === true).safeParse(changes.filters).success) throw new AdportError('INVALID_INPUT', 'Invalid filter selection; use pinterest_product_group_filter_schema.');
      body = { ...(current!.feed_id != null ? {} : { catalog_type: current!.catalog_type }), ...changes };
    } else if (!current!.name || current!.name !== action.confirm_name) throw new AdportError('INVALID_INPUT', 'Permanent deletion requires the exact current product group name.');
    const referenced = new Map<string, Group>(), visit = async (id: string, stack: Set<string>): Promise<void> => {
      if (id === current?.id || stack.has(id)) throw new AdportError('INVALID_INPUT', 'Product group filter references contain a cycle.');if (referenced.has(id)) return;if (referenced.size >= 40) throw new AdportError('INVALID_INPUT', 'Reference proof exceeds the 40-group Adport bound.');
      const row = await this.read(input.account_id, catalog, id);if (current?.feed_id != null && row.feed_id !== current.feed_id || action.kind === 'create' && action.definition.mode === 'FEED' && row.feed_id !== action.definition.feed_id) throw new AdportError('INVALID_INPUT', 'Referenced groups must belong to the selected retail feed.');
      referenced.set(id, row);for (const next of this.references(row.filters)) await visit(next, new Set([...stack, id]));
    };
    // Deletion does not resolve outgoing filter references; it verifies only the
    // exact owned resource being removed, including all current configuration.
    if (action.kind !== 'delete') for (const id of this.references(body.filters ?? current?.filters)) await visit(id, new Set());
    const context_hash = hash({ account_id: input.account_id, owner: owner.context_hash, catalog: { id: catalog.id, name: catalog.name, catalog_type: catalog.catalog_type }, action, current: current ? configuration(current) : undefined, body, feed, references: [...referenced.values()].map(row => configuration(row)).sort((a, b) => String(a.id).localeCompare(String(b.id))) });
    return { context_hash, catalog, current, body, records: [current ? { ...current, snapshot_hash: this.snapshot(input.account_id, current) } : { id: catalog.id, name: catalog.name, catalog_type: catalog.catalog_type }, ...[...referenced.values()].map(row => ({ id: row.id, name: row.name ?? row.id, reference: true, snapshot_hash: this.snapshot(input.account_id, row) }))], reference_count: referenced.size, notes };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const create = op.tool === 'pinterest_create_product_group', update = op.tool === 'pinterest_update_product_group', remove = op.tool === 'pinterest_delete_product_group';
    if (op.provider !== 'pinterest' || !(create || update || remove) || op.kind !== (create ? 'create' : update ? 'update' : 'remove')) throw new AdportError('INVALID_INPUT', 'Invalid Pinterest product group operation.');
    const input = create ? groupCreate.parse(op.payload) : update ? groupUpdate.parse(op.payload) : groupDelete.parse(op.payload);
    const action: Action = 'definition' in input ? { kind: 'create', definition: input.definition } : 'changes' in input ? { kind: 'update', product_group_id: input.product_group_id, changes: input.changes } : { kind: 'delete', product_group_id: input.product_group_id, confirm_name: input.confirm_name };
    const prepare = async () => { const context = await this.context({ account_id: op.accountId, catalog_id: input.catalog_id, action });if (context.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'Product group context, references or source settings changed; read context and preview again.');return context; }, before = await prepare();
    const title = create ? 'Create product group' : update ? 'Update product group' : 'Delete product group permanently', subject = create ? String(before.body.name) : before.current!.name ?? before.current!.id;let receipt: Row | undefined;
    return { summary: `${title} · ${subject}`, changes: [remove ? '- ' + subject : `${create ? '+' : '~'} ${canonical(before.body)}`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'pinterest', accountId: op.accountId, kind: op.kind, title, subject, fields: [{ label: 'Catalog', after: { id: before.catalog.id, name: before.catalog.name, type: before.catalog.catalog_type } }, { label: 'Source mode', after: (before.body.feed_id ?? before.current?.feed_id) ? 'Retail feed' : 'Catalog' }, ...(remove ? [{ label: 'Remove', before: configuration(before.current!), after: null }] : Object.entries(before.body).filter(([key]) => !['catalog_id', 'catalog_type'].includes(key)).map(([key, after]) => ({ label: ({ filters: 'Product selection', feed_id: 'Feed', name: 'Name', description: 'Description', country: 'Country', locale: 'Locale' } as Record<string, string>)[key] ?? key, ...(before.current && Object.hasOwn(before.current, key) ? { before: before.current[key] } : {}), after }))), { label: 'Verified filter references', after: before.reference_count }], notices: notes },
      execute: async () => { const fresh = await prepare();let id = fresh.current?.id;try {
        const path = `catalogs/product_groups${id ? '/' + id : ''}`;
        const result = await this.client.mutate(path, create ? 'POST' : update ? 'PATCH' : 'DELETE', remove ? undefined : fresh.body, remove ? z.union([nativeGroup, z.undefined()]) : nativeGroup, this.params(op.accountId));
        if (result) { if (id && result.id !== id) throw mismatch();id = result.id;this.scope(result, fresh.catalog, id); }if (!id) throw mismatch();
        if (remove) {
          const absence = await this.list({ account_id: op.accountId, catalog_id: input.catalog_id, product_group_ids: [id], page_size: 1 });if (absence.complete !== true || absence.items.length) throw mismatch();receipt = { deletion_readback: 'ABSENT_FROM_COMPLETE_FILTERED_LIST', items_deleted: false };
        } else {
          const actual = await this.read(op.accountId, fresh.catalog, id);
          if (create && !fresh.body.feed_id && actual.feed_id != null) throw mismatch();
          const wanted = update ? { ...configuration(fresh.current!), ...fresh.body, ...(fresh.body.filters ? { filters: normalizeFilters(fresh.body.filters) } : {}) } : { ...fresh.body, filters: normalizeFilters(fresh.body.filters), ...(fresh.catalog.catalog_type === 'CREATIVE_ASSETS' ? {} : { type: 'MERCHANT_CREATED' }) };
          if (Object.entries(wanted).some(([key, value]) => canonical(configuration(actual)[key]) !== canonical(value))) throw mismatch();
          receipt = { configuration_readback: 'VERIFIED', matched_inventory_verified: false, snapshot_hash: this.snapshot(op.accountId, actual), next_tool: 'pinterest_product_group_products', next_arguments: { account_id: op.accountId, catalog_id: input.catalog_id, product_group_id: id } };
        }
        return [id];
      } catch (error) { const data = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Row : {}, returned = Array.isArray(data.resource_ids) ? data.resource_ids.filter((value): value is string => typeof value === 'string' && groupId.safeParse(value).success) : [];throw new AdportError('PROVIDER_ERROR', 'Pinterest product group mutation is unconfirmed. No write was retried; reconcile known IDs before another preview.', { resource_ids: [...new Set([...(id ? [id] : []), ...returned])], ...(typeof data.http_status === 'number' ? { http_status: data.http_status } : {}) }); }
      }, resultDetails: () => receipt, resultWarnings: () => notes.slice(1) };
  }
}
