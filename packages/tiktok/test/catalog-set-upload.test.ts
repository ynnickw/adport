import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, verifyMedia, type MediaResolver, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTikTokCatalogAccessStore, catalogGrant } from '../src/catalog-access.js';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

// Official doc1846770644217858 + its published SKU template, fetched 2026-11-05.
// Template cell data confirms the exact sku_id header. Assert multipart bytes, not guessed JSON.
const A = '7678335757387513873', B = '111', C = '222', S = '9007199254740993';
const selection = { account_id: A, bc_id: B, catalog_id: C }, scope = { accountId: A, businessId: B, resourceId: C, kind: 'catalog' as const };
const guard = { forcePausedCreation: true };
const hash = (bytes: Uint8Array, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(fault = '', csv = '\ufeffsku_id\r\n00012\r\n9007199254740993\r\n') {
  const dir = await mkdtemp(join(tmpdir(), 'adport-tiktok-set-upload-'));directories.push(dir);
  const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));await store.compareAndSet(scope, catalogGrant(scope).hash, 'write');
  const calls: Array<{ url: URL; init: RequestInit }> = [], reads: unknown[] = [];
  let bytes = Buffer.from(csv), written = false;
  const catalog = { catalog_id: C, catalog_name: 'QA', catalog_type: fault === 'non-ecom' ? 'HOTEL' : 'ECOM', bc_info: { bc_id: B }, catalog_conf: { currency: 'EUR' } };
  const media: MediaResolver = { async read(source, options) { reads.push({ source, options }); return verifyMedia(bytes, 'Product IDs', source.expected_sha256, options); } };
  const client = new TikTokClient({ accessToken: 'inert-token' }, async (raw, init = {}) => {
    const url = new URL(String(raw));calls.push({ url, init });
    const ok = (data: unknown) => Response.json({ code: 0, data });
    if (url.pathname.endsWith('/catalog/get/')) return ok({ list: [catalog] });
    if (url.pathname.endsWith('/catalog/set/get/')) {
      if (!written && fault !== 'duplicate-name') return ok({ list: [] });
      return ok({ list: [{ product_set_id: S, catalog_id: written && fault === 'wrong-parent' ? '999' : C, product_set_name: written && fault === 'wrong-name' ? 'Changed' : 'SKU set QA', conditions: {} }] });
    }
    if (url.pathname.endsWith('/catalog/set/upload/')) {
      written = true;
      if (fault === 'transport') throw new Error('private native error');
      if (fault === 'native-error') return Response.json({ code: 40001, message: 'private native error' });
      return ok({ product_set_id: S, product_set_name: fault === 'wrong-receipt-name' ? 'Wrong' : 'SKU set QA' });
    }
    throw new Error('Unexpected wire endpoint');
  });
  const provider = new TikTokAdsProvider(client, { appId: 'inert', secret: 'inert' }, media, store);
  const args = { ...selection, media_id: '11111111-1111-4111-8111-111111111111', expected_sha256: hash(bytes), product_set_name: 'SKU set QA', expected_catalog_hash: (await provider.catalogs.get(selection)).catalog.configuration_hash, acknowledge_shared_effects: true };
  const { account_id, ...payload } = args;
  const op: WriteOperation = { tool: 'tiktok_upload_product_set', provider: 'tiktok', kind: 'create', accountId: account_id, payload };
  return { provider, store, dir, calls, reads, args, op, bytes, replace: (value: string) => { bytes = Buffer.from(value); }, writes: () => calls.filter(call => call.init.method === 'POST') };
}

describe('checksum-bound TikTok CSV product-set upload', () => {
  it('uses one shared preview/apply gate, exact native multipart bytes/MD5 and independent scoped readback', async () => {
    const f = await fixture();
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] });
    const preview = await runtime.registry.call('tiktok_upload_product_set', f.args, runtime.ctx) as { pending_operation_id: string };
    expect(preview.pending_operation_id).toBeTruthy();expect(f.writes()).toHaveLength(0);
    await expect(runtime.registry.call('tiktok_upload_product_set', { ...f.args, product_set_name: 'Unapproved', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(await runtime.registry.call('tiktok_upload_product_set', { ...f.args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toHaveProperty('result.resourceIds', [S]);
    expect(f.writes()).toHaveLength(1);
    const write = f.writes()[0]!, form = write.init.body as FormData;
    expect(write.url.pathname).toBe('/open_api/v1.3/catalog/set/upload/');
    expect(new Headers(write.init.headers).get('Access-Token')).toBe('inert-token');expect(new Headers(write.init.headers).has('content-type')).toBe(false);
    expect([...form.keys()].sort()).toEqual(['bc_id', 'catalog_id', 'file', 'file_signature', 'product_set_name']);
    expect(form.get('bc_id')).toBe(B);expect(form.get('catalog_id')).toBe(C);expect(form.get('product_set_name')).toBe('SKU set QA');
    const file = form.get('file') as File;
    expect(file.name).toBe('product-set.csv');expect(file.type).toBe('text/csv');expect(Buffer.from(await file.arrayBuffer())).toEqual(f.bytes);expect(form.get('file_signature')).toBe(hash(f.bytes, 'md5'));
    expect(f.calls.at(-1)!.url.searchParams.get('product_set_id')).toBe(S);expect(f.reads.length).toBeGreaterThan(1);
  });
  it.each(['non-ecom', 'duplicate-name'])('rejects %s before any provider upload', async fault => {
    const f = await fixture(fault);await expect(f.provider.previewWrite(f.op, guard)).rejects.toMatchObject({ code: 'INVALID_INPUT' });expect(f.writes()).toHaveLength(0);
  });
  it.each(['SKU_ID\na\n', 'sku_id\n', 'sku_id\na\na\n', 'sku_id\n\n', 'sku_id,other\na,b\n', 'sku_id\n"broken', 'sku_id\n' + Array.from({ length: 5001 }, (_, n) => 'sku-' + n).join('\n')])('rejects invalid template %# before upload', async csv => {
    const f = await fixture('', csv);await expect(f.provider.previewWrite(f.op, guard)).rejects.toMatchObject({ code: 'INVALID_INPUT' });expect(f.writes()).toHaveLength(0);
  });
  it('checks the documented 28-character name, single source and catalog hash before upload', async () => {
    const f = await fixture();
    for (const payload of [{ ...f.op.payload, product_set_name: 'x'.repeat(29) }, { ...f.op.payload, file_path: '/private/test.csv' }, { ...f.op.payload, expected_catalog_hash: '0'.repeat(64) }]) await expect(f.provider.previewWrite({ ...f.op, payload }, guard)).rejects.toThrow();
    expect(f.writes()).toHaveLength(0);
  });
  it('rechecks file bytes and write grant when apply is requested', async () => {
    const f = await fixture();await f.provider.previewWrite(f.op, guard);
    f.replace('sku_id\nchanged\n');await expect(f.provider.applyWrite(f.op, guard)).rejects.toThrow('SHA-256');expect(f.writes()).toHaveLength(0);
    const other = await fixture();await other.provider.previewWrite(other.op, guard);
    const grant = await other.store.get(scope);await other.store.compareAndSet(scope, grant.hash, 'read');
    await expect(other.provider.applyWrite(other.op, guard)).rejects.toThrow('write access');expect(other.writes()).toHaveLength(0);
  });
  it.each(['wrong-receipt-name', 'wrong-parent', 'wrong-name', 'transport', 'native-error'])('never replays %s; retains a known created ID when available and hides provider bodies', async fault => {
    const f = await fixture(fault), error = await f.provider.applyWrite(f.op, guard).catch(error => error);
    expect(error.code).toBe('PROVIDER_ERROR');expect(f.writes()).toHaveLength(1);expect(JSON.stringify(error.toJSON())).not.toContain('private native error');
    if (!['transport', 'native-error'].includes(fault)) expect(error.details).toEqual({ resource_ids: [S] });
  });
});
