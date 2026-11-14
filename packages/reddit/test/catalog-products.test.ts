import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { redditTools } from '../src/tools.js';
import { catalogProduct, productsCreate, productsUpdate, productsDelete } from '../src/catalog-product-schemas.js';
import { productFixture, newProduct, productScope, PRODUCT_ACCOUNT, PRODUCT_CATALOG } from './catalog-products-fixture.js';

// Official v3 OpenAPI refreshed 2026-11-06: POST batch_upsert201/batch_delete200,
// complete Product fields and per-SKU receipts. Native data below is synthetic.
const dirs: string[] = [], guard = { forcePausedCreation: true };
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(mode: 'none' | 'read' | 'write' = 'write') { const f = await productFixture(mode);dirs.push(f.dir);return f; }
const operation = (tool: string, payload: Record<string, unknown>): WriteOperation => ({ tool, provider: 'reddit', accountId: PRODUCT_ACCOUNT, kind: tool.includes('_create_') ? 'create' : tool.includes('_delete_') ? 'remove' : 'update', payload });
const createTool = 'reddit_create_catalog_products', updateTool = 'reddit_update_catalog_products', deleteTool = 'reddit_delete_catalog_products';

describe('Reddit manual catalog products', () => {
  it('keeps all 45 documented write fields and validates required authoring and bounded unique batches', () => {
    expect(Object.keys(catalogProduct.shape)).toHaveLength(45);
    const base = { business_id: productScope.business_id, catalog_id: PRODUCT_CATALOG, expected_selection_hash: 'a'.repeat(64), acknowledge_shared_effects: true }, row = newProduct();
    expect(productsCreate.safeParse({ ...base, products: [row] }).success).toBe(true);
    for (const change of [{ title: null }, { description: '' }, { link: 'javascript:alert(1)' }, { image_link: 'https://user:pass@merchant.example.test/img' }, { price: 'EUR 20' }, { reddit: { id: 'internal' } }]) expect(productsCreate.safeParse({ ...base, products: [{ ...row, ...change }] }).success).toBe(false);
    expect(productsCreate.safeParse({ ...base, products: [row, row] }).success).toBe(false);expect(productsUpdate.safeParse({ ...base, products: [{ id: 'sku' }] }).success).toBe(false);expect(productsDelete.safeParse({ ...base, product_ids: ['sku'], acknowledge_permanent_deletion: false }).success).toBe(false);
  });
  it('reads exact opaque SKUs with repeated parameters and distinguishes missing SKUs from internal IDs', async () => {
    const f = await fixture(), id = f.state.products[0]!.id, result = await f.context([id, 'missing', 'native_product_1']);
    expect(result.missing_product_ids).toEqual(['missing', 'native_product_1']);expect(result.products[0]).toMatchObject({ id, title: 'QA <script>', reddit_id: 'native_product_1' });expect(f.calls.at(-1)!.url.searchParams.getAll('ids')).toEqual([id, 'missing', 'native_product_1']);expect(result.complete).toBe(true);
  });
  it('exhausts targeted pagination before establishing presence/absence', async () => {
    const f = await fixture(), id = f.state.products[0]!.id;
    f.state.hook = ({ url }) => url.pathname.endsWith('/products') ? Response.json({ data: url.searchParams.has('page.token') ? f.state.products : [], pagination: { next_url: url.searchParams.has('page.token') ? null : url.href + '&page.token=next' } }) : undefined;
    expect((await f.context([id])).missing_product_ids).toEqual([]);expect(f.calls.filter(call => call.url.pathname.endsWith('/products'))).toHaveLength(2);
  });
  it.each(['foreign-parent', 'unrequested', 'duplicate', 'wrong-cursor', 'cycle', 'denial', 'missing-pagination', 'changed-filter', 'hidden-filter', 'bounded'])('refuses unverified selected product reads: %s', async mode => {
    const f = await fixture(), row = f.state.products[0]!;let pages = 0;
    f.state.hook = ({ url }) => {
      if (!url.pathname.endsWith('/products')) return;
      if (mode === 'denial') return Response.json({ error: { message: 'qa-private-secret' } }, { status: 403 });
      const data = mode === 'foreign-parent' ? [{ ...row, reddit: { ...row.reddit, catalog_id: 'other' } }] : mode === 'unrequested' ? [{ ...row, id: 'other' }] : mode === 'duplicate' ? [row, row] : [], next = mode === 'wrong-cursor' ? 'https://foreign.example.test/products' : mode === 'cycle' ? url.href : mode === 'changed-filter' ? url.href.replace('ids=', 'ids=foreign') + '&page.token=next' : mode === 'hidden-filter' ? url.href + '&page.token=next&search=hide' : mode === 'bounded' ? url.href.split('&page.token=')[0] + '&page.token=' + (++pages) : null;
      return Response.json({ data, ...(mode === 'missing-pagination' ? {} : { pagination: { next_url: next } }) });
    };
    await expect(f.context([row.id])).rejects.toThrow();expect(f.writes()).toHaveLength(0);if (mode === 'bounded') expect(pages).toBe(10);
  });
  it('repeats exact SKU filters when the native next URL contains only a page token', async () => {
    const f = await fixture(), id = f.state.products[0]!.id;let page = 0;
    f.state.hook = ({ url }) => {
      if (!url.pathname.endsWith('/products')) return;
      expect(url.searchParams.getAll('ids')).toEqual([id]);page++;
      return Response.json({ data: page === 1 ? [] : f.state.products, pagination: { next_url: page === 1 ? url.origin + url.pathname + '?page.token=next' : null } });
    };
    expect((await f.context([id])).missing_product_ids).toEqual([]);expect(page).toBe(2);
  });
  it('creates an absent SKU once with native envelope and independently verifies full copy/URLs and catalog', async () => {
    const f = await fixture(), product = newProduct(), args = { ...await f.args([product.id]), products: [product] }, op = operation(createTool, args);
    expect((await f.provider.previewWrite(op, guard)).review?.title).toBe('Create catalog products');expect(f.writes()).toHaveLength(0);
    const result = await f.provider.applyWrite(op, guard);expect(result).toMatchObject({ applied: true, resourceIds: [product.id], details: { independently_verified: true, outcomes: [{ id: product.id, status: 'CREATED' }] } });expect(f.writes()).toHaveLength(1);expect(f.writes()[0]).toMatchObject({ method: 'POST', body: { data: [product] } });expect(f.writes()[0]!.url.pathname).toMatch(/\/products\/batch_upsert$/);expect(f.calls.at(-1)!.method).toBe('GET');
  });
  it('merges selected changes with every known writable field and sends no Reddit metadata', async () => {
    const f = await fixture(), row = structuredClone(f.state.products[0]!), args = { ...await f.args([row.id]), products: [{ id: row.id, title: 'New title', custom_label_0: null }] };
    await f.provider.applyWrite(operation(updateTool, args), guard);const wire = f.writes()[0]!.body!.data[0];expect(wire).toMatchObject({ id: row.id, title: 'New title', description: row.description, price: row.price, brand: row.brand, custom_label_0: null });expect(wire).not.toHaveProperty('reddit');expect(f.state.products[0]!.brand).toBe(row.brand);
  });
  it.each(['title', 'internal-id', 'parent', 'absence'])('rejects stale %s state before mutation', async change => {
    const f = await fixture(), row = f.state.products[0]!, args = { ...await f.args([row.id]), products: [{ id: row.id, title: 'Change' }] };
    if (change === 'title') row.title = 'Other';else if (change === 'internal-id') row.reddit.id = 'replacement';else if (change === 'parent') f.state.catalog.name = 'Other';else f.state.products = [];
    await expect(f.provider.applyWrite(operation(updateTool, args), guard)).rejects.toThrow('changed');expect(f.writes()).toHaveLength(0);
  });
  it('requires new SKUs for create, existing SKUs for update/delete and writable project catalog grants', async () => {
    const f = await fixture(), id = f.state.products[0]!.id;await expect(f.provider.previewWrite(operation(createTool, { ...await f.args([id]), products: [newProduct(id)] }), guard)).rejects.toThrow('absent');
    await expect(f.provider.previewWrite(operation(updateTool, { ...await f.args(['missing']), products: [{ id: 'missing', title: 'Change' }] }), guard)).rejects.toThrow('present');
    for (const mode of ['read', 'none'] as const) { const denied = await fixture(mode);await expect(denied.provider.previewWrite(operation(createTool, { business_id: productScope.business_id, catalog_id: PRODUCT_CATALOG, expected_selection_hash: 'a'.repeat(64), acknowledge_shared_effects: true, products: [newProduct()] }), guard)).rejects.toThrow();expect(denied.writes()).toHaveLength(0); }
  });
  it('refuses unknown configuration on update, and hashes unknown values for deletion staleness', async () => {
    const f = await fixture(), row = f.state.products[0]!;row.unknown_config = { important: 1 };const args = await f.args([row.id]);
    await expect(f.provider.previewWrite(operation(updateTool, { ...args, products: [{ id: row.id, title: 'Change' }] }), guard)).rejects.toThrow('unknown fields');row.unknown_config.important = 2;
    await expect(f.provider.previewWrite(operation(deleteTool, { ...args, product_ids: [row.id], acknowledge_permanent_deletion: true }), guard)).rejects.toThrow('changed');expect(f.writes()).toHaveLength(0);
  });
  it('deletes external SKUs in one POST and independently proves exhausted absence', async () => {
    const f = await fixture(), id = f.state.products[0]!.id, args = { ...await f.args([id]), product_ids: [id], acknowledge_permanent_deletion: true };
    const result = await f.provider.applyWrite(operation(deleteTool, args), guard);expect(result).toMatchObject({ resourceIds: [id], details: { outcomes: [{ id, status: 'DELETED' }], independently_verified: true } });expect(f.writes()[0]!.url.pathname).toMatch(/\/batch_delete$/);expect(f.writes()[0]!.body).toEqual({ data: [id] });expect(f.state.products).toHaveLength(0);
  });
  it.each(['transport', 'missing-receipt', 'foreign-receipt', 'wrong-parent', 'wrong-status', 'lost-brand', 'denied-readback'])('does not certify or replay uncertain/partial native writes: %s', async failure => {
    const f = await fixture(), id = f.state.products[0]!.id, args = { ...await f.args([id]), products: [{ id, title: 'Changed' }] };let mutated = false;
    f.state.hook = ({ method, url, body }) => {
      if (method === 'POST') {
        mutated = true;if (failure === 'transport') throw new Error('qa-private-secret');
        f.state.products[0] = { ...body!.data[0], reddit: { id: 'native_product_1', catalog_id: PRODUCT_CATALOG } };if (failure === 'lost-brand') delete f.state.products[0]!.brand;
        const product = { ...f.state.products[0], ...(failure === 'wrong-parent' ? { reddit: { catalog_id: 'foreign' } } : {}) };return Response.json({ data: failure === 'missing-receipt' ? [] : [{ status: failure === 'wrong-status' ? 'CREATED' : 'UPDATED', product: failure === 'foreign-receipt' ? { ...product, id: 'foreign' } : product }] }, { status: 201 });
      }
      if (mutated && failure === 'denied-readback' && url.pathname.endsWith('/products')) return Response.json({ message: 'qa-private-secret' }, { status: 403 });return;
    };
    let error: any;try { await f.provider.applyWrite(operation(updateTool, args), guard); } catch (caught) { error = caught; }expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('qa-private');expect(error.details.resourceIds).toEqual([id]);expect(f.writes()).toHaveLength(1);
  });
  it('retains identified partial outcomes without assigning ID-less INVALID receipts by position', async () => {
    const f = await fixture(), one = newProduct('one'), two = newProduct('two'), args = { ...await f.args(['one', 'two']), products: [one, two] };
    f.state.hook = ({ method }) => { if (method !== 'POST') return;const created = { ...one, reddit: { id: 'native_one', catalog_id: PRODUCT_CATALOG } };f.state.products.push(created);return Response.json({ data: [{ status: 'INVALID', issues: [{ message: 'qa-private-secret' }] }, { status: 'CREATED', product: created }] }, { status: 201 }); };
    await expect(f.provider.applyWrite(operation(createTool, args), guard)).rejects.toMatchObject({ details: { resourceIds: ['one', 'two'], outcomes: [{ status: 'INVALID' }, { id: 'one', status: 'CREATED' }], verified_product_ids: ['one'] } });expect(f.writes()).toHaveLength(1);
  });
  it('separates NOT_FOUND native receipts from deletions while requiring independent absence', async () => {
    const f = await fixture(), id = f.state.products[0]!.id, args = { ...await f.args([id]), product_ids: [id], acknowledge_permanent_deletion: true };
    f.state.hook = ({ method }) => { if (method !== 'POST') return;f.state.products = [];return Response.json({ data: { [id]: 'NOT_FOUND' } }); };
    expect(await f.provider.applyWrite(operation(deleteTool, args), guard)).toMatchObject({ details: { outcomes: [{ id, status: 'NOT_FOUND' }] }, warnings: expect.arrayContaining([expect.stringContaining('not reported as deleted')]) });
  });
  it.each(['foreign', 'missing', 'retained', 'denied'])('requires exact deletion receipts and independent absence: %s', async mode => {
    const f = await fixture(), id = f.state.products[0]!.id, args = { ...await f.args([id]), product_ids: [id], acknowledge_permanent_deletion: true };let mutated = false;
    f.state.hook = ({ method, url }) => {
      if (method === 'POST') { mutated = true;if (mode !== 'retained') f.state.products = [];return Response.json({ data: mode === 'foreign' ? { [id]: 'DELETED', other: 'DELETED' } : mode === 'missing' ? {} : { [id]: 'DELETED' } }); }
      if (mutated && mode === 'denied' && url.pathname.endsWith('/products')) return Response.json({ message: 'private' }, { status: 403 });return;
    };
    await expect(f.provider.applyWrite(operation(deleteTool, args), guard)).rejects.toMatchObject({ details: { resourceIds: [id] } });expect(f.writes()).toHaveLength(1);
  });
  it('bounds serialized batches before any native mutation', async () => {
    const f = await fixture(), products = Array.from({ length: 30 }, (_, index) => ({ ...newProduct('sku' + index), description: '界'.repeat(40_000) })), args = { ...await f.args(products.map(row => row.id)), products };
    await expect(f.provider.previewWrite(operation(createTool, args), guard)).rejects.toThrow('1 MB');expect(f.writes()).toHaveLength(0);
  });
  it('uses the shared exact-argument approval, consumes it once and records an audit receipt', async () => {
    const f = await fixture(), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: redditTools(f.provider) }] }), product = newProduct(), args = { account_id: PRODUCT_ACCOUNT, ...await f.args([product.id]), products: [product] }, preview = await runtime.registry.call(createTool, args, runtime.ctx) as any;
    expect(f.writes()).toHaveLength(0);await expect(runtime.registry.call(createTool, { ...args, products: [{ ...product, title: 'Other' }], pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();
    await runtime.registry.call(createTool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);await expect(runtime.registry.call(createTool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(1);const files = await readdir(join(f.dir, 'audit'));expect(await readFile(join(f.dir, 'audit', files[0]!), 'utf8')).toContain(product.id);
  });
});
