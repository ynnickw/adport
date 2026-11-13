import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AdportError, type MediaResolver, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import type { TikTokClient } from './client.js';
import { nativeListComplete } from './pagination.js';
import { audienceFileRecords } from './audience-file.js';
import { audienceId, audienceIds, audienceNativeId, audienceFileProof, audienceFileUpload, customAudienceList, customAudienceGet, customerAudienceCreate, customerAudienceUpdate, customAudienceRename, customAudiencesDelete } from './custom-audience-schemas.js';

type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const text = z.string().max(100_000), nativeDetails = z.object({ audience_id: audienceNativeId, owner_id: audienceNativeId.optional(), name: z.string().max(4096), type: z.string().max(128), is_creator: z.boolean().optional(), shared: z.boolean().optional(), is_valid: z.boolean().optional(), is_expiring: z.boolean().optional(), expired_time: z.string().max(100).optional(), create_time: z.string().max(100).optional(), calculate_type: z.string().max(100).nullable().optional(), audience_sub_type: z.string().max(100).optional(), rule: text.nullable().optional(), is_auto_refresh: z.boolean().optional(), lookalike_spec: z.json().optional(), cover_num: z.number().nonnegative().safe().optional(), msg: text.nullable().optional(), error_msg: text.nullable().optional() });
type Details = z.infer<typeof nativeDetails>;
const listRow = z.object({ audience_id: audienceNativeId, name: z.string().max(4096), audience_type: z.string().max(128), is_creator: z.boolean().optional(), shared: z.boolean().optional(), is_valid: z.boolean().optional(), is_expiring: z.boolean().optional(), expired_time: z.string().max(100).optional(), create_time: z.string().max(100).optional(), calculate_type: z.string().max(100).nullable().optional(), cover_num: z.number().nonnegative().safe().optional() });
const pageInfo = z.object({ page: z.number().int().positive().safe(), page_size: z.number().int().positive().max(100), total_page: z.number().int().nonnegative().safe().optional(), total_number: z.number().int().nonnegative().safe().optional() });
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const ruleValue = (value: string | null | undefined): unknown => { if (typeof value !== 'string') return value;try { return JSON.parse(value); } catch { return value; } };
const configuration = (row: Details) => ({ audience_id: row.audience_id, owner_id: row.owner_id, name: row.name, type: row.type, calculate_type: row.calculate_type, audience_sub_type: row.audience_sub_type, rule: ruleValue(row.rule), is_auto_refresh: row.is_auto_refresh, lookalike_spec: row.lookalike_spec, create_time: row.create_time, is_creator: row.is_creator, shared: row.shared });
const snapshot = (account: string, row: Details) => digest({ account_id: account, configuration: configuration(row), is_valid: row.is_valid, is_expiring: row.is_expiring, expired_time: row.expired_time, native_error_reported: !!row.error_msg });
const publicDetails = (account: string, row: Details) => { const { msg, error_msg, ...fields } = row;return { ...fields, native_status_message_present: !!msg, native_error_reported: !!error_msg, snapshot_hash: snapshot(account, row) }; };
const invalid = () => new AdportError('PROVIDER_ERROR', 'TikTok custom-audience response, ownership scope or pagination could not be verified.');
function failure(error: unknown, ids: string[] = []) {
  const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  return new AdportError('PROVIDER_ERROR', 'TikTok audience operation is unconfirmed. No native upload or mutation was retried. Reconcile known IDs before another preview; provider bodies and customer identifiers stay hidden.', { ...(ids.length ? { resourceIds: ids } : {}), ...(Number.isSafeInteger(details.native_code ?? details.code) ? { native_code: details.native_code ?? details.code } : {}) });
}
const notes = ['Custom audiences contain matched users; saved targeting templates are a different resource. No ads, budgets, spend, sharing grants or conversion events are changed by these tools.', 'Audience changes can affect existing ad groups and advertisers receiving a shared audience. Native audience expiry can detach audiences or pause campaigns that have no other targeting.', 'Native file and membership processing can take up to 48 hours. Acceptance, metadata readback and matched-user availability are distinct; individual membership is not readable through this API.', 'Concurrent native operations, quota and minimum matched-audience size remain authoritative. There is no conditional-write or atomic batch guarantee. Never replay an uncertain upload or mutation.'];

export { configuration as customAudienceConfiguration, failure as audienceOperationFailure };

/** Official SDK f809c396 plus public v1.3 docs, refreshed 2026-11-06. */
export class TikTokCustomAudiences {
  constructor(private readonly client: TikTokClient, private readonly media: MediaResolver) {}
  private mediaScope() {
    if (!('scopeId' in this.media)) return 'local';
    if (typeof this.media.scopeId !== 'string' || !this.media.scopeId || this.media.scopeId.length > 200) throw new AdportError('POLICY_VIOLATION', 'Private media scope could not be bound to the audience upload.');return this.media.scopeId;
  }
  async list(value: unknown) {
    const input = customAudienceList.parse(value);let raw: unknown;
    try { raw = await this.client.get('dmp/custom_audience/list', { advertiser_id: input.account_id, custom_audience_ids: input.custom_audience_ids, page: input.page, page_size: input.page_size }); } catch (error) { throw failure(error); }
    const parsed = z.object({ list: z.array(listRow).max(100), page_info: pageInfo.optional() }).safeParse(raw);if (!parsed.success) throw invalid();
    const rows = parsed.data.list, page = parsed.data.page_info;
    if (rows.length > input.page_size || new Set(rows.map(row => row.audience_id)).size !== rows.length || rows.some(row => input.custom_audience_ids && !input.custom_audience_ids.includes(row.audience_id)) || page && (page.page !== input.page || page.page_size !== input.page_size)) throw invalid();
    const complete = nativeListComplete(page, rows.length);
    return { list: rows, page_info: page, audiences: rows, records: rows.map(row => ({ id: row.audience_id, name: row.name, type: row.audience_type, available: row.is_valid, matched_users: row.cover_num, owner: row.is_creator, shared: row.shared, expiring: row.is_expiring })), complete, truncated: complete !== true, ...(complete === false ? { next_page: input.page + 1 } : {}), ...(complete === null ? { pagination_note: 'Native completeness is unavailable; do not infer absence.' } : {}), notes };
  }
  private async details(account: string, ids: string[]) {
    let raw: unknown;try { raw = await this.client.get('dmp/custom_audience/get', { advertiser_id: account, custom_audience_ids: ids, history_size: 1 }); } catch (error) { throw failure(error, ids); }
    const parsed = z.object({ list: z.array(z.object({ audience_details: nativeDetails })).max(100) }).safeParse(raw);
    if (!parsed.success || parsed.data.list.length !== ids.length) throw invalid();const rows = parsed.data.list.map(row => row.audience_details);
    if (new Set(rows.map(row => row.audience_id)).size !== ids.length || rows.some(row => !ids.includes(row.audience_id) || row.is_creator === true && row.owner_id !== account || row.is_creator === false && row.owner_id === account)) throw invalid();return rows;
  }
  async get(value: unknown) {
    const input = customAudienceGet.parse(value), row = (await this.details(input.account_id, [input.custom_audience_id]))[0]!;
    return { audience: publicDetails(input.account_id, row), records: [{ id: row.audience_id, name: row.name, type: row.type, available: row.is_valid, matched_users: row.cover_num, shared: row.shared, owner: row.is_creator, expires: row.expired_time, native_error_reported: !!row.error_msg }], notes };
  }
  async inspect(account: string, ids: string[]) { audienceId.parse(account);audienceIds.parse(ids);return (await this.details(account, ids)).map(row => publicDetails(account, row)); }
  private uploads(account: string, receipts: string[]) {
    const now = Math.floor(Date.now() / 1000), files = receipts.map(receipt => audienceFileProof.parse(this.client.verifyAudienceFileReceipt(receipt)));
    if (files.some(row => row.account_id !== account || row.scope_id !== this.mediaScope() || row.expires_at <= now || row.expires_at > now + 86_400) || new Set(files.map(row => row.file_path)).size !== files.length || new Set(files.map(row => row.calculate_type)).size !== 1) throw new AdportError('INVALID_INPUT', 'Use distinct, unexpired audience upload receipts for this project/advertiser and one matching encryption type.');return files;
  }
  private owned(account: string, row: Details, available: boolean) {
    if (row.is_creator !== true || row.owner_id !== account) throw new AdportError('POLICY_VIOLATION', 'Only the selected advertiser’s own audiences can be modified. Shared recipient access is not ownership.');
    if (available && (row.is_valid !== true || row.is_expiring !== false || !!row.error_msg)) throw new AdportError('INVALID_INPUT', 'Audience readiness and non-expiring status must be proven before modification. Read its current state; unavailable, processing, expiring or failed audiences cannot be modified here.');
  }
  async plan(op: WriteOperation): Promise<Plan> {
    audienceId.parse(op.accountId);
    const upload = op.tool === 'tiktok_upload_audience_file', create = op.tool === 'tiktok_create_customer_audience', update = op.tool === 'tiktok_update_customer_audience_users', rename = op.tool === 'tiktok_rename_custom_audience', remove = op.tool === 'tiktok_delete_custom_audiences';
    if (op.provider !== 'tiktok' || !(upload && op.kind === 'create' || create && op.kind === 'create' || (update || rename) && op.kind === 'update' || remove && op.kind === 'remove')) throw new AdportError('INVALID_INPUT', 'Unsupported TikTok custom-audience operation/kind.');
    if (upload) return this.uploadPlan(op);
    if (create) return this.createPlan(op);
    if (remove) return this.deletePlan(op);
    const input = rename ? customAudienceRename.parse(op.payload) : customerAudienceUpdate.parse(op.payload);
    const prepare = async () => {
      const row = (await this.details(op.accountId, [input.custom_audience_id]))[0]!;this.owned(op.accountId, row, true);
      if (snapshot(op.accountId, row) !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'Audience configuration, availability or ownership changed; read it and preview again.');
      const files = 'upload_receipts' in input ? this.uploads(op.accountId, input.upload_receipts) : undefined;
      if (files && (row.type !== 'Customer File Audience' || files[0]!.calculate_type !== row.calculate_type)) throw new AdportError('INVALID_INPUT', 'Membership updates require an owned Customer File Audience with matching encryption type.');
      if ('custom_audience_name' in input && input.custom_audience_name === row.name) throw new AdportError('INVALID_INPUT', 'Choose a different audience name.');return { row, files };
    };
    const before = await prepare(), title = rename ? 'Rename custom audience' : 'Update customer audience members', action = 'action' in input ? input.action : undefined;
    const membershipChange = action === 'APPEND' ? 'Add matches from these files; retain existing members' : action === 'REMOVE' ? 'Remove matches from these files; retain other members' : 'Replace the entire membership with matches from these files';
    return { summary: `${title} · ${before.row.name}`, changes: [rename ? '~ Audience name' : `~ ${action} using ${before.files!.length} approved files`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: op.accountId, kind: 'update', title, subject: before.row.name, fields: [{ label: 'Audience', after: input.custom_audience_id }, ...('custom_audience_name' in input ? [{ label: 'Name', before: before.row.name, after: input.custom_audience_name }] : [{ label: 'Membership operation', before: 'Individual members are not readable through this API', after: { action, effect: membershipChange } }, { label: 'Approved source files', after: before.files!.map(file => ({ sha256: file.sha256, records: file.record_count, calculate_type: file.calculate_type })) }])], notices: notes },
      execute: async () => {
        const fresh = await prepare(), body = { advertiser_id: op.accountId, custom_audience_id: input.custom_audience_id, ...('custom_audience_name' in input ? { custom_audience_name: input.custom_audience_name } : { file_paths: fresh.files!.map(file => file.file_path), action: input.action }) };
        try {
          z.object({}).strict().parse(await this.client.post('dmp/custom_audience/update', body));const actual = (await this.details(op.accountId, [input.custom_audience_id]))[0]!;this.owned(op.accountId, actual, false);
          const expected = { ...configuration(fresh.row), ...('custom_audience_name' in input ? { name: input.custom_audience_name } : {}) };
          if (canonical(configuration(actual)) !== canonical(expected) || actual.error_msg) throw invalid();
          return { applied: true, resourceIds: [input.custom_audience_id], details: rename ? { configuration_readback: 'VERIFIED', membership_changed: false } : { status: 'ACCEPTED_FOR_PROCESSING', processed: false, membership_verified: false, action, source_files: fresh.files!.map(file => ({ sha256: file.sha256, record_count: file.record_count })), native_is_valid: actual.is_valid, next_tool: 'tiktok_get_custom_audience', next_arguments: { account_id: op.accountId, custom_audience_id: input.custom_audience_id } }, warnings: rename ? ['Native audience modification can reset its expiry under TikTok’s retention policy.'] : notes.slice(1) };
        } catch (error) { throw failure(error, [input.custom_audience_id]); }
      } };
  }
  private async uploadPlan(op: WriteOperation): Promise<Plan> {
    const input = audienceFileUpload.parse(op.payload), scope = this.mediaScope(), source = await this.media.read(input, { contentTypes: ['text/csv'], maxBytes: 50 * 1024 * 1024 }), file = { ...source, bytes: Uint8Array.from(source.bytes) };
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    if (file.bytes.byteLength < 1 || file.bytes.byteLength > 50 * 1024 * 1024 || file.contentType !== 'text/csv' || sha256 !== input.expected_sha256.toLowerCase() || file.sha256 !== sha256) throw new AdportError('INVALID_INPUT', 'Audience file bytes, type or checksum changed; prepare a new preview.');
    if (!/\.(csv|txt)$/.test(file.name)) throw new AdportError('INVALID_INPUT', 'TikTok customer files require the exact lowercase .csv or .txt suffix.');
    const count = audienceFileRecords(file.bytes, input.calculate_type), signature = createHash('md5').update(file.bytes).digest('hex');
    return { summary: `Upload customer audience file · ${count} rows`, changes: [`+ ${file.bytes.byteLength} bytes; SHA-256 ${file.sha256}; ${input.calculate_type}`], coercions: [], budgetDeltas: [], notes: ['Identifier values and file contents are excluded from previews, results and native error diagnostics. This upload does not create an audience.', 'Upload receipts bind the current credential, advertiser, exact source hash, encryption type and native file handle. Adport receipts expire after24 hours; native file retention is not inferred.', ...notes],
      review: { provider: 'tiktok', accountId: op.accountId, kind: 'create', title: 'Upload customer audience file', subject: `${count} rows`, fields: [{ label: 'Source SHA-256', after: file.sha256 }, { label: 'File size', after: file.bytes.byteLength }, { label: 'Rows', after: count }, { label: 'Identifier encryption', after: input.calculate_type }], notices: ['Only already-hashed identifiers are accepted. Source normalization and data authority remain the uploader’s responsibility.', 'This creates an advertiser-bound native upload handle. It does not create an audience or change targeting.'] },
      execute: async () => {
        if (this.mediaScope() !== scope) throw new AdportError('PENDING_MISMATCH', 'Private media scope changed before native upload.');
        const form = new FormData();form.append('advertiser_id', op.accountId);form.append('calculate_type', input.calculate_type);form.append('file_signature', signature);form.append('file', new Blob([file.bytes], { type: 'text/csv' }), file.name);
        try {
          const result = z.object({ file_path: audienceFileProof.shape.file_path }).parse(await this.client.postMultipart('dmp/custom_audience/file/upload', form));
          const proof = audienceFileProof.parse({ kind: 'tiktok_audience_file_v1', account_id: op.accountId, scope_id: scope, file_path: result.file_path, calculate_type: input.calculate_type, sha256: file.sha256, byte_length: file.bytes.byteLength, record_count: count, expires_at: Math.floor(Date.now() / 1000) + 86_400 });
          return { applied: true, resourceIds: [digest({ account_id: op.accountId, file_path: result.file_path })], details: { upload_receipt: this.client.audienceFileReceipt(proof), sha256: proof.sha256, byte_length: proof.byte_length, record_count: count, calculate_type: input.calculate_type, audience_created: false, native_upload_accepted: true, native_content_readback_available: false, receipt_expires_at: new Date(proof.expires_at * 1000).toISOString() } };
        } catch (error) { throw failure(error); }
      } };
  }
  private async createPlan(op: WriteOperation): Promise<Plan> {
    const input = customerAudienceCreate.parse(op.payload), files = this.uploads(op.accountId, input.upload_receipts);
    return { summary: `Create customer audience · ${input.custom_audience_name}`, changes: [`+ Customer File Audience from ${files.length} approved uploads`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: op.accountId, kind: 'create', title: 'Create customer audience', subject: input.custom_audience_name, fields: [{ label: 'Name', after: input.custom_audience_name }, { label: 'Audience subtype', after: input.audience_sub_type }, { label: 'Audience enhancement', after: 'Disabled' }, { label: 'Approved source files', after: files.map(file => ({ sha256: file.sha256, records: file.record_count, calculate_type: file.calculate_type })) }, { label: 'Retention requested', after: input.retention_in_days ?? 'Native default; expiry can reset on eligible use/modification' }], notices: notes },
      execute: async () => {
        const fresh = this.uploads(op.accountId, input.upload_receipts);let id: string | undefined;
        try {
          const result = z.object({ custom_audience_id: audienceNativeId }).parse(await this.client.post('dmp/custom_audience/create', { advertiser_id: op.accountId, custom_audience_name: input.custom_audience_name, calculate_type: fresh[0]!.calculate_type, file_paths: fresh.map(file => file.file_path), audience_enhancement: false, audience_sub_type: input.audience_sub_type, ...(input.retention_in_days ? { retention_in_days: input.retention_in_days } : {}) }));id = result.custom_audience_id;
          const actual = (await this.details(op.accountId, [id]))[0]!;this.owned(op.accountId, actual, false);
          if (actual.name !== input.custom_audience_name || actual.type !== 'Customer File Audience' || actual.calculate_type !== fresh[0]!.calculate_type || actual.audience_sub_type !== input.audience_sub_type || actual.error_msg) throw invalid();
          return { applied: true, resourceIds: [id], details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, metadata_readback: 'VERIFIED', membership_verified: false, native_is_valid: actual.is_valid, retention_requested: input.retention_in_days, native_expired_time: actual.expired_time, next_tool: 'tiktok_get_custom_audience', next_arguments: { account_id: op.accountId, custom_audience_id: id } }, warnings: notes.slice(1) };
        } catch (error) { throw failure(error, id ? [id] : []); }
      } };
  }
  private async deletePlan(op: WriteOperation): Promise<Plan> {
    const input = customAudiencesDelete.parse(op.payload), ids = input.targets.map(target => target.custom_audience_id);
    const prepare = async () => { const rows = await this.details(op.accountId, ids);for (const row of rows) { this.owned(op.accountId, row, false);const target = input.targets.find(target => target.custom_audience_id === row.audience_id)!;if (snapshot(op.accountId, row) !== target.expected_snapshot_hash || row.name !== target.confirm_name) throw new AdportError('PENDING_MISMATCH', 'Audience configuration or name changed; read every selected audience and preview again.'); }return rows; };
    const before = await prepare();return { summary: `Permanently delete ${ids.length} custom audiences`, changes: before.map(row => '- Audience ' + row.name), coercions: [], budgetDeltas: [], notes: ['Native deletion has no restore endpoint. Dependent ads and shared-recipient usage are not enumerated or frozen.', ...notes], review: { provider: 'tiktok', accountId: op.accountId, kind: 'remove', title: 'Delete custom audiences permanently', subject: `${ids.length} selected`, fields: before.map(row => ({ label: row.name, before: { id: row.audience_id, type: row.type, shared: row.shared }, after: 'Permanently deleted' })), notices: notes }, execute: async () => {
      await prepare();try {
        z.object({}).strict().parse(await this.client.post('dmp/custom_audience/delete', { advertiser_id: op.accountId, custom_audience_ids: ids }));
        const remaining = await this.list({ account_id: op.accountId, custom_audience_ids: ids, page: 1, page_size: 100 });
        if (remaining.audiences.length || remaining.complete !== true) throw invalid();
        return { applied: true, resourceIds: ids, details: { deletion_readback: 'ABSENT_FROM_COMPLETE_FILTERED_LIST' }, warnings: ['Dependent ad groups and shared recipients can be affected. Their usage was not enumerated or frozen.'] };
      } catch (error) { throw failure(error, ids); }
    } };
  }
}
