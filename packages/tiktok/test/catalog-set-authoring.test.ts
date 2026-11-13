import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteKind, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTikTokCatalogAccessStore, catalogGrant } from '../src/catalog-access.js';
import { productSetCreate, productSetDelete, productSetUpdateConditions } from '../src/catalog-product-sets.js';
import { productSetConditions } from '../src/product-set-conditions.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// Current TikTok-owned catalog/set/create|update|delete and operator contracts
// fetched anonymously2026-11-05; product-set-authoring-manifest.json records hashes.
const A = '7111000000000000001', B = '111', C = '222', S = '333', NEW = '9007199254740993';
const input = { account_id: A, bc_id: B, catalog_id: C };
const selected = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const };
const original = { or: [{ field: 'price', operation: 'LT', value: '250' }] };
const updated = { and: [{ field: 'price', operation: 'GTE', value: 50.5 }, { field: 'brand', operation: 'I_CONTAIN', value: ['TikTok', 'QA'] }] };
type NativeSet = { catalog_id: string; product_set_id: string; product_set_name: string; conditions: Record<string, unknown>; product_count: number };
type Call = { url: URL; init: RequestInit; body?: Record<string, unknown> };
type State = { rows: Map<string, NativeSet>; writes: number };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(mode: 'read' | 'write' | 'none' = 'write', override?: (call: Call, state: State) => unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'adport-tiktok-set-authoring-'));dirs.push(dir);
  const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));if (mode !== 'none') await store.compareAndSet(selected, catalogGrant(selected).hash, mode);
  const catalog = { catalog_id: C, catalog_name: 'QA catalog', catalog_type: 'ECOM', bc_info: { bc_id: B }, catalog_conf: { country: 'DE', currency: 'EUR' } };
  const state: State = { rows: new Map([S, '444'].map(id => [id, { catalog_id: C, product_set_id: id, product_set_name: 'QA set ' + id, conditions: structuredClone(original), product_count: 2 }])), writes: 0 };
  const calls: Call[] = [];
  const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
    const call: Call = { url: new URL(String(raw)), init, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };calls.push(call);
    const custom = override?.(call, state);if (custom !== undefined) return custom instanceof Response ? custom : Response.json({ code: 0, data: custom });
    const path = call.url.pathname, body = call.body;
    if (path.endsWith('/catalog/get/')) return Response.json({ code: 0, data: { list: [catalog] } });
    if (path.endsWith('/catalog/set/get/')) return Response.json({ code: 0, data: { list: [...state.rows.values()].filter(row => !call.url.searchParams.has('product_set_id') || row.product_set_id === call.url.searchParams.get('product_set_id')) } });
    if (path.endsWith('/catalog/set/create/')) { state.writes++;state.rows.set(NEW, { catalog_id: C, product_set_id: NEW, product_set_name: String(body!.product_set_name), conditions: body!.conditions as Record<string, unknown>, product_count: 0 });return Response.json({ code: 0, data: { product_set_id: NEW, product_set_name: body!.product_set_name, product_count: 0 } }); }
    if (path.endsWith('/catalog/set/update/')) { state.writes++;const row = state.rows.get(String(body!.product_set_id))!;if (body!.conditions) row.conditions = body!.conditions as Record<string, unknown>;return Response.json({ code: 0, data: { product_set_id: row.product_set_id } }); }
    if (path.endsWith('/catalog/set/delete/')) { state.writes++;const ids = body!.product_set_ids as string[];for (const id of ids) state.rows.delete(id);return Response.json({ code: 0, data: { product_set_ids: [...ids].reverse() } }); }
    throw new Error('Unexpected fixture endpoint');
  }), { appId: 'inert', secret: 'inert' }, undefined, store);
  const op = (tool: string, kind: WriteKind, payload: Record<string, unknown>): WriteOperation => ({ provider: 'tiktok', accountId: A, tool, kind, payload });
  const createArgs = async () => ({ bc_id: B, catalog_id: C, product_set_name: 'Created <QA set>', conditions: updated, expected_catalog_hash: (await provider.catalogs.get(input)).catalog.configuration_hash, acknowledge_shared_effects: true });
  const targets = async () => (await provider.catalogs.productSets.list(input)).sets.map(row => ({ product_set_id: row.product_set_id, expected_configuration_hash: row.configuration_hash }));
  const runtime = () => createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: tiktokTools(provider) }] });
  return { dir, store, catalog, state, calls, provider, op, createArgs, targets, runtime };
}
const posts = (calls: Call[]) => calls.filter(call => call.init.method === 'POST');
const guard = { forcePausedCreation: true };

describe('TikTok native product-set condition bounds', () => {
  it('supports documented scalar/list/string operators and generic dotted fields without changing numeric units', () => {
    expect(productSetConditions.parse(updated)).toEqual(updated);
    expect(productSetConditions.parse({ or: [{ field: 'address.city', operation: 'I_PREFIX', value: ['Lon', 'Ber'] }, { field: 'item_id', operation: 'CONTAIN', value: ['9007199254740993123', 42] }] })).toHaveProperty('or');
  });
  it.each([
    { and: [], or: [] }, { and: [] }, {}, { and: original.or, or: original.or },
    { and: [{ field: 'price', operation: 'EQUAL', value: ['50'] }] },
    { and: [{ field: 'brand', operation: 'CONTAIN', value: 'QA' }] },
    { or: [{ field: 'brand', operation: 'PREFIX', value: [42] }] },
    { or: [{ field: 'price', operation: 'GT', value: Number.MAX_SAFE_INTEGER + 1 }] },
    { or: [{ field: 'price', operation: 'GT', value: Infinity }] },
    { or: [{ field: 'price', operation: 'UNKNOWN', value: '50' }] },
    { or: [{ field: 'arbitrary/path', operation: 'EQUAL', value: 'x' }] },
    { or: [{ field: 'title', operation: 'EQUAL', value: 'x', arbitrary: true }] },
  ])('rejects invalid native operator/value structure %#', value => { expect(productSetConditions.safeParse(value).success).toBe(false); });
  it('bounds combined values, rejects duplicate/delete-overflow IDs and requires fresh creation context', () => {
    expect(productSetConditions.safeParse({ and: [{ field: 'item_id', operation: 'CONTAIN', value: Array(1024).fill('x') }] }).success).toBe(true);
    expect(productSetConditions.safeParse({ and: [{ field: 'item_id', operation: 'CONTAIN', value: Array(1024).fill('x') }, { field: 'price', operation: 'GT', value: '0' }] }).success).toBe(false);
    const base = { bc_id: B, catalog_id: C, acknowledge_shared_effects: true }, target = { product_set_id: S, expected_configuration_hash: 'a'.repeat(64) };
    expect(productSetDelete.safeParse({ ...base, sets: [target, target] }).success).toBe(false);expect(productSetDelete.safeParse({ ...base, sets: Array.from({ length: 11 }, (_, n) => ({ ...target, product_set_id: String(n + 1) })) }).success).toBe(false);
    expect(productSetCreate.safeParse({ ...base, product_set_name: 'QA', conditions: updated }).success).toBe(false);
    expect(productSetUpdateConditions.safeParse({ ...base, product_set_id: S, expected_configuration_hash: 'a'.repeat(64), conditions: updated, product_set_name: 'Unapproved extra field' }).success).toBe(false);
  });
});

describe('TikTok guarded product-set creation', () => {
  it('previews without mutation then sends documented BC JSON once and independently verifies the known created ID', async () => {
    const f = await fixture(), args = { account_id: A, ...await f.createArgs() }, r = await f.runtime();
    const pending = await r.registry.call('tiktok_create_product_set', args, r.ctx) as { pending_operation_id: string; preview: { serverValidated: boolean } };
    expect(posts(f.calls)).toHaveLength(0);expect(pending.preview.serverValidated).toBe(false);
    await expect(r.registry.call('tiktok_create_product_set', { ...args, conditions: original, pending_operation_id: pending.pending_operation_id }, r.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const approved = { ...args, pending_operation_id: pending.pending_operation_id };expect(await r.registry.call('tiktok_create_product_set', approved, r.ctx)).toHaveProperty('result.resourceIds', [NEW]);
    const call = posts(f.calls)[0]!;expect(posts(f.calls)).toHaveLength(1);expect(call.url.pathname).toBe('/open_api/v1.3/catalog/set/create/');expect(call.body).toEqual({ bc_id: B, catalog_id: C, product_set_name: args.product_set_name, conditions: updated });expect(new Headers(call.init.headers).get('content-type')).toBe('application/json');expect(f.calls.at(-1)!.url.searchParams.get('product_set_id')).toBe(NEW);
    await expect(r.registry.call('tiktok_create_product_set', approved, r.ctx)).rejects.toThrow();expect(posts(f.calls)).toHaveLength(1);
  });
  it('rechecks catalog configuration and current permission before sending native creation', async () => {
    const f = await fixture(), args = await f.createArgs();f.catalog.catalog_conf.currency = 'USD';await expect(f.provider.previewWrite(f.op('tiktok_create_product_set', 'create', args), guard)).rejects.toThrow('Catalog configuration changed');
    const fresh = await f.createArgs(), grant = await f.store.get(selected);await f.store.compareAndSet(selected, grant.hash, 'read');await expect(f.provider.applyWrite(f.op('tiktok_create_product_set', 'create', fresh), guard)).rejects.toThrow('write access');expect(posts(f.calls)).toHaveLength(0);
  });
  it.each(['transport', 'missing-id', 'wrong-readback'])('does not retry %s and returns a created ID only when known', async fault => {
    const f = await fixture('write', (call, state) => {
      if (call.url.pathname.endsWith('/catalog/set/create/') && fault === 'transport') throw new Error('PRIVATE response');
      if (call.url.pathname.endsWith('/catalog/set/create/') && fault === 'missing-id') return {};
      if (state.writes && call.url.pathname.endsWith('/catalog/set/get/') && fault === 'wrong-readback') return { list: [{ ...state.rows.get(NEW)!, conditions: original }] };
      return undefined;
    });const promise = f.provider.applyWrite(f.op('tiktok_create_product_set', 'create', await f.createArgs()), guard);
    await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_ERROR', ...(fault === 'wrong-readback' ? { details: { resource_ids: [NEW] } } : {}) });expect(posts(f.calls)).toHaveLength(1);
  });
});

describe('TikTok guarded product-set filter replacement', () => {
  it('shows the shared live-ad selection effect and preserves name when replacing all conditions', async () => {
    const f = await fixture(), target = (await f.targets())[0]!, args = { bc_id: B, catalog_id: C, ...target, conditions: updated, acknowledge_shared_effects: true }, operation = f.op('tiktok_update_product_set_conditions', 'update', args);
    const preview = await f.provider.previewWrite(operation, guard);expect(preview.notes!.join(' ')).toContain('Existing ads');expect(preview.review?.fields[0]).toMatchObject({ before: expect.stringContaining('price is less than'), after: expect.stringContaining('brand matches any value') });expect(posts(f.calls)).toHaveLength(0);
    expect(await f.provider.applyWrite(operation, guard)).toHaveProperty('resourceIds', [target.product_set_id]);expect(posts(f.calls)[0]!.body).toEqual({ bc_id: B, catalog_id: C, product_set_id: target.product_set_id, conditions: updated });expect(f.state.rows.get(target.product_set_id)!.product_set_name).toBe('QA set ' + target.product_set_id);
  });
  it('checks all target configuration before apply and rejects any name/filter readback drift without replay', async () => {
    const f = await fixture(), target = (await f.targets())[0]!, args = { bc_id: B, catalog_id: C, ...target, conditions: updated, acknowledge_shared_effects: true };
    f.state.rows.get(target.product_set_id)!.product_set_name = 'Changed concurrently';await expect(f.provider.applyWrite(f.op('tiktok_update_product_set_conditions', 'update', args), guard)).rejects.toThrow('configuration changed');expect(posts(f.calls)).toHaveLength(0);
    const g = await fixture('write', (call, state) => state.writes && call.url.pathname.endsWith('/catalog/set/get/') ? { list: [{ ...state.rows.get(S)!, product_set_name: 'Unexpected rename' }] } : undefined), fresh = (await g.targets()).find(row => row.product_set_id === S)!;
    await expect(g.provider.applyWrite(g.op('tiktok_update_product_set_conditions', 'update', { ...args, ...fresh }), guard)).rejects.toMatchObject({ details: { resource_ids: [S] } });expect(posts(g.calls)).toHaveLength(1);
  });
});

describe('TikTok guarded batch product-set deletion', () => {
  it('previews each name/ID, accepts an unordered exact receipt and verifies absence with a complete catalog-set read', async () => {
    const f = await fixture(), targets = await f.targets(), args = { bc_id: B, catalog_id: C, sets: targets, acknowledge_shared_effects: true }, op = f.op('tiktok_delete_product_sets', 'remove', args);
    const preview = await f.provider.previewWrite(op, guard);expect(preview.review?.kind).toBe('remove');expect(preview.review?.fields).toHaveLength(2);expect(preview.notes!.join(' ')).toContain('Permanently');expect(posts(f.calls)).toHaveLength(0);
    expect(await f.provider.applyWrite(op, guard)).toHaveProperty('resourceIds', targets.map(row => row.product_set_id));expect(posts(f.calls)[0]!.body).toEqual({ bc_id: B, catalog_id: C, product_set_ids: targets.map(row => row.product_set_id) });expect(f.state.rows.size).toBe(0);expect(f.calls.at(-1)!.url.searchParams.has('product_set_id')).toBe(false);
  });
  it('rejects one stale target or an ungranted catalog before deleting any selected set', async () => {
    const f = await fixture(), sets = await f.targets(), payload = { bc_id: B, catalog_id: C, sets, acknowledge_shared_effects: true };
    f.state.rows.get(sets[1]!.product_set_id)!.conditions = updated;await expect(f.provider.applyWrite(f.op('tiktok_delete_product_sets', 'remove', payload), guard)).rejects.toThrow('configuration changed');
    await expect(f.provider.previewWrite(f.op('tiktok_delete_product_sets', 'remove', { ...payload, bc_id: '999' }), guard)).rejects.toThrow('write access');expect(posts(f.calls)).toHaveLength(0);
  });
  it.each(['partial-receipt', 'duplicate-receipt', 'remaining-set', 'partial-readback', 'transport'])('retains every target ID after %s without automatic replay', async fault => {
    const f = await fixture('write', (call, state) => {
      if (call.url.pathname.endsWith('/catalog/set/delete/')) {
        if (fault === 'transport') throw new Error('PRIVATE failure');
        if (fault === 'partial-receipt') { state.rows.delete(S);return { product_set_ids: [S] }; }
        if (fault === 'duplicate-receipt') return { product_set_ids: [S, S] };
        if (fault === 'remaining-set') return { product_set_ids: call.body!.product_set_ids };
      }
      if (state.writes && call.url.pathname.endsWith('/catalog/set/get/') && fault === 'partial-readback') return { list: [], page_info: { page: 1, total_page: 2 } };
      return undefined;
    });const targets = await f.targets(), ids = targets.map(row => row.product_set_id);
    await expect(f.provider.applyWrite(f.op('tiktok_delete_product_sets', 'remove', { bc_id: B, catalog_id: C, sets: targets, acknowledge_shared_effects: true }), guard)).rejects.toMatchObject({ details: { resource_ids: ids } });expect(posts(f.calls)).toHaveLength(1);
  });
  it('uses remove/update/create kinds and appropriate destructive hints from the single tool layer', async () => {
    const f = await fixture(), tools = tiktokTools(f.provider);
    expect(tools.find(tool => tool.name === 'tiktok_delete_product_sets')?.annotations.destructive).toBe(true);expect(tools.find(tool => tool.name === 'tiktok_update_product_set_conditions')?.annotations.destructive).toBe(true);expect(tools.find(tool => tool.name === 'tiktok_create_product_set')?.annotations.destructive).toBe(false);expect(tools.find(tool => tool.name === 'tiktok_rename_product_set')?.annotations.destructive).toBe(false);
  });
});
