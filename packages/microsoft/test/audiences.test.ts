import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// MicrosoftDocs/Advertising@fdee2fcf: Account scope, complete rule replacement, similar-list cascade and AudienceDimension.Audiences.
type Row = Record<string, unknown>;
type Call = { path: string; method: string; body: Row; headers: RequestInit['headers'] };
const account = '777', guard = { forcePausedCreation: true };
const pageRule = { type: 'PageVisitors', normal_form: 'Conjunctive', groups: [{ items: [{ operand: 'Url', operator: 'Contains', value: '/qa-only' }] }] };
const payload = { name: 'Owned QA audience', tag_id: '200', membership_duration_days: 30, rule: pageRule };
const existing = (Id = '100', extra: Row = {}): Row => ({ Id, Type: 'RemarketingList', Scope: 'Account', ParentId: account, Name: `List ${Id}`, MembershipDuration: 30, TagId: '200', CustomerShare: null, SearchSize: null, AudienceNetworkSize: null, SupportedCampaignTypes: ['Search', 'FutureNativeType'], Rule: { Type: 'CustomEvents', Action: 'qa', ActionOperator: 'Equals', Label: 'keep', LabelOperator: 'Contains', Value: 1, ValueOperator: 'GreaterThan' }, ...extra });
function fixture(override?: (call: Call, calls: Call[]) => unknown) {
  const calls: Call[] = [], state = { audiences: [] as Row[], tags: [{ Id: '200' }] as Row[], campaigns: [{ Id: '9', CampaignType: 'Search', Status: 'Paused' }] as Row[], groups: [{ Id: '90', Status: 'Paused' }] as Row[], signals: [] as Row[], associations: [] as Row[] };
  const client = new MicrosoftAdsClient({ developerToken: 'dev', clientId: 'client', refreshToken: 'refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    const call = { path: url.pathname.replace(/^.*\/v13\//, ''), method: init.method ?? 'POST', body: JSON.parse(String(init.body ?? '{}')) as Row, headers: init.headers }; calls.push(call);
    const custom = override?.(call, calls); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (call.path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001' }] });
    if (call.path === 'Campaigns/QueryByAccountId') return Response.json({ Campaigns: state.campaigns });
    if (call.path === 'AdGroups/QueryByCampaignId') return Response.json({ AdGroups: state.groups });
    if (call.path === 'UetTags/QueryByIds') return Response.json({ UetTags: state.tags.filter(value => (call.body.TagIds as string[]).includes(String(value.Id))) });
    if (call.path === 'AudienceGroups/QueryByIds') return Response.json({ AudienceGroups: state.signals });
    if (call.path === 'Audiences/QueryByIds') return Response.json({ Audiences: state.audiences.filter(value => String(call.body.Type).split(', ').includes(String(value.Type))), PartialErrors: [] });
    if (/^(Campaign|AdGroup)Criterions\/QueryByIds$/.test(call.path)) {
      const prefix = call.path.startsWith('AdGroup') ? 'AdGroup' : 'Campaign';
      return Response.json({ [`${prefix}Criterions`]: state.associations.filter(value => value[`${prefix}Id`] === call.body[`${prefix}Id`] && (value.Criterion as Row).AudienceType === call.body.CriterionType) });
    }
    if (call.path === 'Audiences') {
      if (call.method === 'POST') { state.audiences.push(existing('100', (call.body.Audiences as Row[])[0])); return Response.json({ AudienceIds: ['100'], PartialErrors: [] }); }
      if (call.method === 'PUT') { const value = (call.body.Audiences as Row[])[0]!; Object.assign(state.audiences.find(item => item.Id === value.Id)!, value); return Response.json({ PartialErrors: [] }); }
      if (call.method === 'DELETE') { const ids = call.body.AudienceIds as string[]; state.audiences = state.audiences.filter(value => !ids.includes(String(value.Id)) && !ids.includes(String(value.SourceId))); return Response.json({ PartialErrors: [] }); }
    }
    throw new Error(`Unexpected ${call.method} ${call.path}`);
  });
  return { provider: new MicrosoftAdsProvider(client), state, calls };
}
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'microsoft', accountId: account, payload, kind });
const writes = (calls: Call[]) => calls.filter(value => value.path === 'Audiences');

describe('Microsoft account audiences', () => {
  it('defines lazy tools, excludes reserved types and rejects incomplete or invalid rules', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(tools.filter(value => /microsoft_(audiences|get_audience|audience_usage|.*remarketing_list)$/.test(value.name))).toHaveLength(6);
    const schema = tools.find(value => value.name === 'microsoft_create_remarketing_list')!.input;
    expect(schema.safeParse({ account_id: account, ...payload }).success).toBe(true);
    for (const rule of [{ type: 'CustomEvents' }, { type: 'CustomEvents', action: { text: 'x' } }, { ...pageRule, groups: [] }, { type: 'CustomEvents', value: { operator: 'Equals', amount: -1 } }]) expect(schema.safeParse({ account_id: account, ...payload, rule }).success).toBe(false);
    expect(tools.find(value => value.name === 'microsoft_audiences')!.input.safeParse({ account_id: account, audience_types: ['AIPrompt'] }).success).toBe(false);
  });

  it('uses selected-account headers, CSV selectors and NormalForm; preserves unavailable sizes and paginates', async () => {
    const f = fixture(); f.state.audiences.push(existing('101'), existing('100', { CustomerShare: { CustomerAccountShares: [{ AccountId: '999' }] } }));
    const page = await f.provider.audiences.list({ account_id: account, audience_types: ['RemarketingList', 'CustomerList'], limit: 1 });
    expect(page).toMatchObject({ truncated: true, next_cursor: '100', rows: [{ shared: true, audience: { Id: '100', SearchSize: null, AudienceNetworkSize: null, SupportedCampaignTypes: ['Search', 'FutureNativeType'] } }] });
    expect(page.rows[0]!.audience).not.toHaveProperty('CustomerShare');
    const query = f.calls.find(value => value.path === 'Audiences/QueryByIds')!;
    expect(query).toMatchObject({ method: 'POST', body: { AudienceIds: null, Type: 'RemarketingList, CustomerList', ReturnAdditionalFields: expect.stringContaining('NormalForm') }, headers: { CustomerAccountId: account, CustomerId: '9001' } });
    expect(await f.provider.audiences.list({ account_id: account, audience_types: ['RemarketingList'], after_audience_id: '100', limit: 1 })).toMatchObject({ rows: [{ audience: { Id: '101' } }], truncated: false });
  });

  it('rejects absent/mismatched native envelopes rather than presenting false emptiness', async () => {
    for (const result of [{}, { Audiences: [existing('100', { Type: 'CustomerList' })] }, { Audiences: [existing(), existing()] }]) {
      const f = fixture(call => call.path === 'Audiences/QueryByIds' ? result : undefined);
      await expect(f.provider.audiences.list({ account_id: account, audience_types: ['RemarketingList'], limit: 100 })).rejects.toThrow();
    }
  });

  it.each([
    [pageRule, { Type: 'PageVisitors', NormalForm: 'Conjunctive', RuleItemGroups: [{ Items: [{ Type: 'String', Operand: 'Url', Operator: 'Contains', Value: '/qa-only' }] }] }],
    [{ type: 'PageVisitorsWhoVisitedAnotherPage', groups: pageRule.groups, another_groups: pageRule.groups }, { Type: 'PageVisitorsWhoVisitedAnotherPage', RuleItemGroups: expect.any(Array), AnotherRuleItemGroups: expect.any(Array) }],
    [{ type: 'PageVisitorsWhoDidNotVisitAnotherPage', include_groups: pageRule.groups, exclude_groups: pageRule.groups }, { Type: 'PageVisitorsWhoDidNotVisitAnotherPage', IncludeRuleItemGroups: expect.any(Array), ExcludeRuleItemGroups: expect.any(Array) }],
    [{ type: 'CustomEvents', action: { operator: 'Equals', text: 'qa' }, value: { operator: 'GreaterThanEqualTo', amount: 1 } }, { Type: 'CustomEvents', Action: 'qa', ActionOperator: 'Equals', Value: 1, ValueOperator: 'GreaterThanEqualTo' }],
  ])('creates unshared Account lists with native rule wire format %#', async (rule, expected) => {
    const f = fixture(), operation = op('microsoft_create_remarketing_list', { ...payload, rule }, 'create');
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [] }); expect(writes(f.calls)).toHaveLength(0);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['100'] });
    expect(writes(f.calls)[0]).toMatchObject({ method: 'POST', body: { Audiences: [{ Type: 'RemarketingList', Scope: 'Account', ParentId: account, TagId: '200', MembershipDuration: 30, Rule: expected }] } });
    expect((writes(f.calls)[0]!.body.Audiences as Row[])[0]).not.toHaveProperty('Status'); expect((writes(f.calls)[0]!.body.Audiences as Row[])[0]).not.toHaveProperty('CustomerShare');
  });

  it('blocks unavailable UET tags, duplicate names and generic audience writes before mutation', async () => {
    const f = fixture(); f.state.tags = [];
    await expect(f.provider.previewWrite(op('microsoft_create_remarketing_list', payload, 'create'), guard)).rejects.toThrow('UET tag');
    f.state.tags = [{ Id: '200' }]; f.state.audiences.push(existing('100', { Name: payload.name.toUpperCase() }));
    await expect(f.provider.previewWrite(op('microsoft_create_remarketing_list', payload, 'create'), guard)).rejects.toThrow('already exists');
    for (const [tool, kind] of [['microsoft_api_create', 'create'], ['microsoft_api_update', 'update'], ['microsoft_api_delete', 'remove']] as const) await expect(f.provider.previewWrite(op(tool, { resource: 'AUDIENCES', body: {} }, kind), guard)).rejects.toThrow('typed audience tools');
    expect(writes(f.calls)).toHaveLength(0);
  });

  it('excludes system-owned size changes from snapshots and binds actual configuration', async () => {
    const f = fixture(); f.state.audiences.push(existing()); const first = await f.provider.audiences.get(account, '100', 'RemarketingList');
    f.state.audiences[0]!.SearchSize = '500'; f.state.audiences[0]!.AudienceNetworkSize = 123;
    expect((await f.provider.audiences.get(account, '100', 'RemarketingList')).snapshot_hash).toBe(first.snapshot_hash);
    f.state.audiences[0]!.Name = 'Concurrent edit';
    await expect(f.provider.applyWrite(op('microsoft_update_remarketing_list', { audience_id: '100', expected_snapshot_hash: first.snapshot_hash, name: 'Rename' }), guard)).rejects.toThrow('snapshot changed'); expect(writes(f.calls)).toHaveLength(0);
  });

  it('preserves complete omitted rules/tag/retention/scope during metadata edits', async () => {
    const f = fixture(); f.state.audiences.push(existing()); const before = structuredClone(f.state.audiences[0]!), current = await f.provider.audiences.get(account, '100', 'RemarketingList');
    const operation = op('microsoft_update_remarketing_list', { audience_id: '100', expected_snapshot_hash: current.snapshot_hash, name: 'Reviewed', description: 'Review complete' });
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ fieldChanges: [{ field: 'Name', before: 'List 100', after: 'Reviewed' }, { field: 'Description', before: '(unset)', after: 'Review complete' }] });
    await f.provider.applyWrite(operation, guard);
    expect(writes(f.calls)[0]!.body).toEqual({ Audiences: [{ Id: '100', Type: 'RemarketingList', Name: 'Reviewed', Description: 'Review complete' }] });
    expect(f.state.audiences[0]).toEqual({ ...before, Name: 'Reviewed', Description: 'Review complete' });
  });

  it('replaces only an explicitly supplied rule and reports every changed setting', async () => {
    const f = fixture(); f.state.audiences.push(existing()); const current = await f.provider.audiences.get(account, '100', 'RemarketingList');
    await f.provider.applyWrite(op('microsoft_update_remarketing_list', { audience_id: '100', expected_snapshot_hash: current.snapshot_hash, membership_duration_days: 15, rule: { type: 'CustomEvents', action: { operator: 'Contains', text: 'replacement' } } }), guard);
    expect(f.state.audiences[0]).toMatchObject({ MembershipDuration: 15, Rule: { Type: 'CustomEvents', Action: 'replacement', ActionOperator: 'Contains' } });
    expect(f.state.audiences[0]!.Rule).not.toHaveProperty('Label'); expect(f.state.audiences[0]!.TagId).toBe('200');
  });

  it.each([{ Scope: 'Customer', ParentId: '9001' }, { ParentId: '888' }, { CustomerShare: { CustomerAccountShares: [{ AccountId: account }] } }])('blocks unsafe ownership/sharing %# even with a matching hash', async extra => {
    const f = fixture(); f.state.audiences.push(existing('100', extra)); const current = await f.provider.audiences.get(account, '100', 'RemarketingList');
    for (const [tool, kind, fields] of [['microsoft_update_remarketing_list', 'update', { name: 'Unsafe' }], ['microsoft_delete_remarketing_list', 'remove', {}]] as const) await expect(f.provider.applyWrite(op(tool, { audience_id: '100', expected_snapshot_hash: current.snapshot_hash, ...fields }, kind), guard)).rejects.toThrow('unshared Account-scoped');
    expect(writes(f.calls)).toHaveLength(0);
  });

  it.each(['campaign', 'ad_group', 'combined', 'signal'])('blocks deletion with %s references, including derived similar lists', async kind => {
    const f = fixture(); f.state.audiences.push(existing(), existing('101', { Type: 'SimilarRemarketingList', SourceId: '100' }));
    const criterion = { Id: '700', Type: kind === 'campaign' ? 'NegativeCampaignCriterion' : 'BiddableAdGroupCriterion', Criterion: { Type: 'AudienceCriterion', AudienceId: '101', AudienceType: 'SimilarRemarketingList' } };
    if (kind === 'campaign') f.state.associations.push({ ...criterion, CampaignId: '9' });
    if (kind === 'ad_group') f.state.associations.push({ ...criterion, AdGroupId: '90' });
    if (kind === 'combined') f.state.audiences.push(existing('102', { Type: 'CombinedList', CombinationRules: [{ AudienceIds: ['101'], Operator: 'And' }] }));
    if (kind === 'signal') f.state.signals.push({ Id: '103', Dimensions: [{ Type: 'Audience', Audiences: [{ Id: '101', Type: 'SimilarRemarketingList' }] }] });
    const current = await f.provider.audiences.get(account, '100', 'RemarketingList');
    await expect(f.provider.applyWrite(op('microsoft_delete_remarketing_list', { audience_id: '100', expected_snapshot_hash: current.snapshot_hash }, 'remove'), guard)).rejects.toThrow('is referenced'); expect(writes(f.calls)).toHaveLength(0);
  });

  it('deletes only unused owned lists, previews the similar-list cascade and confirms both disappear', async () => {
    const f = fixture(); f.state.audiences.push(existing(), existing('101', { Type: 'SimilarRemarketingList', SourceId: '100' }));
    const current = await f.provider.audiences.get(account, '100', 'RemarketingList'), operation = op('microsoft_delete_remarketing_list', { audience_id: '100', expected_snapshot_hash: current.snapshot_hash }, 'remove');
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ changes: expect.arrayContaining([expect.stringContaining('["101"]')]) });
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['100', '101'] });
    expect(writes(f.calls)[0]).toMatchObject({ method: 'DELETE', body: { AudienceIds: ['100'] } }); expect(f.state.audiences).toEqual([]);
    expect(f.calls.find(value => value.path === 'AdGroupCriterions/QueryByIds')!.body).toEqual({ AdGroupId: '90', AdGroupCriterionIds: null, CriterionType: 'RemarketingList' });
  });

  it('fails closed on incomplete or oversized use checks and mismatched parent criteria', async () => {
    for (const override of [
      (call: Call) => call.path === 'AudienceGroups/QueryByIds' ? {} : undefined,
      (call: Call) => call.path === 'AudienceGroups/QueryByIds' ? { AudienceGroups: Array.from({ length: 100 }, (_, i) => ({ Id: String(i + 1) })) } : undefined,
      (call: Call) => call.path === 'AdGroups/QueryByCampaignId' ? {} : undefined,
      (call: Call) => call.path === 'CampaignCriterions/QueryByIds' ? { CampaignCriterions: [{ Id: '999', CampaignId: '888', Criterion: { Type: 'Audience', AudienceType: 'RemarketingList', AudienceId: '100' } }] } : undefined,
    ]) {
      const f = fixture(override); f.state.audiences.push(existing()); await expect(f.provider.audiences.usage(account, '100')).rejects.toThrow(); expect(writes(f.calls)).toHaveLength(0);
    }
    const f = fixture(); f.state.audiences.push(existing()); f.state.campaigns = [{ Id: '9', CampaignType: 'Hotel' }]; await expect(f.provider.audiences.usage(account, '100')).rejects.toThrow('unsupported campaign type');
  });

  it('retains native IDs on partial acceptance or uncertain readback and never retries creation', async () => {
    const partial = fixture(call => call.path === 'Audiences' ? { AudienceIds: ['100'], PartialErrors: [{ Code: 1, Message: 'Native error' }] } : undefined);
    await expect(partial.provider.applyWrite(op('microsoft_create_remarketing_list', payload, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['100'] } }); expect(writes(partial.calls)).toHaveLength(1);
    const unconfirmed = fixture((call, calls) => call.path === 'Audiences/QueryByIds' && writes(calls).length ? { Audiences: [] } : undefined);
    await expect(unconfirmed.provider.applyWrite(op('microsoft_create_remarketing_list', payload, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['100'] } }); expect(writes(unconfirmed.calls)).toHaveLength(1);
  });

  it('does not confirm replacement when an omitted event condition remains active natively', async () => {
    const f = fixture(call => call.path === 'Audiences' && call.method === 'PUT' ? { PartialErrors: [] } : undefined);
    f.state.audiences.push(existing()); const current = await f.provider.audiences.get(account, '100', 'RemarketingList');
    await expect(f.provider.applyWrite(op('microsoft_update_remarketing_list', { audience_id: '100', expected_snapshot_hash: current.snapshot_hash, rule: { type: 'CustomEvents', action: { operator: 'Equals', text: 'qa' } } }), guard)).rejects.toMatchObject({ details: { resourceIds: ['100'] } }); expect(writes(f.calls)).toHaveLength(1);
  });

  it('recognizes both the REST JSON AudienceCriterion discriminator and the inherited table spelling', async () => {
    for (const Type of ['AudienceCriterion', 'Audience']) {
      const f = fixture(); f.state.audiences.push(existing()); f.state.associations.push({ Id: '700', CampaignId: '9', Type: 'BiddableCampaignCriterion', Criterion: { Type, AudienceId: '100', AudienceType: 'RemarketingList' } });
      expect(await f.provider.audiences.usage(account, '100')).toMatchObject({ complete: true, associations: [{ campaign_id: '9', criterion: { Id: '700' } }] });
    }
  });

  it('checks Performance Max campaign exclusions as well as its separate audience-signal library', async () => {
    const f = fixture(); f.state.audiences.push(existing()); f.state.campaigns = [{ Id: '9', CampaignType: 'PerformanceMax' }];
    f.state.associations.push({ Id: '700', CampaignId: '9', Type: 'NegativeCampaignCriterion', Criterion: { Type: 'AudienceCriterion', AudienceId: '100', AudienceType: 'RemarketingList' } });
    expect(await f.provider.audiences.usage(account, '100')).toMatchObject({ complete: true, ad_groups_scanned: 0, associations: [{ campaign_id: '9', criterion: { Id: '700', Type: 'NegativeCampaignCriterion' } }] });
    expect(f.calls.some(value => value.path.startsWith('AdGroups/'))).toBe(false);
    const current = await f.provider.audiences.get(account, '100', 'RemarketingList');
    await expect(f.provider.applyWrite(op('microsoft_delete_remarketing_list', { audience_id: '100', expected_snapshot_hash: current.snapshot_hash }, 'remove'), guard)).rejects.toThrow('is referenced'); expect(writes(f.calls)).toHaveLength(0);
  });

  it('blocks a deletion cascade when a derived similar list has wider ownership', async () => {
    const f = fixture(); f.state.audiences.push(existing(), existing('101', { Type: 'SimilarRemarketingList', SourceId: '100', Scope: 'Customer', ParentId: '9001' }));
    const current = await f.provider.audiences.get(account, '100', 'RemarketingList');
    await expect(f.provider.applyWrite(op('microsoft_delete_remarketing_list', { audience_id: '100', expected_snapshot_hash: current.snapshot_hash }, 'remove'), guard)).rejects.toThrow('wider or unverifiable ownership'); expect(writes(f.calls)).toHaveLength(0);
  });
});
