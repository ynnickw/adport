import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, verifyMedia, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';

// Provider-owned OpenAPI + chunked guide, docs2f701ee, fetched2026-11-03:
// OAuth1 UserToken is supported, JSON media is base64, distinct v2 upload paths.
const A = 'a1', U = '2716026447', ID = '2117427439936659456', KEY = `3_${ID}`;
const credentials = { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' };
type Call = { url: URL; init: RequestInit };
const writeCalls = (calls: Call[]) => calls.filter(v => v.init.method !== 'GET');
const op = (tool: string, payload: Record<string, unknown>): WriteOperation => ({ provider: 'x', accountId: A, tool, kind: 'create', payload });
const guard = { forcePausedCreation: true };
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(1024 * 1024 + 37, 65)]);
const hash = createHash('sha256').update(png).digest('hex');
const upload = { as_user_id: U, media_id: '11111111-1111-4111-8111-111111111111', expected_sha256: hash };
function fixture(handler?: (call: Call) => unknown) {
  const calls: Call[] = []; let bytes = Buffer.from(png), registered: Record<string, unknown> | undefined;
  const client = new XAdsClient(credentials, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call); const result = handler?.(call); if (result !== undefined) return result instanceof Response ? result : Response.json(result);
    const route = call.url.pathname;
    if (route === `/12/accounts/${A}`) return Response.json({ data: { id: A, name: 'Account', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false } });
    if (route.endsWith('/promotable_users')) return Response.json({ data: [{ id: 'pu1', user_id: U, promotable_user_type: 'FULL', deleted: false }], next_cursor: null });
    if (route.endsWith('/authenticated_user_access')) return Response.json({ data: { user_id: U, permissions: ['ACCOUNT_ADMIN'] } });
    if (route === '/2/media/upload/initialize') return Response.json({ data: { id: ID, media_key: KEY, expires_after_secs: 86400 } });
    if (route.endsWith('/append')) return Response.json({ data: { expires_at: Math.floor(Date.now() / 1000) + 86400 } });
    if (route.endsWith('/finalize') || route === '/2/media/upload') return Response.json({ data: { id: ID, media_key: KEY, size: png.byteLength, processing_info: { state: 'succeeded' } } });
    if (route === `/12/accounts/${A}/media_library` && init.method === 'POST') { registered = { ...Object.fromEntries(call.url.searchParams), media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', deleted: false }; return Response.json({ data: registered }); }
    if (route === `/12/accounts/${A}/media_library/${KEY}`) return registered ? Response.json({ data: registered }) : Response.json({}, { status: 404 });
    throw new Error(`Unexpected ${init.method} ${route}`);
  });
  const provider = new XAdsProvider(client, undefined, { read: async (input, options) => verifyMedia(bytes, 'qa.png', input.expected_sha256, options) });
  return { provider, calls, client, changeBytes: () => { bytes = Buffer.concat([bytes, Buffer.from([1])]); } };
}
const dirs: string[] = [];
afterEach(async () => { for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true }); });
const details = (result: Awaited<ReturnType<XAdsProvider['applyWrite']>>) => result.details as { resource_receipt: string; status: string };

describe('X current native v2 media upload and account registration', () => {
  it('previews checksum-bound bytes without initializing an upload, then signs distinct JSON chunk requests', async () => {
    const { provider, calls } = fixture(), operation = op('x_upload_media', upload); expect((await provider.previewWrite(operation, guard)).changes[0]).toContain(hash); expect(writeCalls(calls)).toEqual([]);
    const result = await provider.applyWrite(operation, guard), writes = writeCalls(calls); expect(result.resourceIds).toEqual([KEY]); expect(details(result)).toMatchObject({ status: 'succeeded', next_tool: 'x_register_uploaded_media' });
    expect(writes.map(v => v.url.href)).toEqual(['https://api.x.com/2/media/upload/initialize', `https://api.x.com/2/media/upload/${ID}/append`, `https://api.x.com/2/media/upload/${ID}/append`, `https://api.x.com/2/media/upload/${ID}/finalize`]);
    expect(JSON.parse(String(writes[0]!.init.body))).toEqual({ additional_owners: [U], media_category: 'tweet_image', media_type: 'image/png', total_bytes: png.byteLength });
    const chunks = writes.slice(1, -1).map(v => JSON.parse(String(v.init.body)) as { media: string; segment_index: number }); expect(chunks.map(v => v.segment_index)).toEqual([0, 1]); expect(Buffer.concat(chunks.map(v => Buffer.from(v.media, 'base64')))).toEqual(png); expect(writes.at(-1)!.init.body).toBeUndefined();
    for (const request of writes) { expect(request.init.redirect).toBe('error'); expect(request.url.search).toBe(''); expect(new Headers(request.init.headers).get('authorization')).toMatch(/^OAuth /); }
    const request = writes[0]!, percent = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`), oauth = Object.fromEntries(new Headers(request.init.headers).get('authorization')!.replace(/^OAuth /, '').split(', ').map(pair => { const i = pair.indexOf('='); return [decodeURIComponent(pair.slice(0, i)), decodeURIComponent(pair.slice(i + 2, -1))]; })), { oauth_signature, ...rest } = oauth;
    const normalized = Object.entries(rest).map(([k, v]) => `${percent(k)}=${percent(v)}`).sort().join('&'), base = ['POST', request.url.origin + request.url.pathname, normalized].map(percent).join('&'); expect(oauth_signature).toBe(createHmac('sha1', 'secret&access-secret').update(base).digest('base64'));
    expect(writes.some(v => v.url.pathname.includes('/media_library') || v.url.pathname.endsWith('/tweet'))).toBe(false);
  });
  it('checks exact SHA bytes again at apply and creates no upload for changed input', async () => {
    const { provider, calls, changeBytes } = fixture(), operation = op('x_upload_media', upload); await provider.previewWrite(operation, guard); changeBytes(); await expect(provider.applyWrite(operation, guard)).rejects.toThrow('SHA-256 mismatch'); expect(writeCalls(calls)).toEqual([]);
  });
  it('reviews the exact file and partial-upload warning without exposing upload receipts', async () => {
    const { provider, calls } = fixture(), preview = await provider.previewWrite(op('x_upload_media', upload), guard);
    expect(writeCalls(calls)).toEqual([]);
    expect(preview.review).toMatchObject({ title: 'Upload image', subject: 'qa.png', fields: [{ label: 'Type', after: 'image/png' }, { label: 'Size', after: `${png.length.toLocaleString('en-US')} bytes` }, { label: 'Author', after: U }, { label: 'SHA-256', after: hash }], notices: expect.arrayContaining(['X validates on apply. An incomplete upload may remain until it expires.']) });
    const receipt = details(await provider.applyWrite(op('x_upload_media', upload), guard)).resource_receipt;
    const registration = await provider.previewWrite(op('x_register_uploaded_media', { resource_receipt: receipt, name: 'QA', file_name: 'qa.png' }), guard);
    expect(registration.review).toMatchObject({ title: 'Add media to X library', subject: 'QA', fields: [{ label: 'Media', after: KEY }, { label: 'File name', after: 'qa.png' }, { label: 'SHA-256', after: hash }] });
    expect(JSON.stringify(registration.review)).not.toContain(receipt);
  });
  it('binds status reads to the signed account/author, rejects tampering, expiry and another grant', async () => {
    const { provider, calls, client } = fixture(), result = await provider.applyWrite(op('x_upload_media', upload), guard), receipt = details(result).resource_receipt;
    expect(await provider.mediaUploads.status(A, receipt)).toMatchObject({ state: 'succeeded', bound: { media_id: ID, media_key: KEY } }); const status = calls.at(-1)!; expect(status.url.href).toBe(`https://api.x.com/2/media/upload?media_id=${ID}&command=STATUS`);
    const before = calls.length;
    for (const value of [receipt.slice(0, -1) + (receipt.endsWith('A') ? 'B' : 'A'), client.resourceReceipt({ ...(client.verifyResourceReceipt(receipt) as object), expires_at: 1 })]) await expect(provider.mediaUploads.status(A, value)).rejects.toThrow();
    await expect(provider.mediaUploads.status('other', receipt)).rejects.toThrow('mismatched account'); expect(calls).toHaveLength(before);
    const other = new XAdsProvider(new XAdsClient({ ...credentials, accessTokenSecret: 'another-grant' }, async () => { throw new Error('No request'); })); await expect(other.mediaUploads.status(A, receipt)).rejects.toThrow('invalid resource receipt');
  });
  it('rejects a noncanonical signature encoding even when it decodes to the same HMAC bytes', () => {
    const { client, calls } = fixture(), receipt = client.resourceReceipt({ kind: 'encoding-test' }), [payload, signature] = receipt.split('.'), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias = signature!.slice(0, -1) + alphabet[alphabet.indexOf(signature!.at(-1)!) + 1];
    expect(Buffer.from(alias, 'base64url')).toEqual(Buffer.from(signature!, 'base64url'));
    expect(() => client.verifyResourceReceipt(`${payload}.${alias}`)).toThrow('invalid resource receipt');
    expect(calls).toEqual([]);
  });
  it('exposes pending processing without claiming readiness and prevents early registration', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/finalize') || call.url.pathname === '/2/media/upload' ? { data: { id: ID, media_key: KEY, processing_info: { state: 'pending', check_after_secs: 7 } } } : undefined), result = await provider.applyWrite(op('x_upload_media', upload), guard), receipt = details(result).resource_receipt;
    expect(details(result)).toMatchObject({ status: 'pending', next_tool: 'x_media_upload_status' }); await expect(provider.previewWrite(op('x_register_uploaded_media', { resource_receipt: receipt, name: 'QA' }), guard)).rejects.toThrow('not processed'); expect(writeCalls(calls)).toHaveLength(4);
  });
  it('registers only a ready approved upload with native signed query fields and full library readback', async () => {
    const { provider, calls } = fixture(), receipt = details(await provider.applyWrite(op('x_upload_media', upload), guard)).resource_receipt, operation = op('x_register_uploaded_media', { resource_receipt: receipt, name: 'QA + Ü', file_name: 'qa.png' });
    const before = writeCalls(calls).length; await provider.previewWrite(operation, guard); expect(writeCalls(calls)).toHaveLength(before); const result = await provider.applyWrite(operation, guard); expect(result).toMatchObject({ resourceIds: [KEY], details: { status: 'TRANSCODE_COMPLETED' } });
    const request = writeCalls(calls).at(-1)!; expect(request.url.origin).toBe('https://ads-api.x.com'); expect(Object.fromEntries(request.url.searchParams)).toEqual({ media_key: KEY, name: 'QA + Ü', file_name: 'qa.png' }); expect(request.init.body).toBeUndefined();
    await expect(provider.previewWrite(operation, guard)).rejects.toThrow('already registered'); expect(writeCalls(calls)).toHaveLength(before + 1);
  });
  it('retains upload IDs/receipt after failed chunks, never retries them or registers partial sessions', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/append') ? new Response('', { status: 503 }) : undefined), error = await provider.applyWrite(op('x_upload_media', upload), guard).catch(error => error);
    expect(error.details).toMatchObject({ resource_ids: [KEY], resource_receipt: expect.any(String) }); expect(writeCalls(calls)).toHaveLength(2); expect(writeCalls(calls).some(v => v.url.pathname.endsWith('/finalize'))).toBe(false);
    await expect(provider.previewWrite(op('x_register_uploaded_media', { resource_receipt: error.details.resource_receipt, name: 'QA' }), guard)).rejects.toThrow('incomplete upload');
  });
  it.each(['id', 'key', 'size', 'failed'])('rejects a mismatched/failed finalize receipt: %s', async mode => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/finalize') ? { data: { id: mode === 'id' ? '999' : ID, media_key: mode === 'key' ? '3_999' : KEY, size: mode === 'size' ? 3 : png.byteLength, processing_info: { state: mode === 'failed' ? 'failed' : 'succeeded' } } } : undefined), error = await provider.applyWrite(op('x_upload_media', upload), guard).catch(error => error); expect(error.details.resource_ids).toEqual([KEY]); expect(writeCalls(calls)).toHaveLength(4);
  });
  it('retains registration IDs after a native readback mismatch and rejects non-404 ownership failures', async () => {
    let register = false;
    const { provider, calls } = fixture(call => { if (call.init.method === 'POST' && call.url.pathname.endsWith('/media_library')) { register = true; return { data: { media_key: KEY } }; } if (register && call.url.pathname.endsWith(`/media_library/${KEY}`)) return { data: { media_key: KEY, media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', name: 'Unapproved', deleted: false } }; return undefined; });
    const receipt = details(await provider.applyWrite(op('x_upload_media', upload), guard)).resource_receipt;
    await expect(provider.applyWrite(op('x_register_uploaded_media', { resource_receipt: receipt, name: 'Approved' }), guard)).rejects.toMatchObject({ details: { resource_ids: [KEY] } }); expect(writeCalls(calls)).toHaveLength(5);
    const denied = fixture(call => call.url.pathname.endsWith(`/media_library/${KEY}`) ? new Response('', { status: 403 }) : undefined), token = details(await denied.provider.applyWrite(op('x_upload_media', upload), guard)).resource_receipt; await expect(denied.provider.previewWrite(op('x_register_uploaded_media', { resource_receipt: token, name: 'QA' }), guard)).rejects.toThrow('HTTP 403'); expect(writeCalls(denied.calls)).toHaveLength(4);
  });
  it('constrains native media paths before signing or sending requests', async () => {
    const { client, calls } = fixture(); for (const path of ['https://attacker.example', 'media/upload/../users', 'media/upload/1/metadata', 'media/upload']) await expect(client.mediaRequest('POST', path, z.unknown())).rejects.toThrow('unsupported native media route'); expect(calls).toEqual([]);
  });
  it('uses shared exact pending tokens and protected accounts for checksum-bound uploads', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'x-media-')); dirs.push(directory); const { provider, calls } = fixture(), audit = new AuditLog(path.join(directory, 'audit')), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(directory, 'pending')), audit), runtime = await createContext({ engine, providerModules: [{ provider, tools: xTools(provider) }] });
    const args = { account_id: A, ...upload }, pending = await runtime.registry.call('x_upload_media', args, runtime.ctx) as { pending_operation_id: string }; expect(writeCalls(calls)).toEqual([]); await expect(runtime.registry.call('x_upload_media', { ...args, expected_sha256: '0'.repeat(64), pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('differs'); await runtime.registry.call('x_upload_media', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx); expect(writeCalls(calls)).toHaveLength(4);
    const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(directory, 'blocked')), audit); await expect(protectedEngine.validate(provider, op('x_upload_media', upload))).rejects.toThrow('protected');
  });
});
