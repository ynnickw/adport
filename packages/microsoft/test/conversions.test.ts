import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// MicrosoftDocs/Advertising@fdee2fcf: native scopes, automatic MSCLKID setting and EventGoal omission semantics.
type Row = Record<string, unknown>;
type Call = { path: string; method: string; body: Row; init: RequestInit };
const account = '777', guard = { forcePausedCreation: true };
const offline = { type: 'OfflineConversion', name: 'Owned QA goal', goal_category: 'Other', expected_auto_tagging_enabled: true };
const existing = (Type = 'OfflineConversion', extra: Row = {}): Row => ({ Id: '100', Type, Name: 'Existing goal', Scope: 'Account', Status: 'Paused', ExcludeFromBidding: true, ConversionWindowInMinutes: 43200, CountType: 'All', GoalCategory: 'Other', Revenue: { Type: 'NoValue', Value: null, CurrencyCode: null }, TrackingStatus: 'NoRecentConversions', IsExternallyAttributed: false, ...extra });
function fixture(override?: (call: Call, calls: Call[]) => unknown) {
  const calls: Call[] = [], state = { goals: [] as Row[], autoTagging: true };
  const client = new MicrosoftAdsClient({ developerToken: 'dev', clientId: 'client', refreshToken: 'refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    const call = { path: url.pathname.replace(/^.*\/v13\//, ''), method: init.method ?? 'POST', body: JSON.parse(String(init.body ?? '{}')) as Row, init }; calls.push(call);
    const custom = override?.(call, calls); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (call.path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001' }] });
    if (call.path === 'AccountProperties/Query') return Response.json({ AccountProperties: [{ Name: 'MSCLKIDAutoTaggingEnabled', Value: String(state.autoTagging) }], PartialErrors: null });
    if (call.path === 'ConversionGoals/QueryByIds') return Response.json({ ConversionGoals: state.goals.filter(value => String(call.body.ConversionGoalTypes).split(', ').includes(String(value.Type))), PartialErrors: [] });
    if (call.path === 'UetTags/QueryByIds') return Response.json({ UetTags: [{ Id: '200', Name: 'Existing customer UET' }], PartialErrors: [] });
    if (call.path === 'ConversionGoals') {
      const value = (call.body.ConversionGoals as Row[])[0]!; state.autoTagging = true;
      if (call.method === 'POST') { state.goals.push({ ...existing(String(value.Type)), ...value }); return Response.json({ ConversionGoalIds: ['100'], PartialErrors: [] }); }
      const current = state.goals.find(item => item.Id === value.Id)!;
      if (value.Type === 'Event') for (const field of ['ActionExpression', 'ActionOperator', 'CategoryExpression', 'CategoryOperator', 'LabelExpression', 'LabelOperator', 'Value', 'ValueOperator']) delete current[field];
      Object.assign(current, value); return Response.json({ PartialErrors: [] });
    }
    throw new Error(`Unexpected ${call.method} ${call.path}`);
  });
  return { provider: new MicrosoftAdsProvider(client), state, calls };
}
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'microsoft', accountId: account, payload, kind });
const writes = (calls: Call[]) => calls.filter(value => value.path === 'ConversionGoals');

describe('Microsoft conversion goal setup', () => {
  it('defines lazy tools, requires native side-effect acknowledgement and excludes internal Deleted', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(tools.filter(value => /conversion_goal/.test(value.name))).toHaveLength(4);
    const create = tools.find(value => value.name === 'microsoft_create_conversion_goal')!.input;
    expect(create.safeParse({ account_id: account, goal: offline }).success).toBe(true);
    expect(create.safeParse({ account_id: account, goal: { ...offline, expected_auto_tagging_enabled: undefined } }).success).toBe(false);
    expect(create.safeParse({ account_id: account, goal: { ...offline, status: 'Deleted' } }).success).toBe(false);
    expect(create.safeParse({ account_id: account, goal: { ...offline, type: 'Event', tag_id: '200', event_conditions: {} } }).success).toBe(false);
  });

  it('queries selected-account headers, CSV types, extra fields and the precise auto-tagging property', async () => {
    const f = fixture(), tool = microsoftTools(f.provider).find(value => value.name === 'microsoft_conversion_goals')!;
    const input = tool.input.parse({ account_id: account }) as { account_id: string; goal_types: ('Url')[]; limit: number };
    const output = await f.provider.conversions.list(input); expect(output).toEqual({ rows: [], auto_tagging_enabled: true, truncated: false });
    const query = f.calls.find(value => value.path === 'ConversionGoals/QueryByIds')!;
    expect(query.body.ConversionGoalTypes).toBe('AppDownload, AppInstall, Duration, Event, OfflineConversion, PagesViewedPerVisit, Url'); expect(query.body).toMatchObject({ ConversionGoalIds: null });
    expect(query.body.ReturnAdditionalFields).toContain('IsExternallyAttributed'); expect(query.body.ReturnAdditionalFields).toContain('GoalCategory');
    expect(query.init.headers).toMatchObject({ CustomerAccountId: account, CustomerId: '9001' });
    expect(f.calls.at(-1)!.body).toEqual({ AccountPropertyNames: ['MSCLKIDAutoTaggingEnabled'] });
  });

  it('creates Account-only, forced Paused and excluded-from-bidding goals and verifies readback', async () => {
    const f = fixture(); f.state.autoTagging = false;
    const operation = op('microsoft_create_conversion_goal', { goal: { ...offline, status: 'Active', expected_auto_tagging_enabled: false } }, 'create');
    const preview = await f.provider.previewWrite(operation, guard);
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], fieldChanges: expect.arrayContaining([{ field: 'MSCLKIDAutoTaggingEnabled', before: 'false', after: 'true' }]) }); expect(preview.coercions).toHaveLength(1); expect(writes(f.calls)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['100'] });
    expect(writes(f.calls)[0]!).toMatchObject({ method: 'POST', body: { ConversionGoals: [{ Type: 'OfflineConversion', Scope: 'Account', Status: 'Paused', ExcludeFromBidding: true, Revenue: { Type: 'NoValue' }, IsExternallyAttributed: false }] } });
    expect(f.state.autoTagging).toBe(true);
  });

  it('rejects auto-tagging drift and duplicate names before a native creation', async () => {
    const f = fixture(); f.state.autoTagging = false;
    await expect(f.provider.previewWrite(op('microsoft_create_conversion_goal', { goal: offline }, 'create'), guard)).rejects.toThrow('auto-tagging state changed');
    f.state.autoTagging = true; f.state.goals.push(existing('OfflineConversion', { Name: offline.name }));
    await expect(f.provider.previewWrite(op('microsoft_create_conversion_goal', { goal: offline }, 'create'), guard)).rejects.toThrow('already exists'); expect(writes(f.calls)).toEqual([]);
  });

  it('checks the UET source before creating native URL rules', async () => {
    const f = fixture(), operation = op('microsoft_create_conversion_goal', { goal: { ...offline, type: 'Url', tag_id: '200', url_rule: { operator: 'BeginsWith', expression: 'https://example.com/thanks' } } }, 'create');
    await f.provider.applyWrite(operation, guard);
    expect(f.calls.find(value => value.path === 'UetTags/QueryByIds')!.body).toEqual({ TagIds: ['200'] });
    expect(writes(f.calls)[0]!.body).toMatchObject({ ConversionGoals: [{ Type: 'Url', TagId: '200', UrlExpression: 'https://example.com/thanks', UrlOperator: 'BeginsWith' }] });
    const foreign = fixture(call => call.path === 'UetTags/QueryByIds' ? { UetTags: [{ Id: '999' }] } : undefined);
    await expect(foreign.provider.previewWrite(operation, guard)).rejects.toThrow('UET tag'); expect(writes(foreign.calls)).toHaveLength(0);
  });

  it('preserves every existing event pair when renaming or changing status', async () => {
    const f = fixture(); f.state.goals.push(existing('Event', { ActionExpression: 'submit', ActionOperator: 'Equals', CategoryExpression: 'lead', CategoryOperator: 'Contains', LabelExpression: null, LabelOperator: null, Value: 0, ValueOperator: 'GreaterThan', TagId: '200' }));
    const current = await f.provider.conversions.get(account, '100', 'Event');
    await f.provider.applyWrite(op('microsoft_update_conversion_goal', { goal_id: '100', goal_type: 'Event', expected_snapshot_hash: current.snapshot_hash, name: 'Renamed' }), guard);
    expect(writes(f.calls)[0]!.body).toEqual({ ConversionGoals: [{ Id: '100', Type: 'Event', Name: 'Renamed', ActionExpression: 'submit', ActionOperator: 'Equals', CategoryExpression: 'lead', CategoryOperator: 'Contains', LabelExpression: null, LabelOperator: null, Value: 0, ValueOperator: 'GreaterThan' }] });
    expect(f.state.goals[0]).toMatchObject({ Name: 'Renamed', Status: 'Paused', ActionExpression: 'submit', CategoryExpression: 'lead', Value: 0 });
  });

  it('replaces event conditions only when explicitly supplied and preserves other configuration', async () => {
    const f = fixture(); f.state.goals.push(existing('Event', { ActionExpression: 'submit', ActionOperator: 'Equals', CategoryExpression: 'lead', CategoryOperator: 'Contains', TagId: '200' }));
    const current = await f.provider.conversions.get(account, '100', 'Event');
    await f.provider.applyWrite(op('microsoft_update_conversion_goal', { goal_id: '100', goal_type: 'Event', expected_snapshot_hash: current.snapshot_hash, event_conditions: { label: { operator: 'Equals', text: 'new-label' } } }), guard);
    expect(f.state.goals[0]).toMatchObject({ ActionExpression: null, ActionOperator: null, CategoryExpression: null, CategoryOperator: null, LabelExpression: 'new-label', LabelOperator: 'Equals', Value: null, ValueOperator: null, ExcludeFromBidding: true });
  });

  it('binds configuration and auto-tagging but tolerates unrelated native tracking-status changes', async () => {
    const f = fixture(); f.state.goals.push(existing());
    const current = await f.provider.conversions.get(account, '100', 'OfflineConversion'); f.state.goals[0]!.TrackingStatus = 'RecordingConversions';
    expect((await f.provider.conversions.get(account, '100', 'OfflineConversion')).snapshot_hash).toBe(current.snapshot_hash);
    f.state.goals[0]!.Name = 'Other editor';
    const operation = op('microsoft_update_conversion_goal', { goal_id: '100', goal_type: 'OfflineConversion', expected_snapshot_hash: current.snapshot_hash, name: 'Rename' });
    await expect(f.provider.applyWrite(operation, guard)).rejects.toThrow('snapshot changed'); expect(writes(f.calls)).toEqual([]);
    f.state.goals[0]!.Name = 'Existing goal'; f.state.autoTagging = false;
    await expect(f.provider.applyWrite(operation, guard)).rejects.toThrow('snapshot changed');
  });

  it('refuses Customer-wide goals and incomplete existing event criteria without mutating', async () => {
    for (const fields of [{ Scope: 'Customer' }, { ActionExpression: 'submit', ActionOperator: null }]) {
      const f = fixture(); f.state.goals.push(existing('Event', fields));
      const current = await f.provider.conversions.get(account, '100', 'Event');
      await expect(f.provider.applyWrite(op('microsoft_update_conversion_goal', { goal_id: '100', goal_type: 'Event', expected_snapshot_hash: current.snapshot_hash, name: 'Rename' }), guard)).rejects.toThrow(); expect(writes(f.calls)).toEqual([]);
    }
  });

  it('retains accepted IDs on partial error or unconfirmed native readback and never replays creation', async () => {
    const partial = fixture(call => call.path === 'ConversionGoals' ? { ConversionGoalIds: ['100'], PartialErrors: [{ Code: 1, Message: 'Native error' }] } : undefined);
    await expect(partial.provider.applyWrite(op('microsoft_create_conversion_goal', { goal: offline }, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['100'] } }); expect(writes(partial.calls)).toHaveLength(1);
    const unconfirmed = fixture((call, calls) => call.path === 'ConversionGoals/QueryByIds' && writes(calls).length ? { ConversionGoals: [] } : undefined);
    await expect(unconfirmed.provider.applyWrite(op('microsoft_create_conversion_goal', { goal: offline }, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['100'] } }); expect(writes(unconfirmed.calls)).toHaveLength(1);
  });

  it('prevents generic conversion-goal mutations from bypassing typed scope and preservation checks', async () => {
    const f = fixture(); for (const [tool, kind] of [['microsoft_api_create', 'create'], ['microsoft_api_update', 'update'], ['microsoft_api_delete', 'remove']] as const) await expect(f.provider.previewWrite(op(tool, { resource: 'ConversionGoals', body: {} }, kind), guard)).rejects.toThrow('typed conversion tools');
    expect(writes(f.calls)).toEqual([]);
  });
});
