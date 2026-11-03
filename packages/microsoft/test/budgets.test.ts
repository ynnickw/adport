import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { MicrosoftAdsClient } from '../src/client.js';
import { MICROSOFT_CAMPAIGN_TYPES, MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// REST wire contracts: MicrosoftDocs/Advertising@fdee2fcf, checked 2026-11-03.
type Row = Record<string, unknown>;
type Call = { path: string; method: string; body: Row; headers: RequestInit['headers'] };
const account = '777', guard = { forcePausedCreation: true };
const pool = (Id = '100', extra: Row = {}): Row => ({ Id, Name: `Pool ${Id}`, Amount: 1, BudgetType: 'DailyBudgetStandard', AssociationCount: 0, ...extra });
const campaign = (Id = '9', extra: Row = {}): Row => ({ Id, Name: `Campaign ${Id}`, CampaignType: 'Search', SubType: null, ExperimentId: null, Status: 'Paused', DailyBudget: 1, BudgetType: 'DailyBudgetStandard', BudgetId: null, ...extra });
function fixture(override?: (call: Call, calls: Call[]) => unknown) {
  const calls: Call[] = [], state = { budgets: [pool()] as Row[], campaigns: [campaign()] as Row[] };
  const client = new MicrosoftAdsClient({ developerToken: 'dev', clientId: 'client', refreshToken: 'refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    const call = { path: url.pathname.replace(/^.*\/v13\//, ''), method: init.method ?? 'POST', body: JSON.parse(String(init.body ?? '{}')) as Row, headers: init.headers }; calls.push(call);
    const custom = override?.(call, calls); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (call.path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001', CurrencyCode: 'EUR' }] });
    if (call.path === 'Campaigns/QueryByAccountId') return Response.json({ Campaigns: state.campaigns });
    if (call.path === 'Budgets/QueryByIds') return Response.json({ Budgets: state.budgets, PartialErrors: [] });
    if (call.path === 'Budgets') {
      if (call.method === 'POST') { state.budgets.push(pool('101', (call.body.Budgets as Row[])[0])); return Response.json({ BudgetIds: ['101'], PartialErrors: [] }); }
      if (call.method === 'PUT') { const value = (call.body.Budgets as Row[])[0]!; Object.assign(state.budgets.find(item => item.Id === value.Id)!, value); return Response.json({ PartialErrors: [] }); }
      if (call.method === 'DELETE') { state.budgets = state.budgets.filter(value => !(call.body.BudgetIds as string[]).includes(String(value.Id))); return Response.json({ PartialErrors: [] }); }
    }
    if (call.path === 'Campaigns' && call.method === 'PUT') {
      const value = (call.body.Campaigns as Row[])[0]!, current = state.campaigns.find(item => item.Id === value.Id)!;
      if (current.BudgetId) { const previous = state.budgets.find(item => item.Id === current.BudgetId)!; previous.AssociationCount = Number(previous.AssociationCount) - 1; }
      Object.assign(current, value);
      if (current.BudgetId === '0') current.BudgetId = null;
      if (current.BudgetId) { const next = state.budgets.find(item => item.Id === current.BudgetId)!; next.AssociationCount = Number(next.AssociationCount) + 1; current.DailyBudget = next.Amount; }
      return Response.json({ PartialErrors: [] });
    }
    throw new Error(`Unexpected request ${call.method} ${call.path}`);
  });
  return { provider: new MicrosoftAdsProvider(client), state, calls };
}
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'microsoft', accountId: account, payload, kind });
const writes = (calls: Call[]) => calls.filter(value => ['Campaigns', 'Budgets'].includes(value.path));

describe('Microsoft shared daily budgets', () => {
  it('defines lazy tools with safe monetary and required snapshot schemas', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(tools.filter(value => /shared_budget|campaign_budget/.test(value.name))).toHaveLength(8);
    const create = tools.find(value => value.name === 'microsoft_create_shared_budget')!.input;
    expect(create.safeParse({ account_id: account, name: 'QA', amount: 1.000001 }).success).toBe(true);
    for (const amount of [0, -1, 0.0000001, Number.MAX_SAFE_INTEGER, Infinity]) expect(create.safeParse({ account_id: account, name: 'QA', amount }).success).toBe(false);
    expect(tools.find(value => value.name === 'microsoft_assign_shared_budget')!.input.safeParse({ account_id: account, campaign_id: '9', budget_id: '100' }).success).toBe(false);
  });

  it('discovers all eight campaign types with native CSV flags and account headers', async () => {
    const f = fixture(); f.state.campaigns.push(campaign('10', { CampaignType: 'Audience', BudgetId: '100' })); f.state.budgets[0]!.AssociationCount = 1;
    expect(await f.provider.budgets.get(account, '100')).toMatchObject({ currency: 'EUR', members: [{ Id: '10', CampaignType: 'Audience' }], membership_complete: true });
    expect(f.calls.find(value => value.path === 'Budgets/QueryByIds')!).toMatchObject({ body: { BudgetIds: null }, headers: { CustomerAccountId: account, CustomerId: '9001', DeveloperToken: 'dev' } });
    expect(f.calls.find(value => value.path === 'Campaigns/QueryByAccountId')!.body).toEqual({ AccountId: account, CampaignType: MICROSOFT_CAMPAIGN_TYPES, ReturnAdditionalFields: null });
    expect(MICROSOFT_CAMPAIGN_TYPES.split(', ')).toHaveLength(8);
  });

  it('paginates long budget IDs without precision loss', async () => {
    const f = fixture(); f.state.budgets = [pool('9007199254740993'), pool('11'), pool('9')];
    expect(await f.provider.budgets.list({ account_id: account, limit: 1 })).toMatchObject({ rows: [{ budget: { Id: '9' } }], truncated: true, next_cursor: '9' });
    expect(await f.provider.budgets.list({ account_id: account, limit: 2, after_budget_id: '9' })).toMatchObject({ rows: [{ budget: { Id: '11' } }, { budget: { Id: '9007199254740993' } }], truncated: false });
  });

  it('reports incomplete membership honestly and refuses its updates or deletion', async () => {
    const f = fixture(); f.state.budgets[0]!.AssociationCount = 2;
    const view = await f.provider.budgets.get(account, '100'); expect(view.membership_complete).toBe(false);
    for (const [tool, kind] of [['microsoft_update_shared_budget', 'update'], ['microsoft_delete_shared_budget', 'remove']] as const) await expect(f.provider.previewWrite(op(tool, { budget_id: '100', expected_snapshot_hash: view.snapshot_hash, name: 'New name' }, kind), guard)).rejects.toThrow('AssociationCount');
    expect(writes(f.calls)).toHaveLength(0);
  });

  it('creates only on apply with native Amount and no fabricated serving status', async () => {
    const f = fixture(), operation = op('microsoft_create_shared_budget', { name: 'QA pool', amount: 1.000001 }, 'create');
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ serverValidated: false, coercions: [], budgetDeltas: [{ fromMicros: 0, toMicros: 1000001, currency: 'EUR' }] });
    expect(writes(f.calls)).toHaveLength(0);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['101'] });
    expect(writes(f.calls)[0]!).toMatchObject({ path: 'Budgets', method: 'POST', body: { Budgets: [{ Name: 'QA pool', Amount: 1.000001, BudgetType: 'DailyBudgetStandard' }] } });
    await expect(f.provider.previewWrite(operation, guard)).rejects.toThrow('already exists');
  });

  it('compares shared pool micros once and shows every affected campaign on update', async () => {
    const f = fixture(); f.state.campaigns.push(campaign('10', { BudgetId: '100', CampaignType: 'Shopping' })); f.state.campaigns[0]!.BudgetId = '100'; f.state.budgets[0]!.AssociationCount = 2;
    const before = await f.provider.budgets.get(account, '100'), operation = op('microsoft_update_shared_budget', { budget_id: '100', expected_snapshot_hash: before.snapshot_hash, amount: 1.01, name: 'Renamed pool' });
    const preview = await f.provider.previewWrite(operation, guard);
    expect(preview.budgetDeltas).toEqual([{ target: 'shared budget 100 daily pool', fromMicros: 1000000, toMicros: 1010000, currency: 'EUR' }]);
    expect(preview.notes?.join(' ')).toContain('10 Campaign 10 (Paused)');
    await f.provider.applyWrite(operation, guard);
    expect(writes(f.calls)[0]!.body).toEqual({ Budgets: [{ Id: '100', Name: 'Renamed pool', Amount: 1.01 }] });
    expect(writes(f.calls)).toHaveLength(1);
  });

  it('renames without a monetary delta and rejects stale amount, membership or status snapshots', async () => {
    const f = fixture(), before = await f.provider.budgets.get(account, '100');
    const rename = op('microsoft_update_shared_budget', { budget_id: '100', expected_snapshot_hash: before.snapshot_hash, name: 'Renamed' });
    expect((await f.provider.previewWrite(rename, guard)).budgetDeltas).toEqual([]);
    f.state.budgets[0]!.Amount = 2;
    await expect(f.provider.applyWrite(rename, guard)).rejects.toThrow('snapshot changed');
    f.state.budgets[0]!.Amount = 1; f.state.campaigns[0]!.BudgetId = '100'; f.state.budgets[0]!.AssociationCount = 1;
    await expect(f.provider.applyWrite(rename, guard)).rejects.toThrow('snapshot changed');
    const next = await f.provider.budgets.get(account, '100'); f.state.campaigns[0]!.Status = 'Active';
    await expect(f.provider.applyWrite(op('microsoft_update_shared_budget', { budget_id: '100', expected_snapshot_hash: next.snapshot_hash, amount: 1.01 }), guard)).rejects.toThrow('snapshot changed');
    expect(writes(f.calls)).toHaveLength(0);
  });

  it('assigns using only BudgetId, preserves status, and takes the pool’s authoritative amount', async () => {
    const f = fixture(); f.state.campaigns[0]!.Status = 'Active'; f.state.budgets[0]!.Amount = 1.25;
    const current = await f.provider.budgets.campaignBudget(account, '9'), destination = await f.provider.budgets.get(account, '100');
    const operation = op('microsoft_assign_shared_budget', { campaign_id: '9', budget_id: '100', expected_campaign_hash: current.snapshot_hash, expected_budget_hash: destination.snapshot_hash });
    expect((await f.provider.previewWrite(operation, guard)).budgetDeltas[0]).toMatchObject({ fromMicros: 1000000, toMicros: 1250000 });
    await f.provider.applyWrite(operation, guard);
    expect(writes(f.calls)[0]!).toMatchObject({ method: 'PUT', path: 'Campaigns', body: { AccountId: account, Campaigns: [{ Id: '9', BudgetId: '100' }] } });
    f.state.campaigns[0]!.DailyBudget = 99;
    expect(await f.provider.budgets.campaignBudget(account, '9')).toMatchObject({ effective_daily_amount: 1.25, campaign: { Status: 'Active' } });
  });

  it('detaches using native string zero plus explicit DailyBudget and preserves the pool', async () => {
    const f = fixture(); f.state.campaigns[0]!.BudgetId = '100'; f.state.budgets[0]!.AssociationCount = 1;
    const current = await f.provider.budgets.campaignBudget(account, '9'), operation = op('microsoft_unassign_shared_budget', { campaign_id: '9', daily_budget: 1.05, expected_campaign_hash: current.snapshot_hash });
    expect((await f.provider.previewWrite(operation, guard)).budgetDeltas[0]).toMatchObject({ fromMicros: 1000000, toMicros: 1050000 });
    await f.provider.applyWrite(operation, guard);
    expect(writes(f.calls)[0]!.body).toEqual({ AccountId: account, Campaigns: [{ Id: '9', BudgetId: '0', DailyBudget: 1.05, BudgetType: 'DailyBudgetStandard' }] });
    expect(f.state.budgets[0]).toMatchObject({ Amount: 1, AssociationCount: 0 });
  });

  it('binds the source pool membership when moving between pools', async () => {
    const f = fixture(); f.state.budgets.push(pool('101')); f.state.campaigns[0]!.BudgetId = '100'; f.state.budgets[0]!.AssociationCount = 1;
    const current = await f.provider.budgets.campaignBudget(account, '9'), destination = await f.provider.budgets.get(account, '101');
    const operation = op('microsoft_assign_shared_budget', { campaign_id: '9', budget_id: '101', expected_campaign_hash: current.snapshot_hash, expected_budget_hash: destination.snapshot_hash });
    f.state.campaigns.push(campaign('10', { BudgetId: '100' })); f.state.budgets[0]!.AssociationCount = 2;
    await expect(f.provider.applyWrite(operation, guard)).rejects.toThrow('snapshot changed');
    expect(writes(f.calls)).toHaveLength(0);
  });

  it('rejects unsupported campaign types and experiment budget inheritance before mutation', async () => {
    for (const fields of [{ CampaignType: 'PerformanceMax' }, { CampaignType: 'Shopping', SubType: 'ShoppingSmartAds' }, { ExperimentId: '555' }]) {
      const f = fixture(); Object.assign(f.state.campaigns[0]!, fields);
      const current = await f.provider.budgets.campaignBudget(account, '9'), destination = await f.provider.budgets.get(account, '100');
      await expect(f.provider.previewWrite(op('microsoft_assign_shared_budget', { campaign_id: '9', budget_id: '100', expected_campaign_hash: current.snapshot_hash, expected_budget_hash: destination.snapshot_hash }), guard)).rejects.toThrow('cannot be assigned');
      expect(writes(f.calls)).toHaveLength(0);
    }
  });

  it('deletes only verified unused pools and confirms disappearance', async () => {
    const f = fixture(), before = await f.provider.budgets.get(account, '100');
    await f.provider.applyWrite(op('microsoft_delete_shared_budget', { budget_id: '100', expected_snapshot_hash: before.snapshot_hash }, 'remove'), guard);
    expect(writes(f.calls)[0]!).toMatchObject({ method: 'DELETE', body: { BudgetIds: ['100'] } });
    expect(f.state.budgets).toEqual([]);
    const assigned = fixture(); assigned.state.campaigns[0]!.BudgetId = '100'; assigned.state.budgets[0]!.AssociationCount = 1;
    const view = await assigned.provider.budgets.get(account, '100');
    await expect(assigned.provider.previewWrite(op('microsoft_delete_shared_budget', { budget_id: '100', expected_snapshot_hash: view.snapshot_hash }, 'remove'), guard)).rejects.toThrow('detach all');
    expect(writes(assigned.calls)).toHaveLength(0);
  });

  it('preserves accepted resource IDs on partial errors or unconfirmed readback without replay', async () => {
    const failed = fixture(call => call.path === 'Budgets' ? { BudgetIds: ['101'], PartialErrors: [{ Code: 1, Message: 'Native failure' }] } : undefined);
    await expect(failed.provider.applyWrite(op('microsoft_create_shared_budget', { name: 'QA', amount: 1 }, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['101'] } });
    expect(writes(failed.calls)).toHaveLength(1);
    const unconfirmed = fixture((call, calls) => call.path === 'Budgets/QueryByIds' && writes(calls).length ? { Budgets: [], PartialErrors: [] } : undefined);
    await expect(unconfirmed.provider.applyWrite(op('microsoft_create_shared_budget', { name: 'QA', amount: 1 }, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['101'] } });
    expect(writes(unconfirmed.calls)).toHaveLength(1);
  });

  it('blocks generic shared-budget Amount and reference bypasses', async () => {
    const f = fixture();
    for (const [tool, kind] of [['microsoft_api_create', 'create'], ['microsoft_api_update', 'update'], ['microsoft_api_delete', 'remove']] as const) await expect(f.provider.previewWrite(op(tool, { resource: 'Budgets', body: { Budgets: [{ Amount: 999999 }] } }, kind), guard)).rejects.toThrow('typed microsoft');
    await expect(f.provider.previewWrite(op('microsoft_api_create', { resource: 'Campaigns', body: { Campaigns: [{ BudgetId: '100', Name: 'Bypass' }] } }, 'create'), guard)).rejects.toThrow('typed microsoft');
    expect(writes(f.calls)).toHaveLength(0);
  });

  it('enforces shared-pool caps through the actual policy engine and rejects drift after approval', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>(), audit: unknown[] = [];
    const engine = new PolicyEngine({ ...DEFAULT_POLICY, max_daily_budget_micros: 1500000 }, { async put(value) { pending.set(value.id, value); }, async get(id) { return pending.get(id); }, async delete(id) { pending.delete(id); }, async sweep() {} }, { async append(value) { audit.push(value); } });
    await expect(engine.validate(f.provider, op('microsoft_create_shared_budget', { name: 'Too large', amount: 2 }, 'create'))).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    const view = await f.provider.budgets.get(account, '100');
    await expect(engine.validate(f.provider, op('microsoft_update_shared_budget', { budget_id: '100', expected_snapshot_hash: view.snapshot_hash, amount: 1.3 }))).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    const allowed = op('microsoft_update_shared_budget', { budget_id: '100', expected_snapshot_hash: view.snapshot_hash, amount: 1.1 });
    const approval = await engine.validate(f.provider, allowed); f.state.budgets[0]!.Amount = 0.9;
    await expect(engine.apply(f.provider, allowed, approval.pendingOperationId)).rejects.toThrow('snapshot changed');
    expect(writes(f.calls)).toHaveLength(0); expect(audit.length).toBeGreaterThan(0);
  });
});
