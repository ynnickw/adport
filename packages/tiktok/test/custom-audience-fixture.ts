import { createHash } from 'node:crypto';
import { verifyMedia } from '@adport/core';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';

export const CUSTOM_ACCOUNT = '7111000000000000001', CUSTOM_AUDIENCE = '9007199254740993123', NEW_CUSTOM_AUDIENCE = '9007199254740993124', AUDIENCE_MEDIA = 'ccd3710c-594a-4c31-8cc0-3f0317213154';
export const syntheticHash = createHash('sha256').update('synthetic-person@adport.invalid').digest('hex');
type Row = Record<string, any>;
type Call = { url: URL; init: RequestInit; body?: Row; form?: FormData };
export function customAudienceFixture() {
  const state = { scopeId: 'qa-project', file: Buffer.from(syntheticHash + '\n'), fileName: 'synthetic-customers.csv', rows: [{ audience_id: CUSTOM_AUDIENCE, owner_id: CUSTOM_ACCOUNT, name: 'Synthetic <QA audience>', type: 'Customer File Audience', is_creator: true, shared: false, is_valid: true, is_expiring: false, expired_time: '2099-01-01 00:00:00', create_time: '2026-11-06 00:00:00', calculate_type: 'EMAIL_SHA256', audience_sub_type: 'NORMAL', cover_num: 2000, msg: null, error_msg: null, rule: null, lookalike_spec: null }] as Row[], hook: undefined as undefined | ((call: Call) => Response | undefined) };
  const calls: Call[] = [], ok = (data: unknown) => Response.json({ code: 0, message: 'OK', data });
  const client = new TikTokClient({ accessToken: 'synthetic-private-access' }, async (raw, init = {}) => {
    const url = new URL(String(raw)), call: Call = { url, init, ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : init.body instanceof FormData ? { form: init.body } : {}) };calls.push(call);const override = state.hook?.(call);if (override) return override;
    const ids = url.searchParams.has('custom_audience_ids') ? JSON.parse(url.searchParams.get('custom_audience_ids')!) as string[] : undefined;
    if (url.pathname.endsWith('/custom_audience/list/')) {
      const page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('page_size')), rows = state.rows.filter(row => !ids || ids.includes(row.audience_id));
      return ok({ list: rows.slice((page - 1) * size, page * size).map(row => ({ ...row, audience_type: row.type })), page_info: { page, page_size: size, total_page: Math.ceil(rows.length / size), total_number: rows.length } });
    }
    if (url.pathname.endsWith('/custom_audience/get/')) return ok({ list: state.rows.filter(row => ids?.includes(row.audience_id)).map(row => ({ audience_details: row, audience_history: [{ action: 'create', msg: 'private hashed ' + syntheticHash }] })) });
    if (url.pathname.endsWith('/custom_audience/file/upload/')) return ok({ file_path: 'native_file_handle' });
    if (url.pathname.endsWith('/custom_audience/create/')) {
      state.rows.push({ ...state.rows[0], audience_id: NEW_CUSTOM_AUDIENCE, name: call.body!.custom_audience_name, calculate_type: call.body!.calculate_type, audience_sub_type: call.body!.audience_sub_type, is_valid: false });return ok({ custom_audience_id: NEW_CUSTOM_AUDIENCE });
    }
    if (url.pathname.endsWith('/custom_audience/update/')) {
      const row = state.rows.find(row => row.audience_id === call.body!.custom_audience_id)!;if (call.body!.custom_audience_name !== undefined) { row.name = call.body!.custom_audience_name;row.expired_time = '2099-02-01 00:00:00'; } else row.is_valid = false;return ok({});
    }
    if (url.pathname.endsWith('/custom_audience/delete/')) { state.rows = state.rows.filter(row => !call.body!.custom_audience_ids.includes(row.audience_id));return ok({}); }
    throw new Error('Unexpected synthetic native endpoint: ' + url.pathname);
  });
  const media = { get scopeId() { return state.scopeId; }, async read(source: { expected_sha256: string }) { return verifyMedia(state.file, state.fileName, source.expected_sha256, { contentTypes: ['text/csv'], maxBytes: 50 * 1024 * 1024 }); } };
  const provider = new TikTokAdsProvider(client, { appId: 'synthetic-app', secret: 'synthetic-secret' }, media), fileSha = () => createHash('sha256').update(state.file).digest('hex');
  const receipt = (overrides: Row = {}) => client.audienceFileReceipt({ kind: 'tiktok_audience_file_v1', account_id: CUSTOM_ACCOUNT, scope_id: state.scopeId, file_path: 'native_file_handle', calculate_type: 'EMAIL_SHA256', sha256: fileSha(), byte_length: state.file.length, record_count: 1, expires_at: Math.floor(Date.now() / 1000) + 86_400, ...overrides });
  return { state, client, provider, calls, media, fileSha, receipt, writes: () => calls.filter(call => call.init.method === 'POST'), get: () => provider.customAudiences.get({ account_id: CUSTOM_ACCOUNT, custom_audience_id: CUSTOM_AUDIENCE }), upload: () => ({ media_id: AUDIENCE_MEDIA, expected_sha256: fileSha(), calculate_type: 'EMAIL_SHA256' as const }) };
}
