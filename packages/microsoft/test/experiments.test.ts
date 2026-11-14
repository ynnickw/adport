import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// Official MicrosoftDocs/Advertising@fdee2fcf experiment REST contracts:
// required Active setup -> async Creating, inherited base settings, coupled deletion.
type Row = Record<string, unknown>;
type Call = { path: string; method: string; body: Row; headers: RequestInit['headers'] };
const account = '777', guard = { forcePausedCreation: true };
const start = { Day: 10, Month: 11, Year: 2026 }, end = { Day: 17, Month: 11, Year: 2026 };
const experiment = (extra: Row = {}): Row => ({ Id: '900', BaseCampaignId: '123', ExperimentCampaignId: '124', Name: 'Experiment', ExperimentStatus: 'Scheduled', ExperimentType: 'TrafficBased', TrafficSplitPercent: 50, StartDate: start, EndDate: end, ...extra });
const operation = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'microsoft', accountId: account, payload, kind });
function fixture(override?: (call: Call) => unknown) {
  const calls: Call[] = [], base: Row = { Id: '123', Name: 'Base campaign', Status: 'Paused', DailyBudget: 10, BudgetType: 'DailyBudgetStandard', BudgetId: null, CampaignType: 'Search', SubType: null, ExperimentId: null, TimeZone: 'PacificTimeUSCanadaTijuana', Settings: [] };
  const state = { campaigns: [base], experiments: [] as Row[], createBranch: false };
  const client = new MicrosoftAdsClient({ developerToken: 'fixture-dev', clientId: 'fixture-client', refreshToken: 'fixture-refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    const call = { path: url.pathname.replace(/^.*\/v13\//, ''), method: init.method ?? 'POST', body: JSON.parse(String(init.body ?? '{}')) as Row, headers: init.headers }; calls.push(call);
    const custom = override?.(call); if (custom !== undefined) return Response.json(custom);
    if (call.path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (call.path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001', CurrencyCode: 'USD' }] });
    if (call.path === 'Campaigns/QueryByAccountId') return Response.json({ Campaigns: state.campaigns });
    if (call.path === 'Campaigns/QueryByIds') return Response.json({ Campaigns: (call.body.CampaignIds as string[]).map(Id => state.campaigns.find(row => row.Id === Id) ?? null) });
    if (call.path === 'Experiments/QueryByIds') return Response.json({ Experiments: call.body.ExperimentIds === null ? state.experiments.filter(row => !['Ended', 'Deleted'].includes(String(row.ExperimentStatus))) : (call.body.ExperimentIds as string[]).map(Id => state.experiments.find(row => row.Id === Id) ?? null), PartialErrors: [] });
    if (call.path === 'Experiments' && call.method === 'POST') {
      const fields = (call.body.Experiments as Row[])[0]!, value = experiment({ ...fields, ExperimentStatus: 'Creating', ExperimentCampaignId: null }); state.experiments.push(value);
      if (state.createBranch) { value.ExperimentCampaignId = '124'; value.ExperimentStatus = 'Scheduled'; state.campaigns.push({ ...base, Id: '124', Name: value.Name, ExperimentId: '900' }); }
      return Response.json({ ExperimentIds: ['900'], PartialErrors: [] });
    }
    if (call.path === 'Experiments' && call.method === 'PUT') {
      const fields = (call.body.Experiments as Row[])[0]!, current = state.experiments.find(row => row.Id === fields.Id)!; Object.assign(current, fields);
      if (fields.EndDate && (fields.EndDate as Row).Year === 0) current.EndDate = null;
      const branch = state.campaigns.find(row => row.Id === current.ExperimentCampaignId); if (branch && fields.Name !== undefined) branch.Name = fields.Name; if (branch && fields.ExperimentStatus === 'Ended') branch.Status = 'Paused';
      return Response.json({ PartialErrors: [] });
    }
    if (call.path === 'Experiments' && call.method === 'DELETE') {
      const ids = call.body.ExperimentIds as string[], deleted = state.experiments.filter(row => ids.includes(String(row.Id))); state.experiments = state.experiments.filter(row => !ids.includes(String(row.Id))); state.campaigns = state.campaigns.filter(row => !deleted.some(exp => exp.ExperimentCampaignId === row.Id)); return Response.json({ PartialErrors: [] });
    }
    throw new Error(`Unexpected native operation ${call.method} ${call.path}`);
  });
  const provider = new MicrosoftAdsProvider(client);
  return { provider, calls, state, base, ready(extra: Row = {}) { const exp = experiment(extra); state.experiments.push(exp); state.campaigns.push({ ...base, Id: '124', Name: exp.Name, ExperimentId: exp.Id }); return exp; } };
}
async function creation(f: ReturnType<typeof fixture>, extra: Row = {}) { const context = await f.provider.experiments.base(account, '123'); return operation('microsoft_create_experiment', { base_campaign_id: '123', expected_base_context_hash: context.snapshot_hash, name: 'New experiment', start_date: '2026-11-10', end_date: '2026-11-17', traffic_split_percent: 25, ...extra }, 'create'); }
async function selected(f: ReturnType<typeof fixture>, tool: string, extra: Row = {}, kind: WriteOperation['kind'] = 'update') { const current = await f.provider.experiments.get(account, '900'); return operation(tool, { experiment_id: '900', expected_snapshot_hash: current.snapshot_hash, ...extra }, kind); }
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.path === 'Experiments');

describe('Microsoft native campaign-copy experiments', () => {
  it('defines lazy tools and restricts date/type/split inputs without an invented status setter', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(tools.filter(value => /experiment/.test(value.name))).toHaveLength(7);
    const input = tools.find(value => value.name === 'microsoft_create_experiment')!.input;
    const value = { account_id: account, base_campaign_id: '123', expected_base_context_hash: 'a'.repeat(64), name: 'Test', start_date: '2026-11-10', traffic_split_percent: 50 };
    expect(input.safeParse(value).success).toBe(true);
    for (const extra of [{ traffic_split_percent: 0 }, { traffic_split_percent: 100 }, { end_date: '2026-11-09' }, { start_date: '2026-02-30' }, { experiment_type: 'Random' }]) expect(input.safeParse({ ...value, ...extra }).success).toBe(false);
    expect(tools.some(value => /promote|graduate|set_experiment_status/.test(value.name))).toBe(false);
  });

  it('queries native active inventory with exact additional flags, scoped headers and local ID continuation', async () => {
    const f = fixture(); f.state.experiments.push(experiment({ Id: '901' }), experiment({ Id: '900' }));
    const first = await f.provider.experiments.list({ account_id: account, limit: 1 }); expect(first).toMatchObject({ rows: [{ Id: '900' }], truncated: true, next_cursor: '900' }); expect(first.visibility).toContain('active inventory only');
    expect((await f.provider.experiments.list({ account_id: account, after_experiment_id: '900', limit: 1 })).rows[0]!.Id).toBe('901');
    const query = f.calls.find(call => call.path === 'Experiments/QueryByIds')!; expect(query).toMatchObject({ method: 'POST', body: { ExperimentIds: null, ReturnAdditionalFields: 'ExperimentSubType, ExperimentArms, ExperimentCampaignType' }, headers: { CustomerAccountId: account, CustomerId: '9001' } });
  });

  it('reads an exact ended experiment despite its absence from the active inventory and verifies branch ownership', async () => {
    const f = fixture(); f.ready({ ExperimentStatus: 'Ended' });
    expect((await f.provider.experiments.list({ account_id: account, limit: 100 })).rows).toEqual([]);
    const current = await f.provider.experiments.get(account, '900'); expect(current.experiment.ExperimentStatus).toBe('Ended'); expect(current.experiment_campaign).toMatchObject({ Id: '124', ExperimentId: '900' });
    expect(f.calls.some(call => call.path === 'Experiments/QueryByIds' && JSON.stringify(call.body.ExperimentIds) === '["900"]')).toBe(true);
    f.state.campaigns[1]!.ExperimentId = '999'; await expect(f.provider.experiments.get(account, '900')).rejects.toThrow('ownership');
  });

  it('previews a paused inherited copy and unchanged budget pool, then retains asynchronous Creating without claiming readiness', async () => {
    const f = fixture(), op = await creation(f), preview = await f.provider.previewWrite(op, guard);
    expect(preview.budgetDeltas).toEqual([{ target: 'base campaign 123 inherited total daily pool (split, not additional)', currency: 'USD', fromMicros: 10_000_000, toMicros: 10_000_000 }]); expect(preview.notes?.join(' ')).toContain('not prove'); expect(writes(f)).toEqual([]);
    expect(await f.provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: ['900'] });
    expect(writes(f)[0]).toMatchObject({ method: 'POST', body: { Experiments: [{ BaseCampaignId: '123', Name: 'New experiment', StartDate: start, EndDate: end, ExperimentType: 'TrafficBased', TrafficSplitPercent: 25, ExperimentStatus: 'Active' }] } });
    expect(f.state.experiments[0]!.ExperimentStatus).toBe('Creating'); expect(f.state.campaigns).toHaveLength(1); expect(f.base.Status).toBe('Paused');
  });

  it('accepts a verified paused completed copy and refuses an unpaused base or stale context before mutation', async () => {
    const f = fixture(); f.state.createBranch = true; expect(await f.provider.applyWrite(await creation(f), guard)).toMatchObject({ applied: true }); expect(f.state.campaigns[1]).toMatchObject({ Status: 'Paused', DailyBudget: 10, ExperimentId: '900' });
    const active = fixture(); active.base.Status = 'Active'; await expect(active.provider.previewWrite(await creation(active), guard)).rejects.toThrow('Paused base'); expect(writes(active)).toEqual([]);
    const drift = fixture(), op = await creation(drift); drift.base.DailyBudget = 20; await expect(drift.provider.applyWrite(op, guard)).rejects.toThrow('context changed'); expect(writes(drift)).toEqual([]);
  });

  it('rejects unsafe/specialized bases, duplicate names and overlapping inclusive date ranges', async () => {
    for (const extra of [{ BudgetId: '500' }, { ExperimentId: '901' }, { CampaignType: 'App' }, { SubType: 'SearchMixed' }, { Settings: [{ Type: 'DynamicSearchAds' }] }, { BudgetType: 'MonthlyBudgetSpendUntilDepleted' }]) {
      const f = fixture(); Object.assign(f.base, extra); await expect(f.provider.previewWrite(await creation(f), guard)).rejects.toThrow(); expect(writes(f)).toEqual([]);
    }
    const duplicate = fixture(); await expect(duplicate.provider.previewWrite(await creation(duplicate, { name: 'BASE CAMPAIGN' }), guard)).rejects.toThrow('conflicts');
    const overlap = fixture(); overlap.ready({ StartDate: { Day: 17, Month: 11, Year: 2026 }, EndDate: { Day: 20, Month: 11, Year: 2026 } }); await expect(overlap.provider.previewWrite(await creation(overlap), guard)).rejects.toThrow('overlaps'); expect(writes(overlap)).toEqual([]);
  });

  it('renames both experiment and campaign copy, preserves omitted fields and clears expiry with the native zero Date', async () => {
    const f = fixture(); f.ready();
    await f.provider.applyWrite(await selected(f, 'microsoft_update_experiment', { name: 'Reviewed name', end_date: null }), guard);
    expect(writes(f)[0]).toMatchObject({ method: 'PUT', body: { Experiments: [{ Id: '900', Name: 'Reviewed name', EndDate: { Day: 0, Month: 0, Year: 0 } }] } });
    expect(writes(f)[0]!.body.Experiments).not.toEqual(expect.arrayContaining([expect.objectContaining({ StartDate: expect.anything() })]));
    expect(f.state.campaigns[1]!.Name).toBe('Reviewed name'); expect(f.state.experiments[0]!.TrafficSplitPercent).toBe(50); expect(f.base.Status).toBe('Paused');
  });

  it('requires Scheduled before changing start/split and preserves native calendar dates', async () => {
    const f = fixture(); f.ready();
    await f.provider.applyWrite(await selected(f, 'microsoft_update_experiment', { start_date: '2026-11-11', traffic_split_percent: 30 }), guard);
    expect(writes(f)[0]).toMatchObject({ method: 'PUT', body: { Experiments: [{ Id: '900', StartDate: { Day: 11, Month: 11, Year: 2026 }, TrafficSplitPercent: 30 }] } });
    for (const status of ['Active', 'Paused']) {
      const paused = fixture(); paused.ready({ ExperimentStatus: status }); await expect(paused.provider.previewWrite(await selected(paused, 'microsoft_update_experiment', { traffic_split_percent: 40 }), guard)).rejects.toThrow('Scheduled'); expect(writes(paused)).toEqual([]);
    }
    const ended = fixture(); ended.ready({ ExperimentStatus: 'Ended' }); await expect(ended.provider.previewWrite(await selected(ended, 'microsoft_update_experiment', { name: 'Edited after end' }), guard)).rejects.toThrow('ended experiments cannot be edited'); expect(writes(ended)).toEqual([]);
  });

  it('rejects schedule extensions into another active experiment before native submission', async () => {
    const f = fixture(); f.ready(); f.state.experiments.push(experiment({ Id: '901', ExperimentCampaignId: null, Name: 'Next experiment', StartDate: { Day: 18, Month: 11, Year: 2026 }, EndDate: { Day: 25, Month: 11, Year: 2026 } }));
    await expect(f.provider.previewWrite(await selected(f, 'microsoft_update_experiment', { end_date: '2026-11-18' }), guard)).rejects.toThrow('overlaps');
    expect(writes(f)).toEqual([]);
  });

  it('ends an experiment irreversibly with a native PUT and paused-branch readback while preserving the base', async () => {
    const f = fixture(); f.ready({ ExperimentStatus: 'Paused' });
    const op = await selected(f, 'microsoft_end_experiment'), preview = await f.provider.previewWrite(op, guard); expect(preview.fieldChanges).toContainEqual({ field: 'Experiment status', before: 'Paused', after: 'Ended (cannot restart)' });
    await f.provider.applyWrite(op, guard); expect(writes(f)[0]).toMatchObject({ method: 'PUT', body: { Experiments: [{ Id: '900', ExperimentStatus: 'Ended' }] } }); expect(f.state.campaigns[1]!.Status).toBe('Paused'); expect(f.base).toMatchObject({ Status: 'Paused', DailyBudget: 10 });
    await expect(f.provider.previewWrite(await selected(f, 'microsoft_end_experiment'), guard)).rejects.toThrow('already ended');
  });

  it('deletes the exact experiment and coupled branch, handles nullable read slots, and proves the base survived', async () => {
    const f = fixture(); f.ready(); const op = await selected(f, 'microsoft_delete_experiment', {}, 'remove');
    expect(await f.provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: ['900', '124'] }); expect(writes(f)[0]).toMatchObject({ method: 'DELETE', body: { ExperimentIds: ['900'] } }); expect(f.state.experiments).toEqual([]); expect(f.state.campaigns).toEqual([f.base]); expect(f.base.Status).toBe('Paused');
  });

  it('recognizes qualified post-delete native receipts only with empty independent inventories and an unchanged base', async () => {
    let deleted = false;
    const f = fixture(call => {
      if (call.path === 'Experiments' && call.method === 'DELETE') deleted = true;
      if (deleted && call.path === 'Experiments/QueryByIds' && call.body.ExperimentIds !== null) return { Experiments: [null], PartialErrors: [{ Index: 0, Code: 6110, ErrorCode: 'ExperimentIdInvalid' }] };
      if (deleted && call.path === 'Campaigns/QueryByIds' && (call.body.CampaignIds as string[])[0] === '124') return { Campaigns: [null], PartialErrors: [{ Index: 0, Code: 1120, ErrorCode: 'CampaignServiceInvalidCampaignStatus' }] };
      return undefined;
    });
    f.ready(); expect(await f.provider.applyWrite(await selected(f, 'microsoft_delete_experiment', {}, 'remove'), guard)).toEqual({ applied: true, resourceIds: ['900', '124'] });
    expect(writes(f)).toHaveLength(1); expect(f.base.Status).toBe('Paused');
  });

  it('keeps unknown or mismatched deletion errors unconfirmed and never treats them as ordinary read absence', async () => {
    for (const error of [{ Index: 1, Code: 6110, ErrorCode: 'ExperimentIdInvalid' }, { Index: 0, Code: 6110, ErrorCode: 'Other' }, { Index: 0, Code: 999, ErrorCode: 'ExperimentIdInvalid' }]) {
      let deleted = false;
      const f = fixture(call => { if (call.path === 'Experiments' && call.method === 'DELETE') deleted = true; return deleted && call.path === 'Experiments/QueryByIds' && call.body.ExperimentIds !== null ? { Experiments: [null], PartialErrors: [error] } : undefined; });
      f.ready(); await expect(f.provider.applyWrite(await selected(f, 'microsoft_delete_experiment', {}, 'remove'), guard)).rejects.toMatchObject({ details: { resourceIds: ['900', '124'] } }); expect(writes(f)).toHaveLength(1);
    }
    const ordinary = fixture(call => call.path === 'Experiments/QueryByIds' && call.body.ExperimentIds !== null ? { Experiments: [null], PartialErrors: [{ Index: 0, Code: 6110, ErrorCode: 'ExperimentIdInvalid' }] } : undefined);
    await expect(ordinary.provider.experiments.get(account, '900')).rejects.toThrow('partial errors');
  });

  it('does not accept qualified null-slot errors when an independent active inventory still contains the owned experiment', async () => {
    let acknowledged = false;
    const f = fixture(call => {
      if (call.path === 'Experiments' && call.method === 'DELETE') { acknowledged = true; return { PartialErrors: [] }; }
      if (acknowledged && call.path === 'Experiments/QueryByIds' && call.body.ExperimentIds !== null) return { Experiments: [null], PartialErrors: [{ Index: 0, Code: 6110, ErrorCode: 'ExperimentIdInvalid' }] };
      if (acknowledged && call.path === 'Campaigns/QueryByIds' && (call.body.CampaignIds as string[])[0] === '124') return { Campaigns: [null], PartialErrors: [{ Index: 0, Code: 1120, ErrorCode: 'CampaignServiceInvalidCampaignStatus' }] };
      return undefined;
    });
    f.ready(); await expect(f.provider.applyWrite(await selected(f, 'microsoft_delete_experiment', {}, 'remove'), guard)).rejects.toMatchObject({ details: { resourceIds: ['900', '124'] } });
    expect(writes(f)).toHaveLength(1); expect(f.state.experiments).toHaveLength(1);
  });

  it('reports accepted-but-unconfirmed setup with IDs and retains partial native creation IDs instead of retrying', async () => {
    const bad = fixture(call => call.path === 'Experiments' && call.method === 'POST' ? { ExperimentIds: ['900'], PartialErrors: [] } : undefined);
    await expect(bad.provider.applyWrite(await creation(bad), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resourceIds: ['900'] } }); expect(writes(bad)).toHaveLength(1);
    const partial = fixture(call => call.path === 'Experiments' && call.method === 'POST' ? { ExperimentIds: ['901'], PartialErrors: [{ Code: 123, ErrorCode: 'CreationFailed', Message: 'Native partial error', Index: 0 }] } : undefined);
    await expect(partial.provider.applyWrite(await creation(partial), guard)).rejects.toMatchObject({ details: { resourceIds: ['901'] } }); expect(writes(partial)).toHaveLength(1);
  });

  it('blocks generic experiment mutation aliases so inherited budget/pause and coupled-effect guards cannot be bypassed', async () => {
    const f = fixture();
    for (const [tool, kind, resource] of [['microsoft_api_create', 'create', 'Experiments'], ['microsoft_api_update', 'update', 'EXPERIMENTS'], ['microsoft_api_delete', 'remove', 'EXperiments']] as const) await expect(f.provider.previewWrite(operation(tool, { resource, body: {} }, kind), guard)).rejects.toThrow('typed tools');
    expect(writes(f)).toEqual([]);
  });

  it('blocks direct experiment-campaign budget/status edits and explains base-campaign coupled effects', async () => {
    const f = fixture(); f.ready();
    await expect(f.provider.previewWrite(operation('microsoft_set_campaign_status', { campaign_id: '124', status: 'Paused' }), guard)).rejects.toThrow('inherited');
    await expect(f.provider.previewWrite(operation('microsoft_set_budget', { campaign_id: '124', daily_budget: 20 }), guard)).rejects.toThrow('inherited');
    expect((await f.provider.previewWrite(operation('microsoft_set_campaign_status', { campaign_id: '123', status: 'Paused' }), guard)).notes?.join(' ')).toContain('follow the base serving status');
    expect((await f.provider.previewWrite(operation('microsoft_set_budget', { campaign_id: '123', daily_budget: 10 }), guard)).notes?.join(' ')).toContain('before its traffic/budget split');
    expect(writes(f)).toEqual([]);
  });
});
