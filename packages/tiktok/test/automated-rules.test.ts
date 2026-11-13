import { describe, expect, it } from 'vitest';
import { TikTokClient } from '../src/client.js';
import { TikTokAdsProvider } from '../src/provider.js';
import { tiktokTools } from '../src/tools.js';

const account = '7111000000000000001', ruleId = '9007199254740993123', execId = '9007199254740993124';
type Row = Record<string, unknown>;
const source = { rule_id: ruleId, name: 'QA <rule>', rule_status: 'OFF', apply_objects: [{ dimension: 'CAMPAIGN', dimension_ids: ['1694011873852465'], pre_condition_type: 'SELECTED', bind_type: 'BIND' }], conditions: [{ subject_type: 'CLICK', values: ['1'], match_type: 'GT', range_type: 'LIFETIME' }], actions: [{ subject_type: 'MESSAGE' }], notification: { notification_type: 'TASK_FINISH' }, rule_exec_info: { exec_time_type: 'PER_HALF_HOUR', exec_time: '' }, last_check_result_summary: { change_fail: 0, change_success: 0, task_exec_id: execId, not_change: 0, check_datetime: '2026-11-01 00:00:00', exec_datetime: '2026-11-01 00:00:00' } };
function fixture(options: { page?: unknown; details?: unknown; error?: 'http' | 'business'; rows?: Row[] } = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const client = new TikTokClient({ accessToken: 'inert-token' }, (async (input, init = {}) => {
    const url = new URL(String(input));calls.push({ url, init });
    if (init.method !== 'GET') throw new Error('Inspection must never write');
    if (options.error === 'http') return Response.json({ message: 'denied' }, { status: 403 });
    if (options.error === 'business') return Response.json({ code: 40001, message: 'Advertiser permission denied', request_id: 'synthetic-request' });
    const rows = options.rows ?? [source], page = Number(url.searchParams.get('page') ?? 1), size = Number(url.searchParams.get('page_size') ?? 10);
    const data = url.pathname.endsWith('/result/get/') ? options.details ?? { result_details: [{ rule_id: ruleId, exec_id: execId, object_dimension: 'CAMPAIGN', object_dimension_id: '1694011873852465', action_subject_type: 'MESSAGE', status: 'SUCCESS', object_name: 'QA campaign' }] }
      : options.page ?? { rules: rows.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_number: rows.length, total_page: Math.ceil(rows.length / size) } };
    return Response.json({ code: 0, message: 'OK', data });
  }) as typeof fetch);
  const provider = new TikTokAdsProvider(client, { appId: 'inert', secret: 'inert' });
  return { provider, calls, tools: tiktokTools(provider), service: provider.automatedRules };
}

// Fixtures follow official v1.3 documentation and SDK f809c396, inspected 2026-11-05.
describe('TikTok existing automated rules and execution results', () => {
  it('uses native GET, trailing slash, token header and JSON filters without deprecated filters[]', async () => {
    const f = fixture(), filtering = { status: 'OFF' as const, rule_info: [ruleId, 'QA'], data_dimension: 'CAMPAIGN' as const };
    const result = await f.service.list({ account_id: account, filtering, tzone: 'UTC' });
    expect(f.calls[0]!.url.pathname).toBe('/open_api/v1.3/optimizer/rule/list/');
    expect(Object.fromEntries(f.calls[0]!.url.searchParams)).toEqual({ advertiser_id: account, filtering: JSON.stringify(filtering), tzone: 'UTC', page: '1', page_size: '10' });
    expect(f.calls[0]!.init).toMatchObject({ method: 'GET', headers: { 'Access-Token': 'inert-token' } });
    expect(result).toMatchObject({ rules: [source], records: [{ id: ruleId, name: source.name, status: 'OFF', action_types: ['MESSAGE'] }], complete: true, truncated: false });
  });
  it('encodes exact rule IDs and reports unreturned IDs without claiming missing resources', async () => {
    const f = fixture(), result = await f.service.get({ account_id: account, rule_ids: [ruleId, '404'] });
    expect(f.calls[0]!.url.pathname).toBe('/open_api/v1.3/optimizer/rule/get/');expect(f.calls[0]!.url.searchParams.get('rule_ids')).toBe(JSON.stringify([ruleId, '404']));
    expect(result).toMatchObject({ requested_rule_ids: [ruleId, '404'], unreturned_rule_ids: ['404'], all_requested_ids_returned: false });
    expect(result).not.toHaveProperty('missing_rule_ids');expect(result).not.toHaveProperty('next_page', expect.anything());
  });
  it('supports native history filters, exact large execution IDs and documented legacy spelling', async () => {
    const f = fixture(), filtering = { action: 'LIFERIME_BUDGET' as const, time: ['2026-11-01 00:00:00', '2026-11-02 23:59:59'] as [string, string], status: 'DELETED' as const, data_dimension: 'ADGROUP' as const, rule_info: [ruleId] };
    const value = await f.service.results({ account_id: account, filtering, lang: 'JA' });
    expect(f.calls[0]!.url.pathname).toBe('/open_api/v1.3/optimizer/rule/result/list/');expect(JSON.parse(f.calls[0]!.url.searchParams.get('filtering')!)).toEqual(filtering);expect(f.calls[0]!.url.searchParams.get('lang')).toBe('JA');
    expect(value.records[0]).toMatchObject({ id: `${ruleId}:${execId}`, rule_id: ruleId, last_result: { task_exec_id: execId } });
  });
  it('retains multiple execution summaries for the same rule', async () => {
    const rows = [{ ...source, rule_check_result: { task_exec_id: execId } }, { ...source, rule_check_result: { task_exec_id: '9007199254740993125' } }];
    const value = await fixture({ rows }).service.results({ account_id: account });
    expect(value.rules).toHaveLength(2);expect(new Set(value.records.map(row => row.id)).size).toBe(2);
  });
  it('keeps documented per-object execution details and encodes native pair objects', async () => {
    const f = fixture(), result_detail = [{ rule_id: ruleId, exec_id: execId }];
    const value = await f.service.details({ account_id: account, result_detail });
    expect(f.calls[0]!.url.pathname).toBe('/open_api/v1.3/optimizer/rule/result/get/');expect(Object.fromEntries(f.calls[0]!.url.searchParams)).toEqual({ advertiser_id: account, lang: 'EN', result_detail: JSON.stringify(result_detail) });
    expect(value).toMatchObject({ records: [{ rule_id: ruleId, exec_id: execId, object_dimension_id: '1694011873852465', status: 'SUCCESS' }], complete: null, truncated: true });
  });
  it('appends only verified native pages and confirms an empty inventory from consistent totals', async () => {
    const f = fixture({ rows: [source, { ...source, rule_id: '123' }] });
    expect(await f.service.list({ account_id: account, page_size: 1 })).toMatchObject({ complete: false, truncated: true, next_page: 2 });
    expect(await f.service.list({ account_id: account, page: 2, page_size: 1 })).toMatchObject({ complete: true, truncated: false });
    expect(await fixture({ rows: [] }).service.list({ account_id: account })).toMatchObject({ rules: [], complete: true, truncated: false });
  });
  it.each([{ rules: [] }, { rules: [source], page_info: { page: 1, page_size: 10, total_page: 0, total_number: 0 } }, { rules: [], page_info: { page: 1, page_size: 10, total_page: 1, total_number: 1 } }])('does not infer completeness from missing or contradictory totals: %o', async page => {
    const value = await fixture({ page }).service.list({ account_id: account });expect(value).toMatchObject({ complete: null, truncated: true });expect(value.next_page).toBeUndefined();
  });
  it('does not copy unverified continuation hints from native extra fields', async () => {
    expect((await fixture({ page: { rules: [], next_page: 999 } }).service.list({ account_id: account })).next_page).toBeUndefined();
  });
  it.each([{}, { rules: 'bad' }, { rules: [{}] }, { rules: [source, source] }, { rules: [{ ...source, rule_id: 9007199254740992 }] }, { rules: [{ ...source, advertiser_id: '404' }] }, { rules: [{ ...source, apply_objects: [{ dimension_ids: [9007199254740992] }] }] }, { rules: [{ ...source, last_check_result_summary: { task_exec_id: 9007199254740992 } }] }, { rules: [source], page_info: { page: 2, page_size: 10, total_page: 2 } }, { rules: [source], page_info: { page: 1, page_size: 20, total_page: 1 } }])('rejects malformed, foreign, unsafe or mismatched native data: %o', async page => {
    const f = fixture({ page });await expect(f.service.list({ account_id: account })).rejects.toThrow('tiktok:');expect(f.calls).toHaveLength(1);
  });
  it('normalizes safe legacy numeric IDs without corrupting precise string IDs', async () => {
    const value = await fixture({ rows: [{ rule_id: 123, advertiser_id: account, last_check_result_summary: { task_exec_id: 0 }, apply_objects: [{ dimension_ids: [456] }] }] }).service.list({ account_id: account });
    expect(value.rules[0]).toMatchObject({ rule_id: '123', advertiser_id: account, last_check_result_summary: { task_exec_id: '0' }, apply_objects: [{ dimension_ids: ['456'] }] });
  });
  it('rejects an ignored rule-ID filter and never retries or broadens the request', async () => {
    const f = fixture();await expect(f.service.get({ account_id: account, rule_ids: ['404'] })).rejects.toThrow('unrequested');expect(f.calls).toHaveLength(1);
  });
  it.each([{}, { result_details: [{}] }, { result_details: [{ rule_id: ruleId, exec_id: '404' }] }, { result_details: [{ rule_id: '404', exec_id: execId }] }, { result_details: [{ rule_id: ruleId, exec_id: execId, advertiser_id: '404' }] }, { result_details: [{ rule_id: ruleId, exec_id: execId, object_dimension_id: 9007199254740992 }] }])('rejects mismatched execution details: %o', async details => {
    const f = fixture({ details });await expect(f.service.details({ account_id: account, result_detail: [{ rule_id: ruleId, exec_id: execId }] })).rejects.toThrow('tiktok:');expect(f.calls).toHaveLength(1);
  });
  it.each(['http', 'business'] as const)('preserves %s permission errors without retrying or returning an empty list', async error => {
    const f = fixture({ error });await expect(f.service.list({ account_id: account })).rejects.toThrow(error === 'http' ? 'HTTP 403' : '40001');expect(f.calls).toHaveLength(1);
  });
  it('rejects invalid dates, ID pairs, filters and page limits before network access', () => {
    const f = fixture(), byName = (name: string) => f.tools.find(tool => tool.name === name)!.input;
    for (const extra of [{ page_size: 101 }, { page: 0 }, { page: Number.MAX_SAFE_INTEGER + 1 }, { filtering: { action: 'TURN_ON' } }, { advertiser_id: '404' }]) expect(byName('tiktok_automated_rules').safeParse({ account_id: account, ...extra }).success).toBe(false);
    for (const time of [['2026-02-30 00:00:00', '2026-03-01 00:00:00'], ['2026-11-02 00:00:00', '2026-11-01 00:00:00'], ['2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z']]) expect(byName('tiktok_automated_rule_results').safeParse({ account_id: account, filtering: { time } }).success).toBe(false);
    expect(byName('tiktok_get_automated_rules').safeParse({ account_id: account, rule_ids: [ruleId, ruleId] }).success).toBe(false);
    expect(byName('tiktok_automated_rule_result_details').safeParse({ account_id: account, result_detail: [{ rule_id: ruleId, exec_id: execId }, { rule_id: ruleId, exec_id: execId }] }).success).toBe(false);expect(f.calls).toHaveLength(0);
  });
  it('registers four unique read-only specialist definitions with validated output and pagination', async () => {
    const f = fixture(), selected = f.tools.filter(tool => tool.name.includes('automated_rule'));
    expect(selected).toHaveLength(4);expect(new Set(f.tools.map(tool => tool.name)).size).toBe(f.tools.length);
    for (const tool of selected) {expect(tool.annotations).toMatchObject({ readOnly: true, destructive: false });expect(tool.catalog).toEqual({ category: 'administration', exposure: 'specialist' });expect(tool.presentation).toBe('records');}
    expect(selected.find(tool => tool.name === 'tiktok_automated_rules')!.output!.safeParse(await f.service.list({ account_id: account })).success).toBe(true);
    expect(selected.find(tool => tool.name === 'tiktok_automated_rules')!.pagination).toEqual({ cursorInput: 'page', cursorOutput: 'next_page' });
  });
  it.each(['create', 'update', 'delete'] as const)('rejects raw scheduled-rule %s paths before any provider request', async kind => {
    const f = fixture(), op = { tool: `tiktok_api_${kind}`, provider: 'tiktok', kind: kind === 'delete' ? 'remove' as const : kind, accountId: account, payload: { path: `/optimizer/rule/${kind}/`, body: { rules: [{ actions: [{ subject_type: 'DAILY_BUDGET', value: { value: 99999 } }] }] } } };
    await expect(f.provider.previewWrite(op, { forcePausedCreation: true })).rejects.toThrow('scheduled-action budget');await expect(f.provider.applyWrite(op, { forcePausedCreation: true })).rejects.toThrow('scheduled-action budget');expect(f.calls).toHaveLength(0);
  });
});
