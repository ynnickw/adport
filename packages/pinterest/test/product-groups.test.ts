import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { pinterestTools } from '../src/tools.js';
import { groupDefinition, groupFilters as boundedFilters, productGroupFilterSchema } from '../src/product-group-schemas.js';
import { productGroupFixture, groupFilters, PG_ACCOUNT, PG_CATALOG, PG_FEED, PG_ID, PG_CREATED, type PGType } from './product-group-fixture.js';

// Wire shapes verified against Pinterest-owned OpenAPI 5.28.0 at
// 51aca009f10a90283ccdf3956d509fc995ebac23, refreshed 2026-11-06.
// All native bodies and account state in these tests are synthetic.
type Row = Record<string, any>;
const guard = { forcePausedCreation: true }, createTool = 'pinterest_create_product_group', updateTool = 'pinterest_update_product_group', deleteTool = 'pinterest_delete_product_group';
const op = (tool: string, payload: Row): WriteOperation => ({ provider: 'pinterest', accountId: PG_ACCOUNT, tool, kind: tool === createTool ? 'create' : tool === updateTool ? 'update' : 'remove', payload });
const scope = { account_id: PG_ACCOUNT, catalog_id: PG_CATALOG }, ref = { ...scope, product_group_id: PG_ID }, dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('Pinterest product group schemas and source scope', () => {
  it('defines nine unique lazy tools and keeps mutation approval in the shared registry', () => {
    const f = productGroupFixture(), tools = pinterestTools(new Proxy(f.provider, { get() { throw new Error('Eager provider access'); } })), names = ['pinterest_product_group_filter_schema', 'pinterest_product_groups', 'pinterest_get_product_group', 'pinterest_product_group_counts', 'pinterest_product_group_products', 'pinterest_product_group_context', createTool, updateTool, deleteTool];expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);expect(tools.filter(tool => names.includes(tool.name))).toHaveLength(9);for (const tool of tools.filter(tool => [createTool, updateTool, deleteTool].includes(tool.name))) expect(tool.input.shape.pending_operation_id).toBeDefined();
  });
  it.each(['RETAIL', 'HOTEL', 'CREATIVE_ASSETS'] as PGType[])('reads exact owned %s groups, native counts and product IDs without inventing preview URLs', async type => {
    const f = productGroupFixture(type), list = await f.provider.productGroups.list(scope), get = await f.provider.productGroups.get(ref), counts = await f.provider.productGroups.counts(ref), products = await f.provider.productGroups.products({ ...ref, page_size: 25 });expect(list.records[0]!.snapshot_hash).toBe(get.group.snapshot_hash);expect(counts.counts).toMatchObject({ catalog_type: type, total: 1 });expect(products.records[0]!.name).toBe('Synthetic product');expect(products.records[0]).not.toHaveProperty('preview_url');expect(products.complete).toBe(true);expect(f.writes()).toHaveLength(0);expect(f.calls.filter(call => call.url.pathname.startsWith('/v5/catalogs')).every(call => call.url.searchParams.get('ad_account_id') === PG_ACCOUNT)).toBe(true);
  });
  it('scopes feed/ID filters and opaque pagination without silently falling back to the token owner', async () => {
    const f = productGroupFixture('RETAIL', 'FEED');f.state.groups.push({ ...f.state.groups[0], id: PG_CREATED, name: 'Second group' });const input = { ...scope, feed_id: PG_FEED, page_size: 1 }, first = await f.provider.productGroups.list(input), second = await f.provider.productGroups.list({ ...input, bookmark: first.next_cursor });expect(first.complete).toBe(false);expect(second.records[0]!.id).toBe(PG_CREATED);expect(second.complete).toBe(true);const call = f.calls.at(-1)!;expect(Object.fromEntries(call.url.searchParams)).toEqual({ ad_account_id: PG_ACCOUNT, catalog_id: PG_CATALOG, feed_id: PG_FEED, page_size: '1', bookmark: 'native:1' });await expect(f.provider.productGroups.list({ ...scope, page_size: 1, bookmark: first.next_cursor })).rejects.toThrow('selection changed');
  });
  it('maps friendly product_group_ids to the native id query array without numeric coercion', async () => {
    const f = productGroupFixture(), large = '9007199254740993123';f.state.groups.push({ ...f.state.groups[0], id: large });const list = await f.provider.productGroups.list({ ...scope, product_group_ids: [PG_ID, large] });expect(list.records.map(row => row.id)).toEqual([PG_ID, large]);expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toEqual({ ad_account_id: PG_ACCOUNT, catalog_id: PG_CATALOG, page_size: '25', id: `${PG_ID},${large}` });expect(f.calls.at(-1)!.url.searchParams.has('product_group_ids')).toBe(false);
  });
  it.each(['catalog', 'type', 'id', 'duplicate', 'feed', 'count-type'])('rejects contradictory %s native scope', async fault => {
    const f = productGroupFixture();if (fault === 'catalog') f.state.groups[0]!.catalog_id = PG_FEED;if (fault === 'type') f.state.groups[0]!.catalog_type = 'HOTEL';if (fault === 'id') f.state.hook = ({ url }) => url.pathname.endsWith('/' + PG_ID) ? Response.json({ ...f.state.groups[0], id: PG_CREATED }) : undefined;if (fault === 'duplicate') f.state.groups.push({ ...f.state.groups[0] });if (fault === 'feed') f.state.groups[0]!.feed_id = PG_FEED;if (fault === 'count-type') f.state.hook = ({ url }) => url.pathname.endsWith('/product_counts') ? Response.json({ catalog_type: 'HOTEL', total: 1 }) : undefined;
    await expect(fault === 'duplicate' ? f.provider.productGroups.list(scope) : fault === 'feed' ? f.provider.productGroups.list({ ...scope, feed_id: '549000000009' }) : fault === 'count-type' ? f.provider.productGroups.counts(ref) : f.provider.productGroups.get(ref)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('leaves missing pagination unknown and rejects repeating/empty/oversized native pages', async () => {
    const f = productGroupFixture();f.state.hook = ({ url }) => url.pathname.endsWith('/product_groups') ? Response.json({ items: [] }) : undefined;expect(await f.provider.productGroups.list(scope)).toMatchObject({ complete: null, truncated: true });
    for (const data of [{ items: [], bookmark: 'native:next' }, { items: [f.state.groups[0], f.state.groups[0]], bookmark: null }]) { f.state.hook = ({ url }) => url.pathname.endsWith('/product_groups') ? Response.json(data) : undefined;await expect(f.provider.productGroups.list({ ...scope, page_size: 1 })).rejects.toThrow(); }
  });
  it('binds product pagination to the current group configuration and preserves same-SKU variants with distinct native metadata', async () => {
    const f = productGroupFixture();f.state.products.push({ ...f.state.products[0], metadata: { ...f.state.products[0]!.metadata, price: 29.99 }, pin: { title: 'Second product variant' } });const first = await f.provider.productGroups.products({ ...ref, page_size: 1 }), second = await f.provider.productGroups.products({ ...ref, page_size: 1, bookmark: first.next_cursor });expect(first.records[0]!.id).not.toBe(second.records[0]!.id);expect(first.records[0]!.source_id).toBe(second.records[0]!.source_id);f.state.groups[0]!.filters = { any_of: [{ ITEM_ID: { values: ['changed-sku'] } }] };await expect(f.provider.productGroups.products({ ...ref, page_size: 1, bookmark: first.next_cursor })).rejects.toThrow('selection changed');
  });
  it.each([
    ['RETAIL', { all_of: [{ MIN_PRICE: { values: 24.99, inclusion: false } }, { CURRENCY: { values: 'EUR', negated: false } }] }],
    ['RETAIL', { any_of: [{ CUSTOM_NUMBER_4: { value: 4_294_967_295, operator: 'GREATER_THAN_OR_EQUALS' } }, { CUSTOM_LABEL_0: { values: ['qa'], filter_operator_type: 'CONTAINS' } }] }],
    ['RETAIL', { all_of: [{ PRODUCT_TYPE_0: { values: [['Home', 'Furniture'], ['Garden']], negated: true } }, { PINTEREST_PRODUCT_CATEGORIES: { values: ['CHAIRS'] } }] }],
    ['HOTEL', { any_of: [{ PRICE: { value: 190.5, currency: 'EUR', operator: 'LESS_THAN' } }, { COUNTRY: { values: ['DE'] } }] }],
    ['CREATIVE_ASSETS', { all_of: [{ CREATIVE_ASSETS_ID: { values: ['asset1'] } }, { LINK: { values: ['example.test'], filter_operator_type: 'CONTAINS' } }] }],
  ] as const)('accepts exact native %s criterion nesting without converting prices to micros', (type, filters) => { expect(productGroupFilterSchema(type).parse(filters)).toEqual(filters); });
  it.each([
    ['RETAIL', { all_of: [] }], ['RETAIL', { all_of: [{ CURRENCY: { values: 'EUR', negated: true } }] }], ['RETAIL', { all_of: [{ CUSTOM_NUMBER_0: { value: 4_294_967_296, operator: 'IS' } }] }],
    ['HOTEL', { all_of: [{ ITEM_ID: { values: ['sku'] } }] }], ['CREATIVE_ASSETS', { all_of: [{ MEDIA_TYPE: { values: ['AUDIO'] } }] }],
    ['RETAIL', { any_of: [{ BRAND: { values: ['qa'] }, ITEM_ID: { values: ['sku'] } }] }], ['RETAIL', { any_of: [{ BRAND: { values: ['qa'], invented: true } }] }],
    ['RETAIL', { any_of: [{ PRODUCT_TYPE_0: { values: ['flat-instead-of-path'] } }] }], ['HOTEL', { all_of: [{ PRICE: { value: -1, currency: 'EUR', operator: 'LESS_THAN' } }] }],
  ] as const)('rejects invalid %s filter semantics', (type, filters) => { expect(productGroupFilterSchema(type).safeParse(filters).success).toBe(false); });
  it('requires explicit all-products intent for empty non-retail filters and respects native retail mode constraints', async () => {
    const f = productGroupFixture('HOTEL'), definition = { ...f.definition(), filters: { all_of: [] } };expect(groupDefinition.safeParse(definition).success).toBe(false);expect(groupDefinition.safeParse({ ...definition, confirm_all_products: true }).success).toBe(true);const args = await f.create({ ...definition, confirm_all_products: true });await f.provider.applyWrite(op(createTool, args), guard);expect(f.writes()[0]!.body).not.toHaveProperty('confirm_all_products');
    expect(groupDefinition.safeParse({ ...definition, mode: 'FEED', feed_id: PG_FEED }).success).toBe(false);expect(groupDefinition.safeParse({ ...productGroupFixture().definition(), mode: 'FEED', feed_id: PG_FEED }).success).toBe(false);
  });
  it('keeps automatic empty-filter groups readable and measures the filter bound in UTF-8 bytes', async () => {
    const f = productGroupFixture();Object.assign(f.state.groups[0]!, { type: 'ALL_PRODUCTS', filters: { all_of: [] } });expect((await f.provider.productGroups.get(ref)).group.filters).toEqual({ all_of: [] });await expect(f.update()).rejects.toThrow('automatic');
    const filters = { all_of: [{ BRAND: { values: Array(90).fill('界'.repeat(1024)) } }] };expect(JSON.stringify(filters).length).toBeLessThan(262_144);expect(boundedFilters.safeParse(filters).success).toBe(false);
  });
});

describe('Pinterest product group writes', () => {
  it.each([['RETAIL', 'FEED'], ['RETAIL', 'CATALOG'], ['HOTEL', 'CATALOG'], ['CREATIVE_ASSETS', 'CATALOG']] as const)('creates %s %s with exact native JSON and independent owner/ID/configuration readback', async (type, mode) => {
    const f = productGroupFixture(type, mode), args = await f.create(), preview = await f.provider.previewWrite(op(createTool, args), guard);expect(preview.serverValidated).toBe(false);expect(f.writes()).toHaveLength(0);const result = await f.provider.applyWrite(op(createTool, args), guard), { mode: _mode, catalog_type, ...fields } = args.definition, body = mode === 'FEED' ? fields : { catalog_id: PG_CATALOG, catalog_type, ...fields };expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toEqual(body);expect(f.writes()[0]!.url.pathname).toBe('/v5/catalogs/product_groups');expect(f.writes()[0]!.url.search).toBe('?ad_account_id=' + PG_ACCOUNT);expect(result).toMatchObject({ resourceIds: [PG_CREATED], details: { configuration_readback: 'VERIFIED', matched_inventory_verified: false } });expect(preview.review?.fields).toContainEqual({ label: 'Source mode', after: mode === 'FEED' ? 'Retail feed' : 'Catalog' });
  });
  it.each([['RETAIL', 'FEED'], ['RETAIL', 'CATALOG'], ['HOTEL', 'CATALOG'], ['CREATIVE_ASSETS', 'CATALOG']] as const)('updates only requested fields for %s %s and preserves unknown native configuration', async (type, mode) => {
    const f = productGroupFixture(type, mode);f.state.groups[0]!.native_setting = { preserved: true };const before = structuredClone(f.state.groups[0]), args = await f.update({ name: 'Renamed', description: null, filters: { any_of: [...groupFilters(type).all_of] } });const result = await f.provider.applyWrite(op(updateTool, args), guard);expect(f.writes()[0]!.body).toEqual({ ...(mode === 'FEED' ? {} : { catalog_type: type }), ...args.changes });expect(f.state.groups[0]).toMatchObject({ id: before!.id, catalog_id: before!.catalog_id, native_setting: before!.native_setting });expect(result.details).toMatchObject({ configuration_readback: 'VERIFIED', matched_inventory_verified: false });
  });
  it('allows retail catalog locale/country edits but forbids them for feed/hotel/creative modes', async () => {
    const f = productGroupFixture(), args = await f.update({ country: 'DE', locale: 'de' });await f.provider.applyWrite(op(updateTool, args), guard);expect(f.writes()[0]!.body).toEqual({ catalog_type: 'RETAIL', country: 'DE', locale: 'de' });for (const [type, mode] of [['RETAIL', 'FEED'], ['HOTEL', 'CATALOG'], ['CREATIVE_ASSETS', 'CATALOG']] as const) await expect(productGroupFixture(type, mode).update({ country: 'DE' })).rejects.toThrow('Country/locale');
  });
  it('refuses automatic retail/hotel groups and keeps exact confirmation names', async () => {
    for (const type of ['RETAIL', 'HOTEL'] as const) { const f = productGroupFixture(type);f.state.groups[0]!.type = type === 'RETAIL' ? 'ALL_PRODUCTS' : 'ALL_LISTINGS';await expect(f.update()).rejects.toThrow('automatic');await expect(f.remove()).rejects.toThrow('automatic');expect(f.writes()).toHaveLength(0); }
    const f = productGroupFixture();f.state.groups[0]!.name = '  Exact legacy name  ';await expect(f.context({ kind: 'delete', product_group_id: PG_ID, confirm_name: 'Exact legacy name' })).rejects.toThrow('exact current');expect((await f.remove()).confirm_name).toBe('  Exact legacy name  ');
  });
  it.each(['name', 'owner', 'filters', 'source'])('rejects changed %s context before native mutation', async change => {
    const f = productGroupFixture('RETAIL', 'FEED'), args = await f.create();if (change === 'owner') f.state.owner = 'Different owner';else if (change === 'source') f.state.feed.location += '-changed';else if (change === 'filters') args.definition.filters = { any_of: [{ ITEM_ID: { values: ['new-sku'] } }] };else f.state.catalog.name = 'Changed catalog';await expect(f.provider.applyWrite(op(createTool, args), guard)).rejects.toThrow('changed');expect(f.writes()).toHaveLength(0);
  });
  it('ignores volatile timestamps and recognizes reordered OR clauses/values without changing path order', async () => {
    const f = productGroupFixture(), filters = { any_of: [{ BRAND: { values: ['b', 'a'] } }, { PRODUCT_TYPE_0: { values: [['Home', 'Furniture']] } }] }, args = await f.update({ filters });f.state.groups[0]!.updated_at += 10;f.state.hook = ({ url }) => { if (url.pathname.endsWith('/' + PG_ID) && f.writes().length) f.state.groups[0]!.filters = { any_of: [{ PRODUCT_TYPE_0: { values: [['Home', 'Furniture']] } }, { BRAND: { values: ['a', 'b'] } }] };return undefined; };await expect(f.provider.applyWrite(op(updateTool, args), guard)).resolves.toMatchObject({ details: { configuration_readback: 'VERIFIED' } });
  });
  it('recognizes the documented native price-inclusion default without rewriting the requested payload', async () => {
    const f = productGroupFixture(), args = await f.update({ filters: { all_of: [{ MIN_PRICE: { values: 24.99 } }] } });f.state.hook = ({ url }) => { if (url.pathname.endsWith('/' + PG_ID) && f.writes().length) f.state.groups[0]!.filters = { all_of: [{ MIN_PRICE: { values: 24.99, inclusion: true } }] };return undefined; };
    await expect(f.provider.applyWrite(op(updateTool, args), guard)).resolves.toMatchObject({ details: { configuration_readback: 'VERIFIED' } });expect(f.writes()[0]!.body!.filters).toEqual({ all_of: [{ MIN_PRICE: { values: 24.99 } }] });
  });
  it('binds transitive group references, rejects cross-feed/cross-catalog cycles and stops stale dependencies', async () => {
    const f = productGroupFixture(), dependency = '549000000006', nested = '549000000007';f.state.groups.push({ ...f.state.groups[0], id: dependency, name: 'Dependency', filters: { all_of: [{ PRODUCT_GROUP: { values: [nested] } }] } }, { ...f.state.groups[0], id: nested, name: 'Nested' });const def = { ...f.definition(), filters: { all_of: [{ PRODUCT_GROUP: { values: [dependency], negated: true } }] } }, args = await f.create(def);expect((await f.context({ kind: 'create', definition: def })).reference_count).toBe(2);f.state.groups[2]!.name = 'Changed dependency';await expect(f.provider.applyWrite(op(createTool, args), guard)).rejects.toThrow('changed');expect(f.writes()).toHaveLength(0);
    f.state.groups[2]!.filters = { all_of: [{ PRODUCT_GROUP: { values: [dependency] } }] };await expect(f.create(def)).rejects.toThrow('cycle');f.state.groups[2]!.filters = groupFilters('RETAIL');f.state.groups[2]!.catalog_id = PG_FEED;await expect(f.create(def)).rejects.toThrow('scope');
    const feed = productGroupFixture('RETAIL', 'FEED');feed.state.groups.push({ ...feed.state.groups[0], id: dependency, feed_id: null });await expect(feed.create({ ...feed.definition(), filters: def.filters })).rejects.toThrow('selected retail feed');
  });
  it('rejects a new self-reference or a contradictory preservation readback without replay', async () => {
    const f = productGroupFixture();await expect(f.update({ filters: { all_of: [{ PRODUCT_GROUP: { values: [PG_ID] } }] } })).rejects.toThrow('cycle');const args = await f.update();f.state.hook = ({ url }) => { if (url.pathname.endsWith('/' + PG_ID) && f.writes().length) f.state.groups[0]!.status = 'INACTIVE';return undefined; };await expect(f.provider.applyWrite(op(updateTool, args), guard)).rejects.toMatchObject({ details: { resource_ids: [PG_ID] } });expect(f.writes()).toHaveLength(1);
  });
  it.each([200, 204])('deletes with HTTP%s and complete filtered absence, retaining source products', async status => {
    const f = productGroupFixture();f.state.deleteStatus = status;const products = structuredClone(f.state.products), args = await f.remove(), result = await f.provider.applyWrite(op(deleteTool, args), guard);expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toBeUndefined();expect(result).toMatchObject({ resourceIds: [PG_ID], details: { deletion_readback: 'ABSENT_FROM_COMPLETE_FILTERED_LIST', items_deleted: false } });expect(f.state.products).toEqual(products);expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toEqual({ ad_account_id: PG_ACCOUNT, catalog_id: PG_CATALOG, id: PG_ID, page_size: '1' });
  });
  it.each(['missing-bookmark', 'still-present', 'read-denied'])('does not certify deletion with %s evidence', async failure => {
    const f = productGroupFixture(), args = await f.remove(), row = structuredClone(f.state.groups[0]);f.state.hook = ({ url }) => { if (!f.writes().length || !url.pathname.endsWith('/product_groups')) return;if (failure === 'read-denied') return Response.json({}, { status: 403 });return Response.json(failure === 'missing-bookmark' ? { items: [] } : { items: [row], bookmark: null }); };await expect(f.provider.applyWrite(op(deleteTool, args), guard)).rejects.toMatchObject({ details: { resource_ids: [PG_ID] } });expect(f.writes()).toHaveLength(1);
  });
  it.each(['native', 'transport', 'missing-id', 'wrong-mode', 'foreign-id'])('retains known creation IDs and avoids leaking/replaying %s failures', async failure => {
    const f = productGroupFixture(), args = await f.create();f.state.hook = ({ url, init }) => { if (init.method === 'POST') { if (failure === 'transport') throw new Error('PRIVATE transport');if (failure === 'native') return Response.json({ message: 'PRIVATE native body' }, { status: 403 });if (failure === 'missing-id') return Response.json({ catalog_type: 'RETAIL' }); }if (url.pathname.endsWith('/' + PG_CREATED)) { if (failure === 'wrong-mode') f.state.groups.find(row => row.id === PG_CREATED)!.feed_id = PG_FEED;if (failure === 'foreign-id') return Response.json({ ...f.state.groups.find(row => row.id === PG_CREATED), catalog_id: PG_FEED }); }return undefined; };
    let error: any;try { await f.provider.applyWrite(op(createTool, args), guard); } catch (caught) { error = caught; }expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('PRIVATE');expect(f.writes()).toHaveLength(1);if (['wrong-mode', 'foreign-id'].includes(failure)) expect(error.details.resource_ids).toContain(PG_CREATED);
  });
  it('uses shared exact-argument approval, consumes it once and records the verified resource in audit', async () => {
    const f = productGroupFixture(), dir = await mkdtemp(join(tmpdir(), 'pinterest-group-policy-'));dirs.push(dir);const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: pinterestTools(f.provider) }] }), args = { account_id: PG_ACCOUNT, ...await f.create() }, preview = await runtime.registry.call(createTool, args, runtime.ctx) as Row;
    await expect(runtime.registry.call(createTool, { ...args, definition: { ...args.definition, name: 'Changed' }, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(0);await runtime.registry.call(createTool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);await expect(runtime.registry.call(createTool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(1);const audit = (await Promise.all((await readdir(join(dir, 'audit'))).map(name => readFile(join(dir, 'audit', name), 'utf8')))).join('');expect(audit).toContain(PG_CREATED);expect(audit).not.toContain('PRIVATE');
  });
});
