import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, creativesOutput, DEFAULT_POLICY, nextPageArguments, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { createPromotedAccount, promotedAccountList, promotedAccountSelection } from '../src/promoted-account-schemas.js';
import { xTools } from '../src/tools.js';
import { A, L, U, U2, P, association, campaign, line, mutations, promotedAccountFixture as fixture, user } from './promoted-account-fixture.js';

// Official X v12 campaign-management reference09e643bc, refreshed2026-11-06:
// POST takes line_item_id/user_id query parameters; DELETE returns a tombstone.
// No promoted_accounts PUT exists. All API payloads here are synthetic.
const selection = { line_item_id: L, user_id: U }, guard = { forcePausedCreation: true };
const op = (tool: string, payload: Record<string, unknown>): WriteOperation => ({ tool, accountId: A, provider: 'x', kind: tool === 'x_create_promoted_account' ? 'create' : 'remove', payload });
const create = async (f: ReturnType<typeof fixture>) => ({ ...selection, expected_context_hash: (await f.provider.promotedAccounts.context(A, selection)).context_hash, acknowledge_active_association: true as const, acknowledge_live_profile: true as const });
const remove = async (f: ReturnType<typeof fixture>) => ({ promoted_account_id: P, expected_context_hash: (await f.provider.promotedAccounts.get(A, P)).context_hash });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('promoted-account identity, scope and pagination contracts', () => {
  it.each([{ ...selection, user_id: Number(U) }, { ...selection, user_id: '0' }, { ...selection, user_id: '../profile' }, { ...selection, line_item_id: '../group' }, { ...selection, status: 'PAUSED' }, { ...selection, profile_text: 'edit' }])('rejects unsupported or lossy profile selection %#', input => {
    expect(promotedAccountSelection.safeParse(input).success).toBe(false);
  });
  it('requires explicit live-profile/ACTIVE acknowledgements and a bounded gallery page', () => {
    const input = { ...selection, expected_context_hash: 'a'.repeat(64), acknowledge_active_association: true, acknowledge_live_profile: true };
    expect(createPromotedAccount.safeParse(input).success).toBe(true);
    expect(createPromotedAccount.safeParse({ ...input, acknowledge_active_association: false }).success).toBe(false);
    expect(createPromotedAccount.safeParse({ ...input, acknowledge_live_profile: false }).success).toBe(false);
    expect(promotedAccountList.safeParse({ account_id: A, line_item_id: L, count: 51 }).success).toBe(false);
  });
  it('pages profile references without inventing artwork or independent status controls', async () => {
    const f = fixture({ associations: [association, { ...association, id: 'pa2', user_id: U2 }] }), input = { account_id: A, line_item_id: L, count: 1 }, first = await f.provider.promotedAccounts.list(input);
    expect(creativesOutput.safeParse(first).success).toBe(true);expect(first).toMatchObject({ truncated: true, next_cursor: '1', creatives: [{ id: P, status: 'ACTIVE', media: [], landing_urls: [`https://x.com/i/user/${U}`] }] });
    expect(first.creatives[0]!.actions).toHaveLength(1);expect(first.creatives[0]!.actions[0]!.tool).toBe('x_delete_promoted_account');
    const next = nextPageArguments(xTools(f.provider).find(tool => tool.name === 'x_promoted_accounts')!, input, first);
    expect(next).toEqual({ ...input, cursor: '1' });expect((await f.provider.promotedAccounts.list(next as typeof input)).creatives[0]!.id).toBe('pa2');
    const request = f.calls.find(call => call.url.pathname.endsWith('/promoted_accounts'))!;expect(Object.fromEntries(request.url.searchParams)).toEqual({ line_item_ids: L, count: '1', with_deleted: 'false' });expect(mutations(f)).toEqual([]);
    expect(first.items[0]!.context_hash).toBe((await f.provider.promotedAccounts.get(A, P)).context_hash);
  });
  it('retains every valid row and the native cursor when X exceeds the requested page size', async () => {
    const f = fixture({ handler: call => call.url.pathname.endsWith('/promoted_accounts') ? { data: [association, { ...association, id: 'pa2', user_id: U2 }], next_cursor: 'native-next' } : undefined }), input = { account_id: A, line_item_id: L, count: 1 };
    const result = await f.provider.promotedAccounts.list(input);expect(result.items).toHaveLength(2);expect(result.creatives).toHaveLength(2);expect(result).toMatchObject({ truncated: true, next_cursor: 'native-next' });
    expect(nextPageArguments(xTools(f.provider).find(tool => tool.name === 'x_promoted_accounts')!, input, result)).toEqual({ ...input, cursor: 'native-next' });expect(mutations(f)).toEqual([]);
  });
  it.each(['account', 'line', 'deleted', 'duplicate', 'cursor'] as const)('rejects incorrect gallery scope/filter/pagination: %s', async mode => {
    const row = { ...association, ...(mode === 'account' ? { account_id: 'other' } : mode === 'line' ? { line_item_id: 'other' } : mode === 'deleted' ? { deleted: true } : {}) };
    const f = fixture({ handler: call => call.url.pathname.endsWith('/promoted_accounts') ? { data: mode === 'duplicate' ? [row, row] : [row], next_cursor: mode === 'cursor' ? 'same' : null } : undefined });
    await expect(f.provider.promotedAccounts.list({ account_id: A, line_item_id: L, count: 20, ...(mode === 'cursor' ? { cursor: 'same' } : {}) })).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it('retains missing continuation and deleted tombstone uncertainty without a write action', async () => {
    const unknown = fixture({ handler: call => call.url.pathname.endsWith('/promoted_accounts') ? { data: [] } : undefined });expect(await unknown.provider.promotedAccounts.list({ account_id: A, line_item_id: L })).toMatchObject({ truncated: true, notes: [expect.stringContaining('unconfirmed')] });
    const deleted = fixture({ associations: [{ ...association, deleted: true }] }), list = await deleted.provider.promotedAccounts.list({ account_id: A, line_item_id: L, with_deleted: true });expect(list.creatives[0]).toMatchObject({ status: 'DISASSOCIATED', actions: [] });expect(mutations(deleted)).toEqual([]);
  });
  it.each(['account', 'resource', 'parent', 'currency'] as const)('rejects exact lookup scope mismatch: %s', async mode => {
    const f = fixture({ associations: [association], ...(mode === 'currency' ? { line: { currency: 'EUR' } } : {}), handler: call => call.url.pathname.endsWith('/promoted_accounts/' + P) ? { data: { ...association, ...(mode === 'account' ? { account_id: 'other' } : mode === 'resource' ? { id: 'wrong' } : mode === 'parent' ? { line_item_id: 'wrong' } : {}) } } : undefined });
    await expect(f.provider.promotedAccounts.get(A, P)).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it.each(['account_deleted', 'line_deleted', 'campaign_deleted', 'draft', 'product', 'objective', 'retweets', 'missing_user', 'deleted_user', 'duplicate_user', 'foreign_user'] as const)('declines ineligible creation context: %s', async mode => {
    const users = mode === 'missing_user' ? [] : mode === 'duplicate_user' ? [user, { ...user, id: 'pu2' }] : [{ ...user, ...(mode === 'retweets' ? { promotable_user_type: 'RETWEETS_ONLY' } : mode === 'deleted_user' ? { deleted: true } : mode === 'foreign_user' ? { account_id: 'other' } : {}) }];
    const f = fixture({ users, account: mode === 'account_deleted' ? { deleted: true } : {}, line: mode === 'line_deleted' ? { deleted: true } : mode === 'draft' ? { entity_status: 'DRAFT' } : mode === 'product' ? { product_type: 'PROMOTED_TWEETS' } : mode === 'objective' ? { objective: 'REACH' } : {}, campaign: mode === 'campaign_deleted' ? { deleted: true } : {} });
    await expect(f.provider.promotedAccounts.context(A, selection)).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it.each(['missing', 'repeated_cursor', 'repeated_id', 'too_many_pages', 'users_incomplete'] as const)('requires complete bounded creation inventories: %s', async mode => {
    let page = 0;const f = fixture({ handler: call => {
      if (mode === 'users_incomplete' && call.url.pathname.endsWith('/promotable_users')) return { data: [user] };
      if (!call.url.pathname.endsWith('/promoted_accounts')) return undefined;
      page++;return { data: mode === 'repeated_id' ? [{ ...association, user_id: U2 }] : [], ...(mode === 'missing' ? {} : { next_cursor: mode === 'repeated_cursor' || mode === 'repeated_id' ? 'same' : 'page' + page }) };
    } });
    await expect(f.provider.promotedAccounts.context(A, selection)).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
});

describe('guarded promoted-account association lifecycle', () => {
  it('creates once with exact signed native query fields, retained parents and independent readback', async () => {
    const f = fixture(), payload = await create(f), operation = op('x_create_promoted_account', payload), before = structuredClone({ line: f.parent, campaign: f.funding, users: f.users });
    const preview = await f.provider.previewWrite(operation, guard);expect(preview.serverValidated).toBe(false);expect(preview.review?.fields).toContainEqual({ label: 'Native association status', after: 'ACTIVE' });expect(preview.budgetDeltas).toContainEqual({ target: 'l1 daily_budget_amount_local_micro existing pool', currency: 'USD', fromMicros: 5_000_000, toMicros: 5_000_000 });expect(mutations(f)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [P] });
    const request = mutations(f)[0]!;expect(request.url.pathname).toBe(`/12/accounts/${A}/promoted_accounts`);expect(Object.fromEntries(request.url.searchParams)).toEqual(selection);expect(request.init.body).toBeUndefined();expect(request.init.headers).toMatchObject({ Authorization: expect.stringContaining('oauth_signature=') });expect(mutations(f)).toHaveLength(1);
    expect(f.calls.filter(call => call.init.method === 'GET' && call.url.pathname.endsWith('/promoted_accounts/' + P))).toHaveLength(1);expect({ line: f.parent, campaign: f.funding, users: f.users }).toEqual(before);
  });
  it('enforces a PAUSED ad group even under a paused campaign and reports active delivery when policy permits it', async () => {
    const f = fixture({ line: { entity_status: 'ACTIVE' } }), payload = await create(f);await expect(f.provider.previewWrite(op('x_create_promoted_account', payload), guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(mutations(f)).toEqual([]);
    expect((await f.provider.previewWrite(op('x_create_promoted_account', payload), { forcePausedCreation: false })).review?.fields).toContainEqual({ label: 'Parent delivery', after: 'ACTIVE' });
  });
  it.each(['identity', 'permission', 'budget', 'schedule', 'inventory'] as const)('invalidates approved creation context on %s drift', async mode => {
    const f = fixture(), payload = await create(f);
    if (mode === 'identity') f.users[0]!.id = 'pu2';if (mode === 'permission') f.users[0]!.promotable_user_type = 'RETWEETS_ONLY';if (mode === 'budget') f.funding.daily_budget_amount_local_micro++;if (mode === 'schedule') Object.assign(f.parent, { end_time: '2027-01-01T00:00:00Z' });if (mode === 'inventory') f.associations.push({ ...association, user_id: U2 });
    await expect(f.provider.applyWrite(op('x_create_promoted_account', payload), guard)).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it('rejects an already promoted user and ignores association ordering/approval echoes in hashes', async () => {
    const duplicate = fixture({ associations: [association] });await expect(duplicate.provider.previewWrite(op('x_create_promoted_account', await create(duplicate)), guard)).rejects.toThrow('already promoted');expect(mutations(duplicate)).toEqual([]);
    const f = fixture({ associations: [{ ...association, id: 'pa2', user_id: U2 }, { ...association, id: 'pa3', user_id: '771791717175468034' }] }), a = await f.provider.promotedAccounts.context(A, selection);f.associations.reverse();f.associations[0]!.approval_status = 'PENDING';expect((await f.provider.promotedAccounts.context(A, selection)).context_hash).toBe(a.context_hash);
  });
  it.each(['user', 'line', 'account', 'inactive', 'deleted', 'existing_id', 'readback', 'parent_drift', 'schema', 'envelope', 'transport'] as const)('retains known IDs without retry after unconfirmed creation: %s', async mode => {
    let submitted = false;const f = fixture({ associations: mode === 'existing_id' ? [{ ...association, user_id: U2 }] : [], handler: call => {
      if (call.init.method === 'POST') { submitted = true;if (mode === 'transport') throw new Error('private transport');if (mode === 'schema') return { data: { id: P } };if (mode === 'envelope') return { data: association, errors: [{ message: 'private provider detail' }] };return { data: { ...association, ...(mode === 'user' ? { user_id: U2 } : mode === 'line' ? { line_item_id: 'other' } : mode === 'account' ? { account_id: 'other' } : mode === 'inactive' ? { entity_status: 'PAUSED' } : mode === 'deleted' ? { deleted: true } : {}) } }; }
      if (submitted && call.url.pathname.endsWith('/promoted_accounts/' + P)) return { data: { ...association, ...(mode === 'readback' ? { user_id: U2 } : {}) } };
      if (submitted && mode === 'parent_drift' && call.url.pathname.endsWith('/line_items/' + L)) return { data: { ...line, entity_status: 'ACTIVE' } };return undefined;
    } });
    const error = await f.provider.applyWrite(op('x_create_promoted_account', await create(f)), guard).catch(error => error);expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: mode === 'transport' ? [] : [P] } });expect(error.message).not.toContain('private');expect(mutations(f)).toHaveLength(1);
  });
  it('removes one exact association, retains other references and allows native ACTIVE tombstones', async () => {
    const f = fixture({ associations: [association, { ...association, id: 'pa2', user_id: U2 }] }), payload = await remove(f), before = structuredClone({ parent: f.parent, funding: f.funding, users: f.users, other: f.associations[1] });
    expect(await f.provider.applyWrite(op('x_delete_promoted_account', payload), guard)).toEqual({ applied: true, resourceIds: [P] });expect(f.associations[0]).toMatchObject({ deleted: true, entity_status: 'ACTIVE' });expect({ parent: f.parent, funding: f.funding, users: f.users, other: f.associations[1] }).toEqual(before);
    expect(mutations(f)).toHaveLength(1);expect(mutations(f)[0]!.url.pathname).toBe(`/12/accounts/${A}/promoted_accounts/${P}`);expect(mutations(f)[0]!.url.search).toBe('');expect(mutations(f)[0]!.init.body).toBeUndefined();
  });
  it.each(['identity', 'parent', 'deleted'] as const)('rejects stale removal on %s drift before mutation', async mode => {
    const f = fixture({ associations: [association] }), payload = await remove(f);if (mode === 'identity') f.associations[0]!.user_id = U2;if (mode === 'parent') f.parent.daily_budget_amount_local_micro++;if (mode === 'deleted') f.associations[0]!.deleted = true;
    await expect(f.provider.applyWrite(op('x_delete_promoted_account', payload), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(mutations(f)).toEqual([]);
  });
  it.each(['receipt', 'readback', 'parent', 'envelope', 'user', 'line', 'account', 'id'] as const)('does not confirm or replay an uncertain deletion: %s', async mode => {
    let submitted = false;const f = fixture({ associations: [association], handler: call => {
      if (call.init.method === 'DELETE') { submitted = true;if (mode === 'envelope') return { data: { ...association, deleted: true }, errors: [{ message: 'private' }] };return { data: { ...association, deleted: mode !== 'receipt', ...(mode === 'user' ? { user_id: U2 } : mode === 'line' ? { line_item_id: 'other' } : mode === 'account' ? { account_id: 'other' } : mode === 'id' ? { id: 'pa999' } : {}) } }; }
      if (submitted && call.url.pathname.endsWith('/promoted_accounts/' + P)) return { data: { ...association, deleted: mode !== 'readback' } };
      if (submitted && mode === 'parent' && call.url.pathname.endsWith('/line_items/' + L)) return { data: { ...line, entity_status: 'ACTIVE' } };return undefined;
    } });
    await expect(f.provider.applyWrite(op('x_delete_promoted_account', await remove(f)), guard)).rejects.toMatchObject({ details: { resource_ids: mode === 'id' ? [P, 'pa999'] : [P] } });expect(mutations(f)).toHaveLength(1);expect(f.calls.some(call => call.url.pathname.endsWith('/promoted_accounts/pa999'))).toBe(false);
  });
  it('uses exact shared approval binding, protected-account and budget caps, then consumes each approval once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-promoted-account-policy-'));dirs.push(dir);const f = fixture(), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), runtime = await createContext({ engine, providerModules: [{ provider: f.provider, tools: xTools(f.provider) }] }), input = { account_id: A, ...await create(f) };
    const pending = await runtime.registry.call('x_create_promoted_account', input, runtime.ctx) as { pending_operation_id: string };expect(mutations(f)).toEqual([]);
    await expect(runtime.registry.call('x_create_promoted_account', { ...input, pending_operation_id: pending.pending_operation_id, user_id: U2 }, runtime.ctx)).rejects.toThrow();expect(mutations(f)).toEqual([]);
    await runtime.registry.call('x_create_promoted_account', { ...input, pending_operation_id: pending.pending_operation_id }, runtime.ctx);expect(mutations(f)).toHaveLength(1);
    await expect(runtime.registry.call('x_create_promoted_account', { ...input, pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(mutations(f)).toHaveLength(1);
    const fresh = fixture(), operation = op('x_create_promoted_account', await create(fresh));
    for (const policy of [{ ...DEFAULT_POLICY, protected_accounts: [A] }, { ...DEFAULT_POLICY, max_daily_budget_micros: 1 }]) {
      const guarded = new PolicyEngine(policy, new PendingStore(join(dir, 'blocked')), new AuditLog(join(dir, 'audit')));await expect(guarded.validate(fresh.provider, operation)).rejects.toThrow();expect(mutations(fresh)).toEqual([]);
    }
  });
});
