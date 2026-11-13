import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, creativesOutput, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import { xTools } from '../src/tools.js';
import { accountMediaIdentity, accountMediaUsage, deleteAccountMedia } from '../src/account-media-schemas.js';

// Official X v12 creatives/reference Account Media DELETE and campaign-management
// media_creatives GET, verified2026-11-06 against xdevplatform/docs09e643bc.
// The usage query has no documented account_media_id filter. Include tombstones.
const A = 'a1', S = 'am1', asset = { id: S, creative_type: 'PREROLL', video_id: '13_771791717175468032', media_url: 'https://video.twimg.com/qa.mp4', deleted: false };
const association = { id: 'mc1', line_item_id: 'l1', account_media_id: S, creative_type: 'PREROLL', landing_url: null, entity_status: 'ACTIVE', deleted: false };
type Call = { url: URL; init: RequestInit };
function fixture(options: { source?: Record<string, unknown>; references?: Record<string, unknown>[]; handler?(call: Call): unknown | Promise<unknown> } = {}) {
  const calls: Call[] = [], source = { ...asset, ...options.source }, references = structuredClone(options.references ?? []);
  const provider = new XAdsProvider(new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }, async (raw, init = {}) => {
    const call = { url: new URL(String(raw)), init };calls.push(call);const custom = await options.handler?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const path = call.url.pathname.replace(`/12/accounts/${A}`, '');
    if (init.method === 'GET') {
      if (!path) return Response.json({ data: { id: A, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false } });
      if (path === '/account_media/' + S) return Response.json({ data: source });
      if (path === '/media_creatives') return Response.json({ data: references, next_cursor: null });
    }
    if (init.method === 'DELETE' && path === '/account_media/' + S) { source.deleted = true;return Response.json({ data: source }); }
    throw new Error(`Unexpected synthetic request ${init.method} ${path}`);
  }));
  return { provider, calls, source, references };
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.init.method !== 'GET');
const operation = (payload: Record<string, unknown>, overrides: Partial<WriteOperation> = {}): WriteOperation => ({ provider: 'x', tool: 'x_delete_account_media', kind: 'remove', accountId: A, payload, ...overrides });
async function selection(f: ReturnType<typeof fixture>) { return { account_media_id: S, expected_context_hash: (await f.provider.accountMedia.usage(A, S)).context_hash, acknowledge_source_deletion: true as const }; }
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('Account Media identity and complete native usage', () => {
  it.each(['3_931236738554519552', '../am1', 'https://example.test/a'] as const)('rejects source-ID substitution: %s', value => {
    expect(accountMediaIdentity.safeParse({ account_id: A, account_media_id: value }).success).toBe(false);
  });
  it('requires a fresh hash and explicit acknowledgement; rejects media-library aliases', () => {
    expect(deleteAccountMedia.safeParse({ account_media_id: S }).success).toBe(false);
    expect(deleteAccountMedia.safeParse({ account_media_id: S, expected_context_hash: 'a'.repeat(64), acknowledge_source_deletion: false }).success).toBe(false);
    expect(accountMediaIdentity.safeParse({ account_id: A, account_media_id: S, media_key: '3_931236738554519552' }).success).toBe(false);
  });
  it('reads source/tombstones and account-wide references with exact documented query, without parent fan-out', async () => {
    const f = fixture({ references: [{ ...association, deleted: true }, { ...association, id: 'mc2', account_media_id: 'am2' }] }), result = await f.provider.accountMedia.usage(A, S);
    expect(result).toMatchObject({ can_delete: true, non_deleted_references: 0, scanned_associations: 2, references: [{ id: 'mc1', deleted: true }], truncated: false });
    expect(creativesOutput.safeParse(result).success).toBe(true);expect(result.creatives[0]!.actions[0]).toMatchObject({ tool: 'x_delete_account_media', arguments: { account_id: A, account_media_id: S, expected_context_hash: result.context_hash, acknowledge_source_deletion: true } });
    expect(Object.fromEntries(f.calls.find(call => call.url.pathname.endsWith('/media_creatives'))!.url.searchParams)).toEqual({ count: '1000', with_deleted: 'true' });
    expect(f.calls.find(call => call.url.pathname.endsWith('/account_media/' + S))!.url.searchParams.get('with_deleted')).toBe('true');
    expect(f.calls.some(call => /line_items|campaigns/.test(call.url.pathname))).toBe(false);expect(writes(f)).toEqual([]);
  });
  it.each(['ACTIVE', 'PAUSED', 'FUTURE'] as const)('treats any non-deleted association as a dependency regardless of %s status or parent availability', async status => {
    const f = fixture({ references: [{ ...association, entity_status: status, line_item_id: 'deletedparent' }] }), result = await f.provider.accountMedia.usage(A, S);
    expect(result).toMatchObject({ can_delete: false, non_deleted_references: 1 });expect(result.creatives[0]!.actions).toEqual([]);
    await expect(f.provider.previewWrite(operation({ account_media_id: S, expected_context_hash: result.context_hash, acknowledge_source_deletion: true }), { forcePausedCreation: true })).rejects.toThrow(/detach/);expect(writes(f)).toEqual([]);
  });
  it('keeps deleted sources visible without a new delete action', async () => {
    const f = fixture({ source: { deleted: true } }), result = await f.provider.accountMedia.usage(A, S);expect(result).toMatchObject({ can_delete: false, creatives: [{ status: 'DELETED', actions: [] }] });
    await expect(f.provider.previewWrite(operation({ account_media_id: S, expected_context_hash: result.context_hash, acknowledge_source_deletion: true }), { forcePausedCreation: true })).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(f)).toEqual([]);
  });
  it('binds source/reference configuration while ignoring timestamps, ordering and unrelated assets', async () => {
    const f = fixture({ references: [{ ...association, id: 'mc2', deleted: true }, { ...association, deleted: true }] }), before = await f.provider.accountMedia.usage(A, S);
    Object.assign(f.source, { updated_at: 'later' });f.references.reverse();f.references.push({ ...association, id: 'other', account_media_id: 'am2' });
    expect((await f.provider.accountMedia.usage(A, S)).context_hash).toBe(before.context_hash);
    f.references[0]!.landing_url = 'https://changed.test';expect((await f.provider.accountMedia.usage(A, S)).context_hash).not.toBe(before.context_hash);
    f.source.video_id = '13_771791717175468033';await expect(f.provider.previewWrite(operation({ account_media_id: S, expected_context_hash: before.context_hash, acknowledge_source_deletion: true }), { forcePausedCreation: true })).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(f)).toEqual([]);
  });
  it('finds dependencies on later pages and preserves native cursor parameters', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/media_creatives') ? { data: call.url.searchParams.has('cursor') ? [association] : [{ ...association, id: 'other', account_media_id: 'am2' }], next_cursor: call.url.searchParams.has('cursor') ? null : 'page-two' } : undefined }), result = await f.provider.accountMedia.usage(A, S);
    expect(result).toMatchObject({ can_delete: false, scanned_associations: 2, non_deleted_references: 1 });expect(f.calls.filter(call => call.url.pathname.endsWith('/media_creatives')).map(call => Object.fromEntries(call.url.searchParams))).toEqual([{ count: '1000', with_deleted: 'true' }, { count: '1000', with_deleted: 'true', cursor: 'page-two' }]);expect(writes(f)).toEqual([]);
  });
  it('pages reference details without weakening complete usage, and rejects stale continuation', async () => {
    const rows = Array.from({ length: 102 }, (_, index) => ({ ...association, id: 'mc' + String(index).padStart(3, '0'), deleted: index !== 101 })), f = fixture({ references: rows });
    const first = await f.provider.accountMedia.usage(A, S);expect(first.references).toHaveLength(50);expect(first).toMatchObject({ reference_total: 102, non_deleted_references: 1, can_delete: false, next_reference_offset: 50, usage_complete: true, references_truncated: true });expect(first.creatives[0]!.actions).toEqual([]);
    const second = await f.provider.accountMedia.usage(A, S, { reference_offset: 50, reference_limit: 100, expected_context_hash: first.context_hash });expect(second.references).toHaveLength(52);expect(second.references.at(-1)?.deleted).toBe(false);expect(second.references_truncated).toBe(false);expect(second).not.toHaveProperty('next_reference_offset');expect(second.context_hash).toBe(first.context_hash);
    f.references[0]!.deleted = false;await expect(f.provider.accountMedia.usage(A, S, { reference_offset: 50, expected_context_hash: first.context_hash })).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(f)).toEqual([]);
  });
  it.each([{ reference_offset: 1 }, { reference_limit: 101 }, { reference_offset: -1 }, { reference_offset: 10000 }, { reference_limit: 0 }, { reference_offset: 0.5 }])('rejects invalid or unbound reference detail pages %#', values => {
    expect(accountMediaUsage.safeParse({ account_id: A, account_media_id: S, ...values }).success).toBe(false);
  });
  it.each(['missing_cursor', 'empty_cursor', 'duplicate', 'cross_page_duplicate', 'repeated_cursor', 'endless', 'wrong_account', 'oversized'] as const)('does not authorize incomplete/invalid inventory: %s', async mode => {
    let page = 0;const f = fixture({ handler: call => {
      if (!call.url.pathname.endsWith('/media_creatives')) return undefined;page++;
      const row = { ...association, id: mode === 'cross_page_duplicate' ? 'same' : 'mc' + page, deleted: true, ...(mode === 'wrong_account' ? { account_id: 'other' } : {}) };
      return { data: mode === 'duplicate' ? [row, row] : mode === 'oversized' ? Array.from({ length: 1001 }, (_, index) => ({ ...row, id: 'mc' + index })) : [row], ...(mode === 'missing_cursor' ? {} : { next_cursor: mode === 'empty_cursor' ? '' : ['cross_page_duplicate', 'endless'].includes(mode) ? 'page' + page : mode === 'repeated_cursor' ? 'same' : null }) };
    } });
    await expect(f.provider.accountMedia.usage(A, S)).rejects.toThrow();expect(page).toBeLessThanOrEqual(10);expect(writes(f)).toEqual([]);
  });
  it.each([{ id: 'other' }, { account_id: 'other' }, { video_id: 931236738554519552 }])('rejects incorrect source identity or numeric media IDs %#', async value => {
    const f = fixture({ source: value });await expect(f.provider.accountMedia.usage(A, S)).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
});

describe('Account Media guarded source deletion', () => {
  it.each(['PREROLL', 'VAST_PREROLL', 'BANNER', 'FUTURE_FORMAT'])('deletes one unused %s source and verifies receipt plus independent usage/readback', async type => {
    const f = fixture({ source: { creative_type: type }, references: [{ ...association, deleted: true }, { ...association, id: 'unrelated', account_media_id: 'am2' }] }), input = await selection(f), op = operation(input), before = structuredClone(f.references);
    const preview = await f.provider.previewWrite(op, { forcePausedCreation: true });expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], review: { title: 'Delete Account Media', fields: expect.arrayContaining([{ label: 'Non-deleted ad associations', after: 0 }]) } });expect(writes(f)).toEqual([]);
    expect(await f.provider.applyWrite(op, { forcePausedCreation: true })).toEqual({ applied: true, resourceIds: [S] });expect(f.source.deleted).toBe(true);expect(f.references).toEqual(before);
    const request = writes(f)[0]!;expect(request.url.pathname).toBe(`/12/accounts/${A}/account_media/${S}`);expect(request.url.search).toBe('');expect(request.init.body).toBeUndefined();expect(request.init.headers).toMatchObject({ Authorization: expect.stringContaining('oauth_signature=') });expect(writes(f)).toHaveLength(1);
    expect(f.calls.filter(call => call.url.pathname.endsWith('/account_media/' + S) && call.init.method === 'GET')).toHaveLength(4);
  });
  it.each(['provider', 'kind', 'tool'] as const)('rejects an incorrect %s operation', async field => {
    const f = fixture(), input = await selection(f);await expect(f.provider.accountMedia.plan(operation(input, { [field]: field === 'provider' ? 'meta' : field === 'kind' ? 'update' : 'x_unknown' }))).rejects.toThrow();expect(writes(f)).toEqual([]);
  });
  it('revalidates fresh usage before apply, rather than deleting a newly referenced source', async () => {
    const f = fixture(), input = await selection(f), op = operation(input);await f.provider.previewWrite(op, { forcePausedCreation: true });f.references.push({ ...association });
    await expect(f.provider.applyWrite(op, { forcePausedCreation: true })).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(f)).toEqual([]);
  });
  it.each(['wrong_id', 'wrong_account', 'not_deleted', 'changed_source', 'malformed', 'envelope', 'http', 'network', 'readback_404', 'new_reference', 'readback_not_deleted'] as const)('retains known IDs and never replays an unconfirmed mutation: %s', async mode => {
    let submitted = false;const f = fixture({ handler: call => {
      if (call.init.method === 'DELETE') {
        submitted = true;
        if (mode === 'network') throw new Error('network');if (mode === 'http') return new Response('', { status: 400 });
        return { data: { ...asset, deleted: mode !== 'not_deleted', ...(mode === 'wrong_id' || mode === 'envelope' ? { id: 'other' } : mode === 'wrong_account' ? { account_id: 'other' } : mode === 'changed_source' ? { video_id: '13_771791717175468033' } : mode === 'malformed' ? { video_id: 1 } : {}) }, ...(mode === 'envelope' ? { errors: [{ code: 'ERROR' }] } : {}) };
      }
      if (submitted && call.url.pathname.endsWith('/account_media/' + S)) return mode === 'readback_404' ? new Response('', { status: 404 }) : { data: { ...asset, deleted: mode !== 'readback_not_deleted' } };
      if (submitted && mode === 'new_reference' && call.url.pathname.endsWith('/media_creatives')) return { data: [association], next_cursor: null };
      return undefined;
    } }), input = await selection(f);
    await expect(f.provider.applyWrite(operation(input), { forcePausedCreation: true })).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: expect.arrayContaining([S, ...(['wrong_id', 'envelope'].includes(mode) ? ['other'] : [])]) } });expect(writes(f)).toHaveLength(1);
  });
  it('uses the shared registry pending token, protected-account gate, audit and consumed-approval semantics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-account-media-'));dirs.push(dir);const f = fixture(), input = await selection(f), args = { account_id: A, ...input };
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: xTools(f.provider) }] });
    const preview = await runtime.registry.call('x_delete_account_media', args, runtime.ctx) as { status: string; pending_operation_id: string };expect(preview.status).toBe('pending_validation');expect(writes(f)).toEqual([]);
    await expect(runtime.registry.call('x_delete_account_media', { ...args, account_media_id: 'am2', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(writes(f)).toEqual([]);
    expect(await runtime.registry.call('x_delete_account_media', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toMatchObject({ status: 'applied', result: { resourceIds: [S] } });
    await expect(runtime.registry.call('x_delete_account_media', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(writes(f)).toHaveLength(1);
    const audit = (await Promise.all((await readdir(join(dir, 'audit'))).map(name => readFile(join(dir, 'audit', name), 'utf8')))).join('\n');expect(audit).toContain('validated');expect(audit).toContain('applied');expect(audit).not.toContain('oauth_signature');
    const blocked = await createContext({ engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(join(dir, 'blocked-pending')), new AuditLog(join(dir, 'blocked-audit'))), providerModules: [{ provider: f.provider, tools: xTools(f.provider) }] });
    await expect(blocked.registry.call('x_delete_account_media', args, blocked.ctx)).rejects.toThrow(/protected/i);expect(writes(f)).toHaveLength(1);
  });
});
