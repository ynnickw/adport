import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { TikTokClient } from '../src/client.js';
import { TikTokCustomAudiences } from '../src/custom-audiences.js';
import { tiktokTools } from '../src/tools.js';
import { audienceFileRecords } from '../src/audience-file.js';
import { customerAudienceCreate, customerAudienceUpdate, customAudiencesDelete } from '../src/custom-audience-schemas.js';
import { customAudienceFixture, CUSTOM_ACCOUNT, CUSTOM_AUDIENCE, NEW_CUSTOM_AUDIENCE, syntheticHash } from './custom-audience-fixture.js';

// Published TikTok v1.3 docs + official SDK f809c396, fetched2026-11-06.
// Native envelopes, private identifiers and hosts in these cases are synthetic.
type Row = Record<string, any>;
const guard = { forcePausedCreation: true }, uploadTool = 'tiktok_upload_audience_file', createTool = 'tiktok_create_customer_audience', renameTool = 'tiktok_rename_custom_audience', membersTool = 'tiktok_update_customer_audience_users', deleteTool = 'tiktok_delete_custom_audiences';
const op = (tool: string, payload: Row): WriteOperation => ({ tool, provider: 'tiktok', accountId: CUSTOM_ACCOUNT, kind: tool === deleteTool ? 'remove' : [renameTool, membersTool].includes(tool) ? 'update' : 'create', payload });
const dirs: string[] = [];afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const rename = async (f: ReturnType<typeof customAudienceFixture>) => ({ custom_audience_id: CUSTOM_AUDIENCE, expected_snapshot_hash: (await f.get()).audience.snapshot_hash, custom_audience_name: 'Renamed audience', acknowledge_shared_effects: true as const });

describe('TikTok hashed customer files', () => {
  it.each(['EMAIL_SHA256', 'PHONE_SHA256', 'FIRST_SHA256', 'IDFA_SHA256', 'GAID_SHA256'] as const)('validates prehashed %s data without changing bytes', type => { const bytes = Buffer.from(syntheticHash.toUpperCase() + '\r\n');expect(audienceFileRecords(bytes, type)).toBe(1);expect(bytes.toString()).toBe(syntheticHash.toUpperCase() + '\r\n'); });
  it.each(['FIRST_MD5', 'IDFA_MD5', 'GAID_MD5'] as const)('validates documented legacy %s length', type => { expect(audienceFileRecords(Buffer.from('a'.repeat(32)), type)).toBe(1);expect(() => audienceFileRecords(Buffer.from(syntheticHash), type)).toThrow(); });
  it('validates case-insensitive mixed hashed headers and permits missing cells but not empty records', () => {
    expect(audienceFileRecords(Buffer.from('EMAIL_SHA256,phone_SHA256,MAID_MD5\n' + syntheticHash + ',,' + 'a'.repeat(32) + '\n,' + syntheticHash + ',\n'), 'MULTIPLE_TYPES')).toBe(2);
    for (const value of ['MAID\nraw-id', 'email_SHA256,EMAIL_sha256\n' + syntheticHash + ',' + syntheticHash, 'phone_SHA256\n', 'phone_SHA256,email_SHA256\n,\n', 'phone_SHA256\nnot-a-hash']) expect(() => audienceFileRecords(Buffer.from(value), 'MULTIPLE_TYPES')).toThrow();
  });
  it.each(['person@example.test', '+442071838750', 'EMAIL_SHA256\n' + syntheticHash, syntheticHash + ',extra', '', ' ' + syntheticHash])('refuses raw/misdeclared source data without echoing values', value => { let error: unknown;try { audienceFileRecords(Buffer.from(value), 'EMAIL_SHA256'); } catch (caught) { error = caught; }expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('person@example.test');expect(String(error)).not.toContain('+442071838750');expect(String(error)).not.toContain(syntheticHash); });
  it('bounds CSV rows and rejects invalid UTF8/quoting', () => { expect(() => audienceFileRecords(Buffer.from((syntheticHash + '\n').repeat(100_001)), 'EMAIL_SHA256')).toThrow();expect(() => audienceFileRecords(new Uint8Array([0xff]), 'EMAIL_SHA256')).toThrow();expect(() => audienceFileRecords(Buffer.from('"' + syntheticHash), 'EMAIL_SHA256')).toThrow(); });
  it('keeps local preview private and sends the native multipart signature, exact bytes and encryption type once', async () => {
    const f = customAudienceFixture(), args = f.upload(), preview = await f.provider.previewWrite(op(uploadTool, args), guard);expect(f.writes()).toHaveLength(0);expect(JSON.stringify(preview)).not.toContain(syntheticHash);expect(preview.review?.title).toBe('Upload customer audience file');
    const result = await f.provider.applyWrite(op(uploadTool, args), guard), call = f.writes()[0]!;expect(f.writes()).toHaveLength(1);expect(call.url.pathname).toBe('/open_api/v1.3/dmp/custom_audience/file/upload/');expect(call.url.searchParams.size).toBe(0);expect(call.init.headers).toMatchObject({ 'Access-Token': 'synthetic-private-access' });expect(call.init.headers).not.toHaveProperty('content-type');
    expect([...call.form!.keys()].sort()).toEqual(['advertiser_id', 'calculate_type', 'file', 'file_signature']);expect(call.form!.get('advertiser_id')).toBe(CUSTOM_ACCOUNT);expect(call.form!.get('file_signature')).toBe(createHash('md5').update(f.state.file).digest('hex'));expect(Buffer.from(await (call.form!.get('file') as File).arrayBuffer())).toEqual(f.state.file);
    const data = result.details as Row;expect(data).toMatchObject({ audience_created: false, native_upload_accepted: true, native_content_readback_available: false, record_count: 1, sha256: f.fileSha() });expect(JSON.stringify(result)).not.toContain(syntheticHash);expect(data).not.toHaveProperty('file_path');expect(f.client.verifyAudienceFileReceipt(data.upload_receipt)).toMatchObject({ account_id: CUSTOM_ACCOUNT, scope_id: 'qa-project', file_path: 'native_file_handle', calculate_type: 'EMAIL_SHA256', sha256: f.fileSha() });
  });
  it('revalidates source bytes and exact lowercase native suffix before upload', async () => {
    const f = customAudienceFixture(), args = f.upload();f.state.file = Buffer.from('b'.repeat(64));await expect(f.provider.applyWrite(op(uploadTool, args), guard)).rejects.toThrow('SHA-256');f.state.fileName = 'customers.CSV';await expect(f.provider.previewWrite(op(uploadTool, f.upload()), guard)).rejects.toThrow('suffix');expect(f.writes()).toHaveLength(0);
  });
  it.each(['business', 'http', 'invalid-json'])('hides native %s upload diagnostics and never repeats a customer-data upload', async mode => {
    const f = customAudienceFixture();f.state.hook = () => mode === 'business' ? Response.json({ code: 40001, message: syntheticHash + ' synthetic-private-access' }) : new Response(syntheticHash + ' synthetic-private-access', { status: mode === 'http' ? 403 : 200 });let error: any;
    try { await f.provider.applyWrite(op(uploadTool, f.upload()), guard); } catch (caught) { error = caught; }expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain(syntheticHash);expect(JSON.stringify(error.details)).not.toContain('synthetic-private-access');if (mode === 'business') expect(error.details.native_code).toBe(40001);expect(f.writes()).toHaveLength(1);
  });
  it.each(['tamper', 'foreign-account', 'foreign-project', 'expired', 'future', 'mixed-type', 'duplicate-file', 'foreign-token', 'sandbox'])('rejects %s upload receipts before creating an audience', async mode => {
    const f = customAudienceFixture(), good = f.receipt();let receipts = [good];
    if (mode === 'tamper') receipts = [good.slice(0, -2) + (good.at(-2) === 'A' ? 'B' : 'A') + good.at(-1)];
    else if (mode === 'foreign-account') receipts = [f.receipt({ account_id: '123' })];else if (mode === 'foreign-project') receipts = [f.receipt({ scope_id: 'other' })];else if (mode === 'expired') receipts = [f.receipt({ expires_at: 1 })];else if (mode === 'future') receipts = [f.receipt({ expires_at: Math.floor(Date.now() / 1000) + 86_500 })];else if (mode === 'mixed-type') receipts = [good, f.receipt({ file_path: 'other', calculate_type: 'PHONE_SHA256' })];else if (mode === 'duplicate-file') receipts = [good, f.receipt({ sha256: 'b'.repeat(64) })];else receipts = [new TikTokClient({ accessToken: mode === 'foreign-token' ? 'other-token' : 'synthetic-private-access', sandbox: mode === 'sandbox' }).audienceFileReceipt(f.client.verifyAudienceFileReceipt(good) as Row)];
    await expect(f.provider.previewWrite(op(createTool, { custom_audience_name: 'New', upload_receipts: receipts }), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('validates bounded receipts, explicit member actions and deletion acknowledgement', () => {
    expect(customerAudienceCreate.safeParse({ custom_audience_name: 'Name', upload_receipts: [] }).success).toBe(false);expect(customerAudienceCreate.safeParse({ custom_audience_name: 'Name', upload_receipts: Array.from({ length: 50 }, (_, i) => 'a'.repeat(80) + i) }).success).toBe(false);expect(customerAudienceCreate.safeParse({ custom_audience_name: 'Name', upload_receipts: ['a'.repeat(80)], audience_enhancement: true }).success).toBe(false);
    expect(customerAudienceUpdate.safeParse({ custom_audience_id: CUSTOM_AUDIENCE, expected_snapshot_hash: 'a'.repeat(64), acknowledge_shared_effects: true, upload_receipts: ['a'.repeat(80)] }).success).toBe(false);expect(customAudiencesDelete.safeParse({ targets: [], acknowledge_shared_effects: true }).success).toBe(false);
  });
});

describe('TikTok native custom audience lifecycle', () => {
  it('uses JSON-encoded string IDs, native numeric pagination, exact ownership and redacted status/history', async () => {
    const f = customAudienceFixture();f.state.rows[0]!.msg = 'private value ' + syntheticHash;f.state.rows[0]!.error_msg = 'synthetic-private-access ' + syntheticHash;const list = await f.provider.customAudiences.list({ account_id: CUSTOM_ACCOUNT, custom_audience_ids: [CUSTOM_AUDIENCE], page_size: 1 });expect(list.records[0]).toMatchObject({ id: CUSTOM_AUDIENCE, matched_users: 2000 });expect(list.complete).toBe(true);expect(f.calls[0]!.url.searchParams.get('custom_audience_ids')).toBe(JSON.stringify([CUSTOM_AUDIENCE]));
    const get = await f.get();expect(get.audience).toMatchObject({ audience_id: CUSTOM_AUDIENCE, owner_id: CUSTOM_ACCOUNT, native_error_reported: true });expect(JSON.stringify(get)).not.toContain(syntheticHash);expect(JSON.stringify(get)).not.toContain('synthetic-private-access');expect(get).not.toHaveProperty('audience_history');expect(f.calls.at(-1)!.url.searchParams.get('history_size')).toBe('1');
  });
  it.each(['foreign-id', 'duplicate', 'wrong-owner', 'unsafe-id', 'missing-id'])('refuses contradictory native audience details: %s', async mode => {
    const f = customAudienceFixture(), row = f.state.rows[0]!;if (mode === 'foreign-id') row.audience_id = '123';if (mode === 'wrong-owner') row.owner_id = '123';if (mode === 'unsafe-id') row.audience_id = Number(CUSTOM_AUDIENCE);if (mode === 'missing-id') f.state.rows = [];if (mode === 'duplicate') f.state.rows.push({ ...row });await expect(f.get()).rejects.toThrow();
  });
  it('keeps absent or contradictory native pagination uncertain rather than claiming absence', async () => {
    const f = customAudienceFixture();f.state.hook = ({ url }) => url.pathname.endsWith('/list/') ? Response.json({ code: 0, data: { list: [] } }) : undefined;expect(await f.provider.customAudiences.list({ account_id: CUSTOM_ACCOUNT })).toMatchObject({ complete: null, truncated: true });
    f.state.hook = ({ url }) => url.pathname.endsWith('/list/') ? Response.json({ code: 0, data: { list: [], page_info: { page: 1, page_size: 100, total_page: 2, total_number: 100 } } }) : undefined;expect((await f.provider.customAudiences.list({ account_id: CUSTOM_ACCOUNT })).complete).toBeNull();
  });
  it('creates with native file paths and explicit enhancement disabled, reporting processing without claiming membership', async () => {
    const f = customAudienceFixture(), args = { custom_audience_name: 'New <QA>', upload_receipts: [f.receipt()], retention_in_days: 30 };await f.provider.previewWrite(op(createTool, args), guard);expect(f.writes()).toHaveLength(0);const result = await f.provider.applyWrite(op(createTool, args), guard);expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toEqual({ advertiser_id: CUSTOM_ACCOUNT, custom_audience_name: 'New <QA>', file_paths: ['native_file_handle'], calculate_type: 'EMAIL_SHA256', audience_enhancement: false, audience_sub_type: 'NORMAL', retention_in_days: 30 });expect(result).toMatchObject({ resourceIds: [NEW_CUSTOM_AUDIENCE], details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, metadata_readback: 'VERIFIED', membership_verified: false, native_is_valid: false } });
  });
  it.each(['create', 'rename', 'members'])('does not certify a newly reported native processing error after %s', async kind => {
    const f = customAudienceFixture();
    const tool = kind === 'create' ? createTool : kind === 'rename' ? renameTool : membersTool;
    const args = kind === 'create' ? { custom_audience_name: 'QA', upload_receipts: [f.receipt()] } : kind === 'rename' ? await rename(f) : { custom_audience_id: CUSTOM_AUDIENCE, expected_snapshot_hash: (await f.get()).audience.snapshot_hash, acknowledge_shared_effects: true, upload_receipts: [f.receipt()], action: 'APPEND' };
    f.state.hook = ({ url }) => { if (url.pathname.endsWith('/custom_audience/get/') && f.writes().length) f.state.rows.find(row => row.audience_id === (kind === 'create' ? NEW_CUSTOM_AUDIENCE : CUSTOM_AUDIENCE))!.error_msg = 'PRIVATE processing error';return undefined; };
    await expect(f.provider.applyWrite(op(tool, args), guard)).rejects.toMatchObject({ details: { resourceIds: [kind === 'create' ? NEW_CUSTOM_AUDIENCE : CUSTOM_AUDIENCE] } });expect(f.writes()).toHaveLength(1);
  });
  it('renames only the selected field and verifies preserved configuration despite volatile coverage/expiry changes', async () => {
    const f = customAudienceFixture(), args = await rename(f), prior = structuredClone(f.state.rows[0]!);f.state.rows[0]!.cover_num = 3000;const result = await f.provider.applyWrite(op(renameTool, args), guard);expect(f.writes()[0]!.body).toEqual({ advertiser_id: CUSTOM_ACCOUNT, custom_audience_id: CUSTOM_AUDIENCE, custom_audience_name: 'Renamed audience' });expect(f.state.rows[0]).toMatchObject({ calculate_type: prior.calculate_type, type: prior.type, audience_sub_type: prior.audience_sub_type });expect(result).toMatchObject({ details: { configuration_readback: 'VERIFIED', membership_changed: false } });
  });
  it.each(['APPEND', 'REMOVE', 'REPLACE'] as const)('submits explicit %s membership once and preserves metadata without claiming user-level readback', async action => {
    const f = customAudienceFixture(), args = { custom_audience_id: CUSTOM_AUDIENCE, expected_snapshot_hash: (await f.get()).audience.snapshot_hash, acknowledge_shared_effects: true, upload_receipts: [f.receipt()], action };const result = await f.provider.applyWrite(op(membersTool, args), guard);expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toEqual({ advertiser_id: CUSTOM_ACCOUNT, custom_audience_id: CUSTOM_AUDIENCE, file_paths: ['native_file_handle'], action });expect(result).toMatchObject({ details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, membership_verified: false, action } });
  });
  it.each(['recipient', 'missing-owner', 'not-valid', 'expiring', 'missing-expiry-flag', 'expired-time', 'native-error'])('rejects unproven write ownership/readiness: %s', async mode => {
    const f = customAudienceFixture(), row = f.state.rows[0]!;if (mode === 'recipient') Object.assign(row, { is_creator: false, owner_id: '123', shared: true });if (mode === 'missing-owner') delete row.is_creator;if (mode === 'not-valid') row.is_valid = false;if (mode === 'expiring') row.is_expiring = true;if (mode === 'missing-expiry-flag') delete row.is_expiring;if (mode === 'expired-time') Object.assign(row, { expired_time: '2000-01-01 00:00:00', is_valid: false, is_expiring: true });if (mode === 'native-error') row.error_msg = 'private';await expect(f.provider.previewWrite(op(renameTool, await rename(f)), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('rejects stale configuration and wrong customer-file encryption/type before any member write', async () => {
    const f = customAudienceFixture(), args = await rename(f);f.state.rows[0]!.name = 'Concurrent name';await expect(f.provider.applyWrite(op(renameTool, args), guard)).rejects.toThrow('changed');f.state.rows[0]!.type = 'Website Audience';await expect(f.provider.previewWrite(op(membersTool, { custom_audience_id: CUSTOM_AUDIENCE, expected_snapshot_hash: (await f.get()).audience.snapshot_hash, acknowledge_shared_effects: true, upload_receipts: [f.receipt()], action: 'APPEND' }), guard)).rejects.toThrow('Customer File');expect(f.writes()).toHaveLength(0);
  });
  it('deletes owned expired audiences with exact names and complete native filtered absence', async () => {
    const f = customAudienceFixture();f.state.rows[0]!.is_valid = false;f.state.rows[0]!.is_expiring = true;const read = (await f.get()).audience, args = { targets: [{ custom_audience_id: CUSTOM_AUDIENCE, expected_snapshot_hash: read.snapshot_hash, confirm_name: read.name }], acknowledge_shared_effects: true, acknowledge_permanent_deletion: true };const result = await f.provider.applyWrite(op(deleteTool, args), guard);expect(f.writes()[0]!.body).toEqual({ advertiser_id: CUSTOM_ACCOUNT, custom_audience_ids: [CUSTOM_AUDIENCE] });expect(result).toMatchObject({ details: { deletion_readback: 'ABSENT_FROM_COMPLETE_FILTERED_LIST' } });expect(f.calls.at(-1)!.url.searchParams.get('custom_audience_ids')).toBe(JSON.stringify([CUSTOM_AUDIENCE]));
  });
  it('preserves exact native confirmation names and rejects every batch before mutation when one ID is a recipient', async () => {
    const f = customAudienceFixture();f.state.rows[0]!.name = '  Legacy audience  ';const current = (await f.get()).audience, args = { targets: [{ custom_audience_id: CUSTOM_AUDIENCE, expected_snapshot_hash: current.snapshot_hash, confirm_name: current.name }], acknowledge_shared_effects: true, acknowledge_permanent_deletion: true };
    await f.provider.applyWrite(op(deleteTool, args), guard);expect(f.state.rows).toHaveLength(0);
    const other = customAudienceFixture();other.state.rows.push({ ...other.state.rows[0], audience_id: NEW_CUSTOM_AUDIENCE, owner_id: '123', is_creator: false, shared: true });const one = (await other.get()).audience, two = (await other.provider.customAudiences.get({ account_id: CUSTOM_ACCOUNT, custom_audience_id: NEW_CUSTOM_AUDIENCE })).audience;
    await expect(other.provider.previewWrite(op(deleteTool, { ...args, targets: [one, two].map(row => ({ custom_audience_id: row.audience_id, expected_snapshot_hash: row.snapshot_hash, confirm_name: row.name })) }), guard)).rejects.toThrow('own audiences');expect(other.writes()).toHaveLength(0);
  });
  it.each(['missing-pagination', 'retained', 'denied'])('never certifies deletion from %s readback', async mode => {
    const f = customAudienceFixture(), row = (await f.get()).audience, args = { targets: [{ custom_audience_id: CUSTOM_AUDIENCE, expected_snapshot_hash: row.snapshot_hash, confirm_name: row.name }], acknowledge_shared_effects: true, acknowledge_permanent_deletion: true };let mutated = false;
    f.state.hook = ({ url, init }) => { if (init.method === 'POST') { mutated = true;return Response.json({ code: 0, data: {} }); }if (mutated && url.pathname.endsWith('/list/')) return mode === 'denied' ? Response.json({ code: 40001, message: 'private ' + syntheticHash }) : Response.json({ code: 0, data: mode === 'missing-pagination' ? { list: [] } : { list: [{ ...f.state.rows[0], audience_type: f.state.rows[0]!.type }], page_info: { page: 1, page_size: 100, total_page: 1, total_number: 1 } } });return undefined; };
    await expect(f.provider.applyWrite(op(deleteTool, args), guard)).rejects.toMatchObject({ details: { resourceIds: [CUSTOM_AUDIENCE] } });expect(f.writes()).toHaveLength(1);
  });
  it.each(['business-error', 'transport', 'missing-created-id', 'wrong-readback-owner', 'readback-denied', 'lost-type'])('keeps native %s private, retains known IDs and never replays create', async mode => {
    const f = customAudienceFixture();let mutated = false;
    f.state.hook = ({ url, init, body }) => {
      if (init.method === 'POST') { mutated = true;if (mode === 'transport') throw new Error('synthetic-private-access ' + syntheticHash);if (mode === 'business-error') return Response.json({ code: 40001, message: 'synthetic-private-access ' + syntheticHash });if (mode === 'missing-created-id') return Response.json({ code: 0, data: {} });f.state.rows.push({ ...f.state.rows[0], audience_id: NEW_CUSTOM_AUDIENCE, name: body!.custom_audience_name, ...(mode === 'wrong-readback-owner' ? { owner_id: '123' } : {}), ...(mode === 'lost-type' ? { calculate_type: 'PHONE_SHA256' } : {}) });return Response.json({ code: 0, data: { custom_audience_id: NEW_CUSTOM_AUDIENCE } }); }
      if (mutated && mode === 'readback-denied' && url.pathname.endsWith('/get/')) return Response.json({ code: 40001, message: syntheticHash });return undefined;
    };
    let error: any;try { await f.provider.applyWrite(op(createTool, { custom_audience_name: 'New', upload_receipts: [f.receipt()] }), guard); } catch (caught) { error = caught; }expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain(syntheticHash);expect(JSON.stringify(error.details)).not.toContain('synthetic-private-access');expect(f.writes()).toHaveLength(1);if (!['business-error', 'transport', 'missing-created-id'].includes(mode)) expect(error.details.resourceIds).toEqual([NEW_CUSTOM_AUDIENCE]);
  });
  it('binds receipt verification to private media scope and rejects a misleading resolver before native upload', async () => {
    const f = customAudienceFixture(), service = new TikTokCustomAudiences(f.client, { scopeId: undefined, read: f.media.read } as any);await expect(service.plan(op(uploadTool, f.upload()))).rejects.toThrow('scope');expect(f.writes()).toHaveLength(0);
    const misleading = new TikTokCustomAudiences(f.client, { read: async () => ({ name: 'customer.csv', contentType: 'text/csv', sha256: f.fileSha(), bytes: Buffer.from('b'.repeat(64)) }) });await expect(misleading.plan(op(uploadTool, f.upload()))).rejects.toThrow('checksum');expect(f.writes()).toHaveLength(0);
  });
  it('uses one shared pending approval, rejects altered bytes/arguments and consumes apply before an uncertain native upload', async () => {
    const f = customAudienceFixture(), dir = await mkdtemp(join(tmpdir(), 'tiktok-custom-audience-policy-'));dirs.push(dir);const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] }), args = { account_id: CUSTOM_ACCOUNT, ...f.upload() }, preview = await runtime.registry.call(uploadTool, args, runtime.ctx) as Row;
    expect(f.writes()).toHaveLength(0);await expect(runtime.registry.call(uploadTool, { ...args, calculate_type: 'PHONE_SHA256', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();f.state.hook = ({ init }) => { if (init.method === 'POST') throw new Error('private ' + syntheticHash);return undefined; };
    await expect(runtime.registry.call(uploadTool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ details: { approval_consumed: true } });await expect(runtime.registry.call(uploadTool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(1);const logs = (await Promise.all((await readdir(join(dir, 'audit'))).map(file => readFile(join(dir, 'audit', file), 'utf8')))).join('');expect(logs).not.toContain(syntheticHash);expect(logs).not.toContain('synthetic-private-access');
  });
});
