import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { PinterestAdsClient, PINTEREST_TOKEN_URL } from '../src/client.js';
import { PinterestAdsProvider } from '../src/provider.js';
import { pinterestTools } from '../src/tools.js';

// Synthetic wire fixtures checked against Pinterest-owned OpenAPI 5.28.0,
// commit 2503147fd9f86f26230891b8534b678c31cc849a, fetched 2026-11-05:
// https://github.com/pinterest/api-description/blob/2503147fd9f86f26230891b8534b678c31cc849a/v5/openapi.json
const A = '549000000001', C = '549000000002', F = '549000000003', R = '549000000004';
const guard = { forcePausedCreation: true }, date = '2026-11-05T00:00:00Z';
const catalog = { id: C, name: 'QA catalog', catalog_type: 'RETAIL', created_at: date, updated_at: date };
const source = 'https://feed.example.test/private/feed.csv?capability=private-source-capability';
const auth = { username: 'private-feed-user', password: 'private-feed-password' };
// Native retail feed responses omit catalog_id. Membership comes from the catalog-scoped finder.
const feed = { id: F, catalog_type: 'RETAIL', name: 'QA feed', status: 'INACTIVE', format: 'CSV', default_locale: 'en-US', default_country: 'US', location: source, credentials: auth, created_at: date, updated_at: date };
const result = { id: R, status: 'COMPLETED', created_at: date, updated_at: date, ingestion_details: {}, product_counts: { original: 1 }, validation_details: {} };
type Call = { url: URL; init: RequestInit };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture(handler?: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new PinterestAdsClient({ clientId: 'client', clientSecret: 'client-secret', refreshToken: 'refresh' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === PINTEREST_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.url.pathname === `/v5/ad_accounts/${A}`) return Response.json({ id: A, owner: { username: 'QA_OWNER' } });
    if (init.method === 'GET') {
      if (call.url.pathname === '/v5/catalogs') return Response.json({ items: [catalog], bookmark: null });
      if (call.url.pathname === '/v5/catalogs/feeds') return Response.json({ items: [feed] });
      if (call.url.pathname === `/v5/catalogs/feeds/${F}`) return Response.json(feed);
      if (call.url.pathname === `/v5/catalogs/feeds/${F}/processing_results`) return Response.json({ items: [result] });
      if (call.url.pathname === `/v5/catalogs/processing_results/${R}/item_issues`) return Response.json({ items: [{ item_number: 1, item_id: 'synthetic-sku', errors: { TITLE_MISSING: 'Title is required' }, warnings: {} }] });
    }
    throw new Error(`Unexpected ${init.method} ${call.url.pathname}`);
  });
  return { provider: new PinterestAdsProvider(client), calls };
}
const writes = (calls: Call[]) => calls.filter(c => c.init.method !== 'GET' && c.url.href !== PINTEREST_TOKEN_URL);
const body = (call: Call) => JSON.parse(String(call.init.body));
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ provider: 'pinterest', accountId: A, tool, payload, kind });
async function bound(provider: PinterestAdsProvider) { return { catalog_id: C, feed_id: F, expected_snapshot_hash: (await provider.catalogs.getFeed(A, C, F)).feed.snapshot_hash }; }
async function creation(provider: PinterestAdsProvider, extra = {}) { return { expected_context_hash: (await provider.catalogs.catalogs({ account_id: A, page_size: 25 })).context_hash, feed: { catalog_id: C, catalog_type: 'RETAIL', name: 'QA feed', format: 'CSV', default_locale: 'en-US', default_country: 'US', location: source, credentials: auth }, confirm_source_access: true, ...extra }; }
function privateAbsent(value: unknown) { const text = JSON.stringify(value); for (const secret of [source, auth.username, auth.password, 'private-source-capability']) expect(text).not.toContain(secret); }

describe('Pinterest advertiser-owned catalogs and feeds', () => {
  it('defines eleven unique lazy tools with scoped pagination and guarded write hints', () => {
    const tools = pinterestTools(new Proxy({} as PinterestAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(new Set(tools.map(t => t.name)).size).toBe(tools.length);
    const names = ['pinterest_catalogs', 'pinterest_get_catalog', 'pinterest_feeds', 'pinterest_get_feed', 'pinterest_feed_processing_results', 'pinterest_feed_item_issues', 'pinterest_create_catalog', 'pinterest_create_feed', 'pinterest_update_feed', 'pinterest_delete_feed', 'pinterest_ingest_feed'];
    expect(tools.filter(t => names.includes(t.name))).toHaveLength(11);
    expect(tools.find(t => t.name === 'pinterest_feeds')?.pagination).toEqual({ cursorInput: 'bookmark' });
    expect(tools.find(t => t.name === 'pinterest_create_catalog')?.annotations).toMatchObject({ readOnly: false, destructive: false });
    expect(tools.find(t => t.name === 'pinterest_delete_feed')?.annotations).toMatchObject({ readOnly: false, destructive: true });
  });
  it('always scopes catalog lookup to the selected advertiser without inventing GET-by-ID', async () => {
    const { provider, calls } = fixture();
    expect(await provider.catalogs.getCatalog(A, C)).toMatchObject({ catalog, truncated: false });
    const list = calls.find(c => c.url.pathname === '/v5/catalogs')!;
    expect(Object.fromEntries(list.url.searchParams)).toEqual({ ad_account_id: A, page_size: '250' });
    expect(calls.some(c => c.url.pathname === `/v5/catalogs/${C}`)).toBe(false); expect(writes(calls)).toEqual([]);
  });
  it('binds context to advertiser owner and rejects a mismatched advertiser', async () => {
    let owner = 'QA_OWNER';
    const { provider } = fixture(c => c.url.pathname === `/v5/ad_accounts/${A}` ? { id: A, owner: { username: owner } } : undefined);
    const first = await provider.catalogs.catalogs({ account_id: A, page_size: 25 }); owner = 'qa_owner';
    expect((await provider.catalogs.catalogs({ account_id: A, page_size: 25 })).context_hash).toBe(first.context_hash);
    owner = 'changed'; expect((await provider.catalogs.catalogs({ account_id: A, page_size: 25 })).context_hash).not.toBe(first.context_hash);
    const foreign = fixture(c => c.url.pathname === `/v5/ad_accounts/${A}` ? { id: C, owner: { username: owner } } : undefined);
    await expect(foreign.provider.catalogs.catalogs({ account_id: A, page_size: 25 })).rejects.toThrow('advertiser ID');
  });
  it('returns safe feed records, retail membership, fingerprints and native bookmark continuation', async () => {
    const { provider, calls } = fixture(c => c.url.pathname === '/v5/catalogs/feeds' ? { items: [feed], bookmark: 'next' } : undefined);
    const rows = await provider.catalogs.feeds({ account_id: A, catalog_id: C, page_size: 1, bookmark: 'previous' });
    expect(rows).toMatchObject({ items: [{ id: F, credentials_configured: true, source_origin: 'https://feed.example.test' }], next_cursor: 'next', truncated: true });
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ ad_account_id: A, catalog_id: C, page_size: '1', bookmark: 'previous' }); privateAbsent(rows);
  });
  it.each([{ items: [], bookmark: 'next' }, { items: [catalog], bookmark: 'same' }, { items: [catalog, catalog] }])('rejects empty, repeated or oversized catalog pages %#', async response => {
    const { provider } = fixture(c => c.url.pathname === '/v5/catalogs' ? response : undefined);
    await expect(provider.catalogs.catalogs({ account_id: A, page_size: 1, bookmark: 'same' })).rejects.toThrow('pagination');
  });
  it('does not mutate a missing catalog/feed or an inconsistent type/catalog identity', async () => {
    for (const response of [{ items: [] }, { items: [{ ...feed, catalog_type: 'HOTEL' }] }, { items: [{ ...feed, catalog_id: R }] }]) {
      const { provider, calls } = fixture(c => c.url.pathname === '/v5/catalogs/feeds' ? response : undefined);
      await expect(provider.catalogs.getFeed(A, C, F)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
    }
    const missing = fixture(c => c.url.pathname === '/v5/catalogs' ? { items: [] } : undefined);
    await expect(missing.provider.catalogs.getFeed(A, C, F)).rejects.toThrow('catalog was not found');
  });
  it('keeps snapshot stable across volatile timestamps but detects source/settings changes', async () => {
    let current = { ...feed };
    const { provider } = fixture(c => c.url.pathname === `/v5/catalogs/feeds/${F}` ? current : undefined);
    const first = await bound(provider); current = { ...current, updated_at: '2026-11-06T00:00:00Z' };
    expect((await bound(provider)).expected_snapshot_hash).toBe(first.expected_snapshot_hash);
    current = { ...current, location: source + '-changed' }; expect((await bound(provider)).expected_snapshot_hash).not.toBe(first.expected_snapshot_hash);
    await expect(provider.previewWrite(op('pinterest_update_feed', { ...first, changes: { name: 'New' } }, 'update'), guard)).rejects.toThrow('configuration changed');
  });
  it('creates an empty catalog only after context validation and reads it back', async () => {
    let created = false;
    const { provider, calls } = fixture(c => {
      if (c.url.pathname !== '/v5/catalogs') return;
      if (c.init.method === 'POST') { created = true; return catalog; }
      return { items: created ? [catalog] : [] };
    });
    const input = { expected_context_hash: (await provider.catalogs.catalogs({ account_id: A, page_size: 25 })).context_hash, name: catalog.name, catalog_type: 'RETAIL' };
    expect((await provider.previewWrite(op('pinterest_create_catalog', input), guard)).serverValidated).toBe(false); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(op('pinterest_create_catalog', input), guard)).toMatchObject({ applied: true, resourceIds: [C] });
    expect(body(writes(calls)[0]!)).toEqual({ name: catalog.name, catalog_type: 'RETAIL' }); expect(writes(calls)[0]!.url.search).toBe(`?ad_account_id=${A}`);
  });
  it('defaults a new retail feed to INACTIVE, hides source credentials and sends exact native JSON once', async () => {
    const { provider, calls } = fixture(c => c.init.method === 'POST' ? feed : undefined), input = await creation(provider);
    privateAbsent(await provider.previewWrite(op('pinterest_create_feed', input), guard)); expect(writes(calls)).toEqual([]);
    const applied = await provider.applyWrite(op('pinterest_create_feed', input), guard); expect(applied.resourceIds).toEqual([F]); expect(applied.warnings?.join(' ')).toContain('not proof'); privateAbsent(applied);
    const request = writes(calls)[0]!; expect(request.url.pathname).toBe('/v5/catalogs/feeds'); expect(request.url.search).toBe(`?ad_account_id=${A}`);
    expect(body(request)).toEqual({ ...input.feed, status: 'INACTIVE' }); expect(request.init.headers).toMatchObject({ authorization: 'Bearer access', 'content-type': 'application/json' }); expect(writes(calls)).toHaveLength(1);
  });
  it('requires source consent and separate publication confirmation for ACTIVE creation', async () => {
    const { provider, calls } = fixture(), input = await creation(provider);
    await expect(provider.previewWrite(op('pinterest_create_feed', { ...input, confirm_source_access: false }), guard)).rejects.toThrow();
    await expect(provider.previewWrite(op('pinterest_create_feed', { ...input, feed: { ...input.feed, status: 'ACTIVE' } }), guard)).rejects.toThrow('confirm publication'); expect(writes(calls)).toEqual([]);
  });
  it('patches only requested fields and catalog_type, retaining omitted source/auth settings', async () => {
    let current = { ...feed };
    const { provider, calls } = fixture(c => {
      if (c.init.method === 'PATCH') { current = { ...current, ...body(c) }; return current; }
      if (c.url.pathname === `/v5/catalogs/feeds/${F}`) return current;
    });
    const input = { ...await bound(provider), changes: { name: 'Renamed' } };
    privateAbsent(await provider.previewWrite(op('pinterest_update_feed', input, 'update'), guard)); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(op('pinterest_update_feed', input, 'update'), guard)).toMatchObject({ resourceIds: [F] }); expect(body(writes(calls)[0]!)).toEqual({ catalog_type: 'RETAIL', name: 'Renamed' });
  });
  it('clears authentication explicitly and verifies native absence without echoing old values', async () => {
    let current: Record<string, unknown> = { ...feed };
    const { provider, calls } = fixture(c => {
      if (c.init.method === 'PATCH') { current = { ...current, credentials: null }; return current; }
      if (c.url.pathname === `/v5/catalogs/feeds/${F}`) return current;
    });
    const input = { ...await bound(provider), changes: { credentials: null } };
    privateAbsent(await provider.previewWrite(op('pinterest_update_feed', input, 'update'), guard));
    await provider.applyWrite(op('pinterest_update_feed', input, 'update'), guard); expect(body(writes(calls)[0]!)).toEqual({ catalog_type: 'RETAIL', credentials: null });
  });
  it('permits an ACTIVE name-only rename while requiring consent for processing-affecting changes', async () => {
    const { provider, calls } = fixture(c => c.url.pathname === `/v5/catalogs/feeds/${F}` ? { ...feed, status: 'ACTIVE' } : undefined);
    const reference = await bound(provider);
    await provider.previewWrite(op('pinterest_update_feed', { ...reference, changes: { name: 'New' } }, 'update'), guard);
    await expect(provider.previewWrite(op('pinterest_update_feed', { ...reference, changes: { format: 'TSV' } }, 'update'), guard)).rejects.toThrow('confirm publication');
    await expect(provider.previewWrite(op('pinterest_update_feed', { ...reference, changes: { credentials: auth } }, 'update'), guard)).rejects.toThrow('source-access'); expect(writes(calls)).toEqual([]);
  });
  it.each([400, 401, 409, 422, 500])('never retries a failed native feed write (%s) and removes source/auth echoes', async status => {
    const { provider, calls } = fixture(c => c.init.method === 'POST' ? Response.json({ code: 1, message: `Invalid ${source} ${auth.username} ${auth.password}` }, { status }) : undefined);
    try { await provider.applyWrite(op('pinterest_create_feed', await creation(provider)), guard); throw new Error('Expected rejection'); }
    catch (error) { privateAbsent({ message: (error as Error).message, details: (error as { details?: unknown }).details }); }
    expect(writes(calls)).toHaveLength(1);
  });
  it('reports unconfirmed readback with resource IDs, without replaying creation', async () => {
    const { provider, calls } = fixture(c => c.init.method === 'POST' ? { ...feed, id: R } : undefined);
    await expect(provider.applyWrite(op('pinterest_create_feed', await creation(provider)), guard)).rejects.toMatchObject({ details: { resource_ids: [R] } }); expect(writes(calls)).toHaveLength(1);
  });
  it('requires deletion confirmation, sends bodyless DELETE and reconciles native absence', async () => {
    let removed = false;
    const { provider, calls } = fixture(c => {
      if (c.init.method === 'DELETE') { removed = true; return new Response(null, { status: 204 }); }
      if (removed && c.url.pathname === '/v5/catalogs/feeds') return { items: [] };
    });
    const input = await bound(provider);
    await expect(provider.previewWrite(op('pinterest_delete_feed', input, 'remove'), guard)).rejects.toThrow();
    const value = { ...input, confirm_permanent_deletion: true };
    await provider.previewWrite(op('pinterest_delete_feed', value, 'remove'), guard); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(op('pinterest_delete_feed', value, 'remove'), guard)).toMatchObject({ resourceIds: [F] }); expect(writes(calls)[0]!.init.body).toBeUndefined();
  });
  it.each(['PROCESSING', 'FAILED', 'COMPLETED'])('keeps native ingestion status honest (%s), with no body and no retries', async status => {
    const { provider, calls } = fixture(c => c.url.pathname.endsWith('/ingest') ? { id: R, feed_id: F, status, created_at: date } : undefined);
    const reference = await bound(provider);
    await expect(provider.previewWrite(op('pinterest_ingest_feed', reference, 'update'), guard)).rejects.toThrow();
    const input = { ...reference, confirm_source_access: true, confirm_publication: true };
    await provider.previewWrite(op('pinterest_ingest_feed', input, 'update'), guard); expect(writes(calls)).toEqual([]);
    const value = await provider.applyWrite(op('pinterest_ingest_feed', input, 'update'), guard);
    expect(value.details).toMatchObject({ processed: status === 'COMPLETED', native_status: status, ingestion_id: R, feed_id: F, status: status === 'PROCESSING' ? 'ACCEPTED_FOR_PROCESSING' : status }); expect(writes(calls)).toHaveLength(1); expect(writes(calls)[0]!.init.body).toBeUndefined(); privateAbsent(value);
  });
  it('verifies processing-result membership, applies mutually exclusive filters and redacts source diagnostics', async () => {
    const { provider, calls } = fixture(c => c.url.pathname.endsWith('/item_issues') ? { items: [{ item_number: 1, errors: { SOURCE: `Cannot read ${source} ${auth.password}` }, credentials: auth, location: source }] } : undefined);
    const value = await provider.catalogs.issues({ account_id: A, catalog_id: C, feed_id: F, processing_result_id: R, page_size: 5, item_numbers: [1, 2] });
    privateAbsent(value); expect(value.notes.join(' ')).toContain('samples'); expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ ad_account_id: A, item_numbers: '1,2', page_size: '5' });
    await expect(provider.catalogs.issues({ account_id: A, catalog_id: C, feed_id: F, processing_result_id: C, page_size: 5 })).rejects.toThrow('not found');
    const tool = pinterestTools(provider).find(t => t.name === 'pinterest_feed_item_issues')!;
    expect(tool.input.safeParse({ account_id: A, catalog_id: C, feed_id: F, processing_result_id: R, item_numbers: [1], item_validation_issue: 'TITLE_MISSING' }).success).toBe(false);
  });
  it('routes feed changes through single-use policy approval, with safe preview and append-only audit', async () => {
    const { provider, calls } = fixture(c => c.init.method === 'POST' ? feed : undefined);
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-catalog-policy-')); dirs.push(dir);
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))), providerModules: [{ provider, tools: pinterestTools(provider) }] });
    const args = { account_id: A, ...await creation(provider) };
    const preview = await runtime.registry.call('pinterest_create_feed', args, runtime.ctx) as { pending_operation_id: string };
    privateAbsent(preview); expect(writes(calls)).toEqual([]);
    await runtime.registry.call('pinterest_create_feed', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    await expect(runtime.registry.call('pinterest_create_feed', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow(); expect(writes(calls)).toHaveLength(1);
    for (const file of await readdir(path.join(dir, 'audit'))) privateAbsent(await readFile(path.join(dir, 'audit', file), 'utf8'));
  });
});
