import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTikTokCatalogAccessStore, catalogGrant } from '../src/catalog-access.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// TikTok-owned v1.3 docs catalogSetGet/SetProductGet/SetUpdate, fetched 2026-11-05.
// Use documented v1.3 names, not the old v1.2 names in several stale examples.
const A = '7678335757387513873', B = '111', C = '222', S = '333';
const input = { account_id: A, bc_id: B, catalog_id: C };
const scope = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const };
const catalog = { catalog_id: C, catalog_name: 'QA catalog', catalog_type: 'ECOM', bc_info: { bc_id: B }, catalog_conf: { country: 'DE', currency: 'EUR' } };
const set = { product_set_id: S, catalog_id: C, product_set_name: 'QA <set>', conditions: { or: [{ field: 'price', operation: 'LT', value: '250' }] }, product_count: 2 };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
type Call = { url: URL; init: RequestInit };
async function fixture(mode: 'read' | 'write' | 'none' = 'write', override?: (call: Call, written: boolean) => unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'adport-tiktok-product-sets-'));dirs.push(dir);
  const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));
  if (mode !== 'none') await store.compareAndSet(scope, catalogGrant(scope).hash, mode);
  const calls: Call[] = [];let current = structuredClone(set), written = false;
  const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
    const call = { url: new URL(String(raw)), init };calls.push(call);const custom = override?.(call, written);
    if (custom !== undefined) return custom instanceof Response ? custom : Response.json({ code: 0, data: custom });
    if (call.url.pathname.endsWith('/catalog/get/')) return Response.json({ code: 0, data: { list: [catalog] } });
    if (call.url.pathname.endsWith('/catalog/set/get/')) return Response.json({ code: 0, data: { list: [current] } });
    if (call.url.pathname.endsWith('/catalog/set/product/get/')) return Response.json({ code: 0, data: { catalog_id: C, product_set_id: S, product_count: 2, products: [{ product_id: '9007199254740993', product_name: 'QA product', sku_id: 'sku-1' }, { product_id: 42, product_name: 'Small safe numeric ID' }], page_info: { page: 1, page_size: 20, total_number: 2, total_page: 1 } } });
    if (call.url.pathname.endsWith('/catalog/set/update/')) { written = true;current = { ...current, product_set_name: JSON.parse(String(init.body)).product_set_name };return Response.json({ code: 0, data: { product_set_id: S } }); }
    throw new Error('Unexpected fixture endpoint');
  }), { appId: 'inert', secret: 'inert' }, undefined, store);
  const op = (payload: Record<string, unknown>): WriteOperation => ({ provider: 'tiktok', tool: 'tiktok_rename_product_set', accountId: A, kind: 'update', payload });
  const rename = async () => ({ bc_id: B, catalog_id: C, product_set_id: S, product_set_name: 'Renamed QA', expected_configuration_hash: (await provider.catalogs.productSets.list(input)).sets[0]!.configuration_hash, acknowledge_shared_effects: true });
  return { dir, store, provider, service: provider.catalogs.productSets, calls, op, rename };
}
const writes = (calls: Call[]) => calls.filter(call => call.init.method === 'POST');
const guard = { forcePausedCreation: true };

describe('TikTok catalog product-set scope and reads', () => {
  it('rejects ungranted account/Business Center/catalog selections before any native read', async () => {
    const f = await fixture('none');await expect(f.service.list(input)).rejects.toThrow('read access');expect(f.calls).toHaveLength(0);
    const g = await fixture();for (const patch of [{ account_id: '999' }, { bc_id: '999' }, { catalog_id: '999' }]) await expect(g.service.products({ ...input, ...patch, product_set_id: S })).rejects.toThrow('read access');expect(g.calls).toHaveLength(0);
  });
  it('sends exact BC/catalog IDs, no advertiser fallback, no undocumented native paging and count=false by default', async () => {
    const f = await fixture('read'), result = await f.service.list(input), call = f.calls[1]!;
    expect(call.url.pathname).toBe('/open_api/v1.3/catalog/set/get/');expect(Object.fromEntries(call.url.searchParams)).toEqual({ bc_id: B, catalog_id: C, return_product_count: 'false' });expect(call.init.method).toBe('GET');expect(call.init.redirect).toBe('error');expect(result.sets[0]).toMatchObject({ ...set, configuration_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });expect(result.complete).toBe(true);expect(result.truncated).toBe(false);expect(writes(f.calls)).toHaveLength(0);
    await f.service.list({ ...input, product_set_id: S, return_product_count: true });expect(f.calls.at(-1)!.url.searchParams.get('product_set_id')).toBe(S);expect(f.calls.at(-1)!.url.searchParams.get('return_product_count')).toBe('true');
  });
  it('pages a stable snapshot locally and invalidates changed selections/configuration while ignoring product counts', async () => {
    let changed = false, count = 1;const rows = () => [set, { ...set, product_set_id: '444', product_set_name: changed ? 'Changed' : 'Second', product_count: count }];
    const f = await fixture('read', call => call.url.pathname.endsWith('/catalog/set/get/') ? { list: rows().filter(row => !call.url.searchParams.has('product_set_id') || row.product_set_id === call.url.searchParams.get('product_set_id')) } : undefined);
    const first = await f.service.list({ ...input, page_size: 1 });expect(first.sets).toHaveLength(1);expect(first.next_cursor).toBeDefined();expect(first.complete).toBe(false);
    count = 9;expect((await f.service.list({ ...input, page_size: 1, cursor: first.next_cursor })).sets[0]!.product_set_id).toBe('444');
    for (const patch of [{ page_size: 2 }, { return_product_count: true }, { product_set_id: S }]) await expect(f.service.list({ ...input, page_size: 1, ...patch, cursor: first.next_cursor })).rejects.toThrow('changed');
    changed = true;await expect(f.service.list({ ...input, page_size: 1, cursor: first.next_cursor })).rejects.toThrow('changed');await expect(f.service.list({ ...input, cursor: 'invalid-json' })).rejects.toThrow('Invalid product-set cursor');
  });
  it.each(['wrong-catalog', 'wrong-bc', 'wrong-set', 'duplicate', 'empty-exact', 'partial', 'unsafe-id', 'conflicting-name', 'too-many'])('rejects %s set responses', async fault => {
    const f = await fixture('read', call => {
      if (!call.url.pathname.endsWith('/catalog/set/get/')) return;
      let list: unknown[] = [{ ...set, ...(fault === 'wrong-catalog' ? { catalog_id: '999' } : {}), ...(fault === 'wrong-bc' ? { bc_id: '999' } : {}), ...(fault === 'wrong-set' ? { product_set_id: '999' } : {}), ...(fault === 'unsafe-id' ? { product_set_id: Number.MAX_SAFE_INTEGER + 1 } : {}), ...(fault === 'conflicting-name' ? { name: 'Different' } : {}) }];
      if (fault === 'duplicate') list = [set, set];if (fault === 'empty-exact') list = [];if (fault === 'too-many') list = Array.from({ length: 5001 }, (_, n) => ({ ...set, product_set_id: String(n + 1) }));
      return { list, ...(fault === 'partial' ? { page_info: { page: 1, total_page: 2 } } : {}) };
    });await expect(f.service.list({ ...input, product_set_id: S })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('accepts the documented legacy name alias and safe numeric IDs without rounding large string IDs', async () => {
    const f = await fixture('read', call => call.url.pathname.endsWith('/catalog/set/get/') ? { list: [{ product_set_id: 333, catalog_id: 222, name: 'Legacy example', conditions: {} }] } : undefined);
    expect((await f.service.list(input)).sets[0]).toMatchObject({ product_set_id: S, catalog_id: C, product_set_name: 'Legacy example' });
    const products = await f.service.products({ ...input, product_set_id: S });expect(products.products.map(row => row.product_id)).toEqual(['9007199254740993', '42']);expect(products.complete).toBe(true);expect(products).not.toHaveProperty('next_page');
    expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toEqual({ bc_id: B, catalog_id: C, product_set_id: S, page: '1', page_size: '20' });
    expect(new Headers(f.calls.at(-1)!.init.headers).get('content-type')).toBe('application/json');
  });
  it.each(['wrong-set', 'wrong-catalog', 'wrong-product-parent', 'wrong-page', 'unsafe-id', 'duplicate'])('rejects %s product responses', async fault => {
    const f = await fixture('read', call => call.url.pathname.endsWith('/catalog/set/product/get/') ? {
      catalog_id: fault === 'wrong-catalog' ? '999' : C, product_set_id: fault === 'wrong-set' ? '999' : S, product_count: 1,
      products: fault === 'duplicate' ? [{ product_id: '44', product_name: 'A' }, { product_id: '44', product_name: 'B' }] : [{ product_id: fault === 'unsafe-id' ? Number.MAX_SAFE_INTEGER + 1 : '44', product_name: 'A', ...(fault === 'wrong-product-parent' ? { catalog_id: '999' } : {}) }],
      page_info: { page: fault === 'wrong-page' ? 2 : 1, page_size: 20, total_number: 1, total_page: 1 },
    } : undefined);await expect(f.service.products({ ...input, product_set_id: S })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('exposes native continuation only with consistent totals and marks missing/contradictory pagination unknown', async () => {
    let page: unknown = { page: 2, page_size: 1, total_number: 3, total_page: 3 };
    const f = await fixture('read', call => call.url.pathname.endsWith('/catalog/set/product/get/') ? { catalog_id: C, product_set_id: S, product_count: 3, products: [{ product_id: '44', product_name: 'A' }], ...(page ? { page_info: page } : {}) } : undefined);
    const args = { ...input, product_set_id: S, page: 2, page_size: 1 };expect(await f.service.products(args)).toMatchObject({ complete: false, truncated: true, next_page: 3 });
    for (const value of [undefined, { page: 2, page_size: 1, total_number: 3, total_page: 1 }, { page: 2, page_size: 1, total_number: 2, total_page: 2 }]) { page = value;const data = await f.service.products(args);expect(data.complete).toBeNull();expect(data.truncated).toBe(true);expect(data).not.toHaveProperty('next_page'); }
  });
  it('sanitizes error bodies and never retries failed native reads', async () => {
    const f = await fixture('read', call => call.url.pathname.endsWith('/catalog/set/get/') ? Response.json({ code: 40001, message: 'SECRET failure body', data: { access_token: 'PRIVATE' } }) : undefined);
    await expect(f.service.list(input)).rejects.toThrow('product-set read failed');expect(f.calls.filter(call => call.url.pathname.endsWith('/catalog/set/get/'))).toHaveLength(1);expect(writes(f.calls)).toHaveLength(0);
  });
});

describe('TikTok guarded product-set rename', () => {
  it('uses the shared preview/token gate and native product_set_name, preserving conditions on readback', async () => {
    const f = await fixture(), args = { ...input, ...await f.rename() };
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] });
    const preview = await runtime.registry.call('tiktok_rename_product_set', args, runtime.ctx) as { pending_operation_id: string };expect(preview.pending_operation_id).toBeTruthy();expect(writes(f.calls)).toHaveLength(0);
    await expect(runtime.registry.call('tiktok_rename_product_set', { ...args, product_set_name: 'Unapproved', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(await runtime.registry.call('tiktok_rename_product_set', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toHaveProperty('result.applied', true);
    const write = writes(f.calls);expect(write).toHaveLength(1);expect(write[0]!.url.pathname).toBe('/open_api/v1.3/catalog/set/update/');expect(JSON.parse(String(write[0]!.init.body))).toEqual({ bc_id: B, catalog_id: C, product_set_id: S, product_set_name: 'Renamed QA' });expect(f.calls.at(-1)!.url.pathname).toBe('/open_api/v1.3/catalog/set/get/');
    expect((await f.service.list(input)).sets[0]!.conditions).toEqual(set.conditions);
  });
  it('rechecks write grant and configuration at apply time; count changes do not invalidate approval', async () => {
    let conditions = set.conditions;const f = await fixture('write', call => call.url.pathname.endsWith('/catalog/set/get/') ? { list: [{ ...set, conditions, product_count: 99 }] } : undefined), args = await f.rename();
    const preview = await f.provider.previewWrite(f.op(args), guard);expect(preview.serverValidated).toBe(false);expect(preview.review?.fields[0]).toMatchObject({ before: 'QA <set>', after: 'Renamed QA' });
    conditions = { or: [{ field: 'price', operation: 'LT', value: '999' }] };await expect(f.provider.applyWrite(f.op(args), guard)).rejects.toThrow('configuration changed');
    const fresh = await f.rename(), grant = await f.store.get(scope);await f.store.compareAndSet(scope, grant.hash, 'read');await expect(f.provider.applyWrite(f.op(fresh), guard)).rejects.toThrow('write access');expect(writes(f.calls)).toHaveLength(0);
  });
  it.each(['wrong-receipt', 'preservation-failure', 'transport'])('retains the known ID after %s without automatic write replay', async fault => {
    const f = await fixture('write', (call, written) => {
      if (call.url.pathname.endsWith('/catalog/set/update/') && fault === 'wrong-receipt') return { product_set_id: '999' };
      if (call.url.pathname.endsWith('/catalog/set/update/') && fault === 'transport') throw new Error('Synthetic lost response');
      if (written && call.url.pathname.endsWith('/catalog/set/get/') && fault === 'preservation-failure') return { list: [{ ...set, product_set_name: 'Renamed QA', conditions: { and: [] } }] };
      return undefined;
    });await expect(f.provider.applyWrite(f.op(await f.rename()), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: [S] } });expect(writes(f.calls)).toHaveLength(1);
  });
});
