import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';

const accountId = '18ce0000qa1', audienceId = '2906h';
const account = { id: accountId, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false };
const source = { id: audienceId, name: 'QA <audience>', description: null, audience_type: 'CRM', permission_level: 'READ_WRITE', owner_account_id: accountId, deleted: false, targetable: false, targetable_types: ['CRM', 'EXCLUDED_CRM'], reasons_not_targetable: ['TOO_SMALL'], partner_source: 'OTHER', audience_size: null };
const line = { id: 'line1', campaign_id: 'camp1', name: null, currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'WEBSITE_CLICKS' };
type Row = Record<string, unknown>;
type Call = { url: URL; init: RequestInit };
type Options = { current?: Row; rows?: Row[]; targets?: Row[]; permissions?: Row[]; lines?: Row[]; criteria?: Row[]; ignoreWrite?: boolean; readbackError?: boolean; handler?: (call: Call, written: boolean) => unknown };
function fixture(options: Options = {}) {
  const calls: Call[] = [];let current: Row = structuredClone(options.current ?? source), written = false;
  const client = new XAdsClient({ consumerKey: 'inert-key', consumerSecret: 'inert-secret', accessToken: 'inert-token', accessTokenSecret: 'inert-token-secret' }, async (input, init = {}) => {
    const call = { url: new URL(String(input)), init };calls.push(call);
    const custom = options.handler?.(call, written);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const route = call.url.pathname.replace(`/12/accounts/${accountId}`, ''), params = Object.fromEntries(call.url.searchParams);
    const response = (data: unknown, paged = false) => Response.json({ data, ...(paged ? { next_cursor: null } : {}), request: { params: { account_id: accountId, ...(route.includes(`custom_audiences/${audienceId}`) ? { custom_audience_id: audienceId } : {}) } } });
    if (init.method === 'GET') {
      if (route === '') return response(account);
      if (route === '/line_items') return response(options.lines ?? [], true);
      if (route === '/targeting_criteria') return response(options.criteria ?? [], true);
      if (route.endsWith('/targeted')) return response(options.targets ?? [], true);
      if (route.endsWith('/permissions')) return response(options.permissions ?? [], true);
      if (route === '/custom_audiences') return response(options.rows ?? [current], true);
      if (route === `/custom_audiences/${audienceId}`) {
        if (written && options.readbackError) return Response.json({}, { status: 403 });
        return response(current);
      }
    }
    if (route === '/custom_audiences' && init.method === 'POST') { written = true;current = { ...source, ...params };return response(current); }
    if (route === `/custom_audiences/${audienceId}/users` && init.method === 'POST') {
      written = true;const ops = JSON.parse(String(init.body)) as Array<{ params: { users: unknown[] } }>, count = ops.reduce((n, value) => n + value.params.users.length, 0);return response({ success_count: count, total_count: count });
    }
    if (route === `/custom_audiences/${audienceId}` && ['PUT', 'DELETE'].includes(String(init.method))) {
      written = true;if (!options.ignoreWrite) current = { ...current, ...params, ...(init.method === 'DELETE' ? { deleted: true } : {}) };return response(current);
    }
    throw new Error('Unexpected fixture endpoint');
  });
  const provider = new XAdsProvider(client), tools = xTools(provider);
  const op = (tool: string, payload: Row): WriteOperation => ({ tool, provider: 'x', accountId, kind: tool === 'x_create_custom_audience' ? 'create' : tool === 'x_delete_custom_audience' ? 'remove' : 'update', payload });
  return { calls, provider, service: provider.audiences, tools, op, current: () => current, mutate: (value: Row) => { current = { ...current, ...value }; } };
}
const writes = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET');
const guard = { forcePausedCreation: true };
const members = [{ operation_type: 'Update', params: { users: [{ email: ['a'.repeat(64)], partner_user_id: ['private-partner-id'] }, { twitter_id: ['b'.repeat(64)] }] } }, { operation_type: 'Delete', params: { users: [{ device_id: ['c'.repeat(64)] }], effective_at: '2030-01-01T00:00:00Z', expires_at: '2030-02-01T00:00:00Z' } }];

// Provider-owned v12 reference4e8f626; SDKa3dd581 confirms JSON users and user-count receipts.
describe('X native custom-audience lifecycle', () => {
  it('uses signed v12 query filters, exact IDs and native readiness diagnostics', async () => {
    const f = fixture(), result = await f.service.list({ account_id: accountId, custom_audience_ids: [audienceId], q: 'qa', count: 5, with_total_count: true });
    const call = f.calls.at(-1)!;expect(call.url.pathname).toBe(`/12/accounts/${accountId}/custom_audiences`);expect(Object.fromEntries(call.url.searchParams)).toEqual({ permission_scope: 'OWNER', with_deleted: 'false', q: 'qa', count: '5', custom_audience_ids: audienceId, with_total_count: 'true' });
    expect(new Headers(call.init.headers).get('authorization')).toMatch(/^OAuth /);expect(result).toMatchObject({ data: [{ ...source, configuration_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }], records: [{ id: audienceId, name: source.name, status: 'Not targetable', audience_size: 'Not reported' }], complete: true, truncated: false });expect(writes(f.calls)).toHaveLength(0);
  });
  it('omits the native total-count flag on continuation while retaining the original tool selection', async () => {
    const f = fixture();await f.service.list({ account_id: accountId, cursor: 'next', with_total_count: true });
    const url = f.calls.at(-1)!.url;expect(url.searchParams.get('cursor')).toBe('next');expect(url.searchParams.has('with_total_count')).toBe(false);
  });
  it('keeps configuration snapshots stable across size/processing diagnostics and binds real metadata', async () => {
    const f = fixture(), before = (await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience;
    f.mutate({ audience_size: 500, targetable: true, updated_at: '2026-11-05T00:00:00Z' });expect((await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience.configuration_hash).toBe(before.configuration_hash);
    f.mutate({ name: 'Renamed elsewhere' });expect((await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience.configuration_hash).not.toBe(before.configuration_hash);
  });
  it('reads explicitly shared audiences without granting mutation rights', async () => {
    const f = fixture({ current: { ...source, owner_account_id: 'other', permission_level: 'READ_ONLY' } });
    expect((await f.service.list({ account_id: accountId, permission_scope: 'SHARED' })).records).toHaveLength(1);
    const current = (await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience;
    await expect(f.provider.previewWrite(f.op('x_update_custom_audience', { custom_audience_id: audienceId, expected_configuration_hash: current.configuration_hash, name: 'QA' }), guard)).rejects.toThrow('owned and writable');expect(writes(f.calls)).toHaveLength(0);
  });
  it.each([
    { data: [source] },
    { data: [], next_cursor: undefined },
  ])('does not claim completeness without a native cursor marker: %o', async page => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/custom_audiences') ? page : undefined });expect(await f.service.list({ account_id: accountId })).toMatchObject({ complete: null, truncated: true });
  });
  it.each([
    { data: [source], next_cursor: 'same' }, { data: [source, source], next_cursor: null }, { data: [source], next_cursor: null, request: { params: { account_id: 'other' } } },
    { data: [{ ...source, owner_account_id: 'other' }], next_cursor: null }, { data: [{ ...source, deleted: true }], next_cursor: null }, { data: [], next_cursor: null, total_count: 4 },
  ])('rejects repeated, foreign or contradictory pages: %o', async page => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/custom_audiences') ? page : undefined });await expect(f.service.list({ account_id: accountId, ...(page.next_cursor === 'same' ? { cursor: 'same' } : {}) })).rejects.toThrow('x:');
  });
  it('rejects ignored ID/name filters and malformed resource IDs', async () => {
    const f = fixture();await expect(f.service.list({ account_id: accountId, custom_audience_ids: ['missing'] })).rejects.toThrow('filters');await expect(f.service.list({ account_id: accountId, q: 'Different' })).rejects.toThrow('filters');
    await expect(f.service.get({ account_id: accountId, custom_audience_id: '../bad' })).rejects.toThrow();
  });
  it('creates only an empty CRM placeholder after a read-only local preview and verifies independent readback', async () => {
    const f = fixture(), op = f.op('x_create_custom_audience', { name: 'QA + Ü', description: 'Private QA' });
    expect(await f.provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [] });expect(writes(f.calls)).toHaveLength(0);
    expect(await f.provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: [audienceId] });const call = writes(f.calls)[0]!;
    expect(call.url.pathname).toBe(`/12/accounts/${accountId}/custom_audiences`);expect(Object.fromEntries(call.url.searchParams)).toEqual({ name: 'QA + Ü', description: 'Private QA' });expect(call.url.href).toContain('%20');expect(call.init.body).toBeUndefined();expect(f.calls.at(-1)!.url.pathname).toContain(`custom_audiences/${audienceId}`);
  });
  it('preserves omitted metadata and exposes observed before/after fields', async () => {
    const f = fixture({ current: { ...source, description: 'Keep this' } }), current = (await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience;
    const op = f.op('x_update_custom_audience', { custom_audience_id: audienceId, expected_configuration_hash: current.configuration_hash, name: 'Renamed' });
    expect((await f.provider.previewWrite(op, guard)).review?.fields).toEqual([{ label: 'Name', before: source.name, after: 'Renamed' }]);await f.provider.applyWrite(op, guard);
    expect(Object.fromEntries(writes(f.calls)[0]!.url.searchParams)).toEqual({ name: 'Renamed' });expect(f.current().description).toBe('Keep this');
  });
  it('rejects stale metadata and unverified ownership before writes', async () => {
    const f = fixture(), current = (await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience;f.mutate({ name: 'Elsewhere' });
    await expect(f.provider.applyWrite(f.op('x_update_custom_audience', { custom_audience_id: audienceId, expected_configuration_hash: current.configuration_hash, description: 'QA' }), guard)).rejects.toThrow('configuration changed');expect(writes(f.calls)).toHaveLength(0);
    for (const change of [{ owner_account_id: undefined }, { is_owner: false }, { permission_level: 'READ_ONLY' }]) {
      const other = fixture({ current: { ...source, ...change } }), value = (await other.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience;
      await expect(other.provider.applyWrite(other.op('x_update_custom_audience', { custom_audience_id: audienceId, expected_configuration_hash: value.configuration_hash, name: 'QA' }), guard)).rejects.toThrow('owned and writable');expect(writes(other.calls)).toHaveLength(0);
    }
  });
  it.each([{ ignoreWrite: true }, { readbackError: true }])('retains known IDs and never retries an unconfirmed update: %o', async options => {
    const f = fixture(options), current = (await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience;
    await expect(f.provider.applyWrite(f.op('x_update_custom_audience', { custom_audience_id: audienceId, expected_configuration_hash: current.configuration_hash, name: 'New' }), guard)).rejects.toMatchObject({ details: { resource_ids: [audienceId] } });expect(writes(f.calls)).toHaveLength(1);
  });
  it('keeps member identifiers out of previews and sends the exact JSON batch once', async () => {
    const f = fixture(), current = (await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience, op = f.op('x_update_custom_audience_users', { custom_audience_id: audienceId, expected_configuration_hash: current.configuration_hash, operations: members });
    const preview = await f.provider.previewWrite(op, guard);for (const secret of ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'private-partner-id']) expect(JSON.stringify(preview)).not.toContain(secret);expect(preview.review?.fields[0]).toMatchObject({ label: 'Update', after: '2 user records' });
    const receipt = await f.provider.applyWrite(op, guard);expect(receipt).toMatchObject({ resourceIds: [audienceId], details: { outcome: 'ACCEPTED_FOR_PROCESSING', accepted_records: 3, readiness_confirmed: false } });
    const call = writes(f.calls)[0]!;expect(call.url.pathname).toBe(`/12/accounts/${accountId}/custom_audiences/${audienceId}/users`);expect(call.url.search).toBe('');expect(JSON.parse(String(call.init.body))).toEqual(members);expect(new Headers(call.init.headers).get('content-type')).toBe('application/json');expect(writes(f.calls)).toHaveLength(1);
  });
  it.each([{ data: { success_count: 2, total_count: 3 } }, { data: { success_count: 2, total_count: 2 } }, { operation_errors: [{ message: 'bad item' }], data: { success_count: 3, total_count: 3 } }])('never reports a partial or unverifiable member submission as applied: %o', async response => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/users') ? response : undefined }), current = (await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience;
    await expect(f.provider.applyWrite(f.op('x_update_custom_audience_users', { custom_audience_id: audienceId, expected_configuration_hash: current.configuration_hash, operations: members }), guard)).rejects.toMatchObject({ details: { resource_ids: [audienceId], batch_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });expect(writes(f.calls)).toHaveLength(1);
  });
  it.each([401, 403, 429])('preserves an actionable native HTTP%s rejection without retry', async status => {
    const f = fixture({ handler: call => call.init.method === 'POST' ? Response.json({}, { status }) : undefined });
    await expect(f.provider.applyWrite(f.op('x_create_custom_audience', { name: 'QA' }), guard)).rejects.toMatchObject({ details: { http_status: status } });expect(writes(f.calls)).toHaveLength(1);
  });
  it('finds inactive usage, negative criteria and sharing without dropping native context', async () => {
    const f = fixture({ lines: [line], targets: [{ campaign_id: 'camp1', line_items: [{ id: 'line1', name: null, servable: false }] }], permissions: [{ id: 'p1', custom_audience_id: audienceId, granted_account_id: 'other', permission_level: 'READ_ONLY', deleted: false }], criteria: [{ id: 'cr1', line_item_id: 'line1', targeting_type: 'CUSTOM_AUDIENCE', targeting_value: audienceId, operator_type: 'NE', deleted: false }] });
    const usage = await f.service.usage(accountId, audienceId);expect(usage).toMatchObject({ complete: true, references: [{ servable: false }], criteria: [{ operator_type: 'NE' }], permissions: [{ id: 'p1' }] });
    expect(f.calls.find(call => call.url.pathname.endsWith('/targeted'))!.url.searchParams.get('with_active')).toBe('false');expect(f.calls.find(call => call.url.pathname.endsWith('/targeting_criteria'))!.url.searchParams.get('line_item_ids')).toBe('line1');
    await expect(f.provider.applyWrite(f.op('x_delete_custom_audience', { custom_audience_id: audienceId, expected_configuration_hash: usage.audience.configuration_hash, expected_usage_hash: usage.usage_hash }), guard)).rejects.toThrow('before deletion');expect(writes(f.calls)).toHaveLength(0);
  });
  it('deletes an unreferenced unshared audience only after a complete usage scan and independent deleted readback', async () => {
    const f = fixture(), usage = await f.service.usage(accountId, audienceId), op = f.op('x_delete_custom_audience', { custom_audience_id: audienceId, expected_configuration_hash: usage.audience.configuration_hash, expected_usage_hash: usage.usage_hash });
    expect(await f.provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: [audienceId] });expect(writes(f.calls)).toHaveLength(1);expect(writes(f.calls)[0]!.init.method).toBe('DELETE');expect(f.calls.at(-1)!.url.searchParams.get('with_deleted')).toBe('true');
  });
  it.each(['inactive', 'exclusion', 'sharing'])('blocks deletion for an isolated %s reference', async dependency => {
    const f = fixture({ lines: dependency === 'sharing' ? [] : [line],
      targets: dependency === 'inactive' ? [{ campaign_id: 'camp1', line_items: [{ id: 'line1', servable: false }] }] : [],
      criteria: dependency === 'exclusion' ? [{ id: 'cr1', line_item_id: 'line1', targeting_type: 'CUSTOM_AUDIENCE_EXPANDED', targeting_value: audienceId, operator_type: 'NE', deleted: false }] : [],
      permissions: dependency === 'sharing' ? [{ id: 'p1', custom_audience_id: audienceId, granted_account_id: 'other', permission_level: 'READ_ONLY', deleted: false }] : [],
    });
    const usage = await f.service.usage(accountId, audienceId);
    await expect(f.provider.applyWrite(f.op('x_delete_custom_audience', { custom_audience_id: audienceId, expected_configuration_hash: usage.audience.configuration_hash, expected_usage_hash: usage.usage_hash }), guard)).rejects.toThrow('before deletion');expect(writes(f.calls)).toHaveLength(0);
  });
  it('rejects a sharing grant added after the approved usage snapshot', async () => {
    const permissions: Row[] = [], f = fixture({ permissions }), usage = await f.service.usage(accountId, audienceId);
    permissions.push({ id: 'p1', custom_audience_id: audienceId, granted_account_id: 'other', permission_level: 'READ_ONLY', deleted: false });
    await expect(f.provider.applyWrite(f.op('x_delete_custom_audience', { custom_audience_id: audienceId, expected_configuration_hash: usage.audience.configuration_hash, expected_usage_hash: usage.usage_hash }), guard)).rejects.toThrow('usage changed');expect(writes(f.calls)).toHaveLength(0);
  });
  it('retains the created ID when readback is denied and performs no automatic cleanup', async () => {
    const f = fixture({ readbackError: true });await expect(f.provider.applyWrite(f.op('x_create_custom_audience', { name: 'QA' }), guard)).rejects.toMatchObject({ details: { resource_ids: [audienceId] } });
    expect(writes(f.calls)).toHaveLength(1);expect(writes(f.calls)[0]!.init.method).toBe('POST');
  });
  it.each(['targeted', 'permissions', 'line_items'])('fails closed when %s scan completeness is unknown', async suffix => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/' + suffix) ? { data: [] } : undefined });await expect(f.service.usage(accountId, audienceId)).rejects.toThrow('completeness');expect(writes(f.calls)).toHaveLength(0);
  });
  it('rejects foreign targeting parents, permissions and repeated cross-page usage rows', async () => {
    await expect(fixture({ targets: [{ campaign_id: 'other', line_items: [{ id: 'line1', servable: false }] }], lines: [line] }).service.usage(accountId, audienceId)).rejects.toThrow('hierarchy');
    await expect(fixture({ permissions: [{ id: 'p1', custom_audience_id: 'other', granted_account_id: 'other', permission_level: 'READ_ONLY', deleted: false }] }).service.usage(accountId, audienceId)).rejects.toThrow('another audience');
    const f = fixture({ handler: call => call.url.pathname.endsWith('/targeted') ? { data: [{ campaign_id: 'camp1', line_items: [] }], next_cursor: call.url.searchParams.get('cursor') ? null : 'next' } : undefined });await expect(f.service.usage(accountId, audienceId)).rejects.toThrow('repeated');
  });
  it('rejects plaintext identifiers, bad expiry, empty metadata and oversized batches before native requests', async () => {
    const f = fixture(), schema = f.tools.find(tool => tool.name === 'x_update_custom_audience_users')!.input, base = { account_id: accountId, custom_audience_id: audienceId, expected_configuration_hash: 'e'.repeat(64) };
    for (const operations of [[{ operation_type: 'Update', params: { users: [{ email: ['raw@example.test'] }] } }], [{ operation_type: 'Update', params: { users: [{}] } }], [{ operation_type: 'Update', params: { users: [{ email: ['a'.repeat(64)] }], effective_at: '2030-02-01T00:00:00Z', expires_at: '2030-01-01T00:00:00Z' } }]]) expect(schema.safeParse({ ...base, operations }).success).toBe(false);
    expect(schema.safeParse({ ...base, operations: [{ operation_type: 'Update', params: { users: Array.from({ length: 100 }, () => ({ partner_user_id: Array.from({ length: 100 }, () => 'x'.repeat(600)) })) } }] }).success).toBe(false);
    expect(f.tools.find(tool => tool.name === 'x_update_custom_audience')!.input.safeParse(base).success).toBe(false);expect(writes(f.calls)).toHaveLength(0);
  });
  it('uses shared approval hashing, one-use tokens and an audit without exposing member identifiers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-x-audience-'));const f = fixture();
    try {
      const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: f.tools }] }), current = (await f.service.get({ account_id: accountId, custom_audience_id: audienceId })).audience;
      const args = { account_id: accountId, custom_audience_id: audienceId, expected_configuration_hash: current.configuration_hash, operations: members }, name = 'x_update_custom_audience_users';
      const preview = await runtime.registry.call(name, args, runtime.ctx) as { pending_operation_id: string };expect(writes(f.calls)).toHaveLength(0);expect(JSON.stringify(preview)).not.toContain('private-partner-id');
      await expect(runtime.registry.call(name, { ...args, operations: members.slice(0, 1), pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
      expect(await runtime.registry.call(name, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toHaveProperty('result.details.outcome', 'ACCEPTED_FOR_PROCESSING');
      await expect(runtime.registry.call(name, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(writes(f.calls)).toHaveLength(1);
      const audit = (await Promise.all((await readdir(join(dir, 'audit'))).map(file => readFile(join(dir, 'audit', file), 'utf8')))).join('');expect(audit).toContain('applied');expect(audit).not.toContain('private-partner-id');expect(audit).not.toContain('a'.repeat(64));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
