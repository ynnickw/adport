import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// MicrosoftDocs/Advertising@fdee2fcf: CampaignAdditionalField.TargetSetting, concrete read selectors, Active-only criteria and whole Details replacement.
type Row = Record<string, unknown>;
type Call = { path: string; method: string; body: Row; headers: RequestInit['headers'] };
const account = '777', guard = { forcePausedCreation: true }, campaignTarget = { type: 'Campaign' as const, campaign_id: '9' }, groupTarget = { type: 'AdGroup' as const, campaign_id: '9', ad_group_id: '90' };
const criteria = (kind: 'Campaign' | 'AdGroup' = 'Campaign', extra: Row = {}): Row => ({ Id: '700', [`${kind}Id`]: kind === 'Campaign' ? '9' : '90', Type: `Biddable${kind}Criterion`, Status: 'Active', Criterion: { Type: 'AudienceCriterion', AudienceId: '100', AudienceType: 'RemarketingList' }, CriterionBid: { Type: 'BidMultiplier', Multiplier: 0 }, ...extra });
const selectors: Record<string, string> = { CustomAudience: 'Custom', InMarketAudience: 'InMarket', ProductAudience: 'Product' };
function fixture(override?: (call: Call, calls: Call[]) => unknown) {
  const calls: Call[] = [], state = {
    campaign: { Id: '9', CampaignType: 'Search', Status: 'Paused', Settings: [] } as Row,
    groups: [{ Id: '90', Status: 'Paused', Settings: [] }] as Row[],
    audiences: [{ Id: '100', Type: 'RemarketingList', Scope: 'Account', ParentId: account, Name: 'Owned audience', TagId: '200', MembershipDuration: 1, Rule: { Type: 'PageVisitors', NormalForm: 'Disjunctive', RuleItemGroups: [] }, CustomerShare: null, SearchSize: null }] as Row[],
    criteria: [] as Row[],
  };
  const client = new MicrosoftAdsClient({ developerToken: 'dev', clientId: 'client', refreshToken: 'refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    const call = { path: url.pathname.replace(/^.*\/v13\//, ''), method: init.method ?? 'POST', body: JSON.parse(String(init.body ?? '{}')) as Row, headers: init.headers }; calls.push(call);
    const custom = override?.(call, calls); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (call.path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001' }] });
    if (call.path === 'Campaigns/QueryByAccountId') { const campaign = structuredClone(state.campaign); campaign.Settings = (campaign.Settings as Row[]).filter(value => value.Type !== 'TargetSetting'); return Response.json({ Campaigns: [campaign] }); }
    if (call.path === 'Campaigns/QueryByIds') return Response.json({ Campaigns: (call.body.CampaignIds as string[]).includes(String(state.campaign.Id)) ? [state.campaign] : [] });
    if (call.path === 'AdGroups/QueryByIds') return Response.json({ AdGroups: call.body.CampaignId === '9' ? state.groups.filter(value => (call.body.AdGroupIds as string[]).includes(String(value.Id))) : [] });
    if (call.path === 'AdGroups/QueryByCampaignId') return Response.json({ AdGroups: state.groups });
    if (call.path === 'Audiences/QueryByIds') return Response.json({ Audiences: state.audiences.filter(value => String(call.body.Type).split(', ').includes(String(value.Type))) });
    if (/^(Campaign|AdGroup)Criterions\/QueryByIds$/.test(call.path)) {
      const kind = call.path.startsWith('AdGroup') ? 'AdGroup' : 'Campaign', type = selectors[String(call.body.CriterionType)] ?? call.body.CriterionType;
      return Response.json({ [`${kind}Criterions`]: state.criteria.filter(value => value[`${kind}Id`] === call.body[`${kind}Id`] && (value.Criterion as Row).AudienceType === type) });
    }
    if (/^(Campaign|AdGroup)Criterions$/.test(call.path)) {
      const kind = call.path.startsWith('AdGroup') ? 'AdGroup' : 'Campaign';
      if (call.method === 'POST') {
        const value = (call.body[`${kind}Criterions`] as Row[])[0]!, source = state.audiences.find(source => source.Id === (value.Criterion as Row).AudienceId)!;
        state.criteria.push({ ...value, Id: '701', Status: 'Active', Criterion: { ...(value.Criterion as Row), AudienceType: source.Type } });
        return Response.json({ [`${kind}CriterionIds`]: ['701'], NestedPartialErrors: [] });
      }
      if (call.method === 'PUT') { const value = (call.body[`${kind}Criterions`] as Row[])[0]!; Object.assign(state.criteria.find(current => current.Id === value.Id && current[`${kind}Id`] === value[`${kind}Id`])!, value); return Response.json({ NestedPartialErrors: [] }); }
      if (call.method === 'DELETE') { state.criteria = state.criteria.filter(value => value[`${kind}Id`] !== call.body[`${kind}Id`] || !(call.body[`${kind}CriterionIds`] as string[]).includes(String(value.Id))); return Response.json({ PartialErrors: [] }); }
    }
    if (['Campaigns', 'AdGroups'].includes(call.path) && call.method === 'PUT') {
      const value = (call.body[call.path] as Row[])[0]!, current = call.path === 'Campaigns' ? state.campaign : state.groups.find(group => group.Id === value.Id)!;
      const settings = value.Settings as Row[], previous = current.Settings as Row[];
      current.Settings = [...previous.filter(value => !settings.some(setting => setting.Type === value.Type)), ...settings.filter(value => Array.isArray(value.Details) && value.Details.length)];
      return Response.json({ PartialErrors: [] });
    }
    throw new Error(`Unexpected ${call.method} ${call.path}`);
  });
  return { provider: new MicrosoftAdsProvider(client), state, calls };
}
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'microsoft', accountId: account, payload, kind });
const writes = (calls: Call[]) => calls.filter(value => /^(Campaign|AdGroup)(Criterions|s)$/.test(value.path));
const read = (f: ReturnType<typeof fixture>, target = campaignTarget as typeof campaignTarget | typeof groupTarget) => f.provider.audienceTargeting.list({ account_id: account, target, audience_type: 'RemarketingList', limit: 100 });
async function addInput(f: ReturnType<typeof fixture>, extra: Row = {}) { const source = await f.provider.audiences.get(account, '100', 'RemarketingList'); return { target: campaignTarget, audience_id: '100', audience_type: 'RemarketingList', expected_audience_snapshot_hash: source.snapshot_hash, expected_target_and_bid: false, ...extra }; }

describe('Microsoft audience targeting', () => {
  it('defines lazy shared tools and makes source/mode acknowledgement explicit', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(tools.filter(value => /microsoft_(audience_targets|add_audience_target|set_audience_target_bid|remove_audience_target|set_audience_target_mode)$/.test(value.name))).toHaveLength(5);
    const schema = tools.find(value => value.name === 'microsoft_add_audience_target')!.input, base = { account_id: account, target: campaignTarget, audience_id: '100', audience_type: 'RemarketingList', expected_audience_snapshot_hash: 'a'.repeat(64) };
    expect(schema.safeParse(base).success).toBe(false); expect(schema.safeParse({ ...base, expected_target_and_bid: false }).success).toBe(true);
    expect(schema.safeParse({ ...base, exclude: true }).success).toBe(true); expect(schema.safeParse({ ...base, exclude: true, bid_adjustment_percent: 10 }).success).toBe(false);
  });

  it('requests campaign TargetSetting explicitly and verifies the full ad-group hierarchy', async () => {
    const f = fixture(); f.state.campaign.Settings = [{ Type: 'TargetSetting', Details: [{ CriterionTypeGroup: 'Audience', TargetAndBid: true }] }];
    expect(await read(f)).toMatchObject({ context: { target_and_bid: true, audience_target_option: 'TargetAndBid' }, rows: [], truncated: false });
    expect(f.calls.find(value => value.path === 'Campaigns/QueryByIds')).toMatchObject({ body: { AccountId: account, CampaignIds: ['9'], CampaignType: 'Search', ReturnAdditionalFields: 'TargetSetting' }, headers: { CustomerAccountId: account, CustomerId: '9001' } });
    expect(await read(f, groupTarget)).toMatchObject({ context: { target_and_bid: false, target: groupTarget, campaign_status: 'Paused', ad_group_status: 'Paused' } });
    expect(f.calls.find(value => value.path === 'AdGroups/QueryByIds')!.body).toMatchObject({ CampaignId: '9', AdGroupIds: ['90'] });
  });

  it('uses concrete Custom/InMarket/Product read selectors and paginates without inventing native cursors', async () => {
    const f = fixture(); f.state.criteria.push(criteria('Campaign', { Id: '702' }), criteria());
    expect(await f.provider.audienceTargeting.list({ account_id: account, target: campaignTarget, audience_type: 'RemarketingList', limit: 1 })).toMatchObject({ rows: [{ criterion: { Id: '700' } }], truncated: true, next_cursor: '700' });
    expect(await f.provider.audienceTargeting.list({ account_id: account, target: campaignTarget, audience_type: 'RemarketingList', after_criterion_id: '700', limit: 1 })).toMatchObject({ rows: [{ criterion: { Id: '702' } }], truncated: false });
    for (const type of ['Custom', 'InMarket', 'Product'] as const) await f.provider.audienceTargeting.list({ account_id: account, target: groupTarget, audience_type: type, limit: 1 });
    expect(f.calls.filter(value => value.path === 'AdGroupCriterions/QueryByIds').map(value => value.body.CriterionType)).toEqual(['CustomAudience', 'InMarketAudience', 'ProductAudience']);
  });

  it('creates only one Active native association behind a paused parent and never mutates source/mode/status', async () => {
    const f = fixture(); f.state.groups = []; const input = await addInput(f), operation = op('microsoft_add_audience_target', input, 'create');
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [] }); expect(writes(f.calls)).toHaveLength(0);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['701'] });
    expect(writes(f.calls)[0]!.body).toEqual({ CriterionType: 'Audience', CampaignCriterions: [{ CampaignId: '9', Type: 'BiddableCampaignCriterion', Criterion: { Type: 'AudienceCriterion', AudienceId: '100' }, CriterionBid: { Type: 'BidMultiplier', Multiplier: 0 } }] });
    expect(f.state.criteria[0]).toMatchObject({ Status: 'Active' }); expect(f.state.campaign.Status).toBe('Paused');
  });

  it('supports an effectively paused ad group and keeps exclusions independent of target mode', async () => {
    const f = fixture(); f.state.campaign.Status = 'Active'; f.state.criteria.push(criteria());
    const input = await addInput(f, { target: groupTarget, exclude: true, expected_target_and_bid: undefined });
    await f.provider.applyWrite(op('microsoft_add_audience_target', input, 'create'), guard);
    expect(writes(f.calls)[0]!.body).toEqual({ CriterionType: 'Audience', AdGroupCriterions: [{ AdGroupId: '90', Type: 'NegativeAdGroupCriterion', Criterion: { Type: 'AudienceCriterion', AudienceId: '100' } }] });
    expect(f.state.criteria).toHaveLength(2);
  });

  it('refuses active parents under paused_creation without inventing a Paused criterion', async () => {
    const f = fixture(); f.state.campaign.Status = 'Active'; f.state.groups[0]!.Status = 'Active';
    await expect(f.provider.previewWrite(op('microsoft_add_audience_target', await addInput(f, { target: groupTarget }), 'create'), guard)).rejects.toThrow('paused campaign or ad group'); expect(writes(f.calls)).toHaveLength(0);
  });

  it('binds audience definition and target mode and rejects duplicate associations', async () => {
    const f = fixture(), input = await addInput(f); f.state.audiences[0]!.Name = 'Concurrent source edit';
    await expect(f.provider.previewWrite(op('microsoft_add_audience_target', input, 'create'), guard)).rejects.toThrow('audience definition changed');
    const fresh = await addInput(f); f.state.campaign.Settings = [{ Type: 'TargetSetting', Details: [{ CriterionTypeGroup: 'Audience', TargetAndBid: true }] }];
    await expect(f.provider.previewWrite(op('microsoft_add_audience_target', fresh, 'create'), guard)).rejects.toThrow('target mode changed');
    f.state.campaign.Settings = []; f.state.criteria.push(criteria());
    await expect(f.provider.previewWrite(op('microsoft_add_audience_target', fresh, 'create'), guard)).rejects.toThrow('already associated'); expect(writes(f.calls)).toHaveLength(0);
  });

  it.each(['Campaign', 'AdGroup'] as const)('blocks positive %s creation when the opposite level already targets audiences', async kind => {
    const f = fixture(); f.state.criteria.push(criteria(kind === 'Campaign' ? 'AdGroup' : 'Campaign'));
    const input = await addInput(f, { target: kind === 'Campaign' ? campaignTarget : groupTarget });
    await expect(f.provider.previewWrite(op('microsoft_add_audience_target', input, 'create'), guard)).rejects.toThrow('opposite campaign/ad-group level'); expect(writes(f.calls)).toHaveLength(0);
    const querySelectors = new Set(f.calls.filter(value => value.path.endsWith('Criterions/QueryByIds')).map(value => value.body.CriterionType));
    expect(querySelectors).toEqual(new Set(['RemarketingList', 'CustomAudience', 'InMarketAudience', 'ProductAudience', 'SimilarRemarketingList', 'CombinedList', 'CustomerList', 'ImpressionBasedRemarketingList']));
  });

  it('permits only campaign exclusions for Performance Max and refuses TargetSetting edits', async () => {
    const f = fixture(); f.state.campaign.CampaignType = 'PerformanceMax'; const input = await addInput(f);
    await expect(f.provider.previewWrite(op('microsoft_add_audience_target', input, 'create'), guard)).rejects.toThrow('exclusions only');
    await f.provider.applyWrite(op('microsoft_add_audience_target', { ...input, exclude: true, expected_target_and_bid: undefined }, 'create'), guard);
    expect(writes(f.calls)[0]!.body).toMatchObject({ CampaignCriterions: [{ Type: 'NegativeCampaignCriterion' }] });
    const current = await read(f);
    await expect(f.provider.previewWrite(op('microsoft_set_audience_target_mode', { target: campaignTarget, expected_context_hash: current.context.context_hash, target_and_bid: true }), guard)).rejects.toThrow('does not support TargetSetting');
    await expect(read(f, groupTarget)).rejects.toThrow('not ordinary ad-group criteria');
  });

  it('updates only a positive percentage bid and binds the current criterion/parent snapshot', async () => {
    const f = fixture(); f.state.criteria.push(criteria()); const before = await read(f), input = { target: campaignTarget, audience_type: 'RemarketingList', criterion_id: '700', expected_snapshot_hash: before.rows[0]!.snapshot_hash, bid_adjustment_percent: 10 };
    await f.provider.applyWrite(op('microsoft_set_audience_target_bid', input), guard);
    expect(writes(f.calls)[0]!.body).toEqual({ CampaignCriterions: [{ CampaignId: '9', Id: '700', Type: 'BiddableCampaignCriterion', CriterionBid: { Type: 'BidMultiplier', Multiplier: 10 } }], CriterionType: 'Audience' });
    expect(f.state.criteria[0]!.Criterion).toEqual(criteria().Criterion);
    await expect(f.provider.applyWrite(op('microsoft_set_audience_target_bid', { ...input, bid_adjustment_percent: 20 }), guard)).rejects.toThrow('criterion or parent context changed'); expect(writes(f.calls)).toHaveLength(1);
  });

  it('does not edit exclusion bids and removes only the selected owned criterion', async () => {
    const f = fixture(); f.state.criteria.push(criteria('AdGroup', { Type: 'NegativeAdGroupCriterion', CriterionBid: undefined }), criteria('AdGroup', { Id: '702' }));
    const before = await read(f, groupTarget), input = { target: groupTarget, audience_type: 'RemarketingList', criterion_id: '700', expected_snapshot_hash: before.rows[0]!.snapshot_hash };
    await expect(f.provider.previewWrite(op('microsoft_set_audience_target_bid', { ...input, bid_adjustment_percent: 10 }), guard)).rejects.toThrow('only biddable audience');
    await f.provider.applyWrite(op('microsoft_remove_audience_target', input, 'remove'), guard);
    expect(writes(f.calls)[0]).toMatchObject({ method: 'DELETE', body: { AdGroupId: '90', AdGroupCriterionIds: ['700'], CriterionType: 'Audience' } }); expect(f.state.criteria.map(value => value.Id)).toEqual(['702']);
  });

  it('preserves other target groups and setting types during delivery-mode replacement and restoration', async () => {
    const f = fixture(); f.state.campaign.CampaignType = 'Audience';
    const other = { Type: 'OtherNativeSetting', Value: 'unchanged' }, age = { CriterionTypeGroup: 'Age', TargetAndBid: true };
    f.state.groups[0]!.Settings = [other, { Type: 'TargetSetting', Details: [age] }];
    let current = await read(f, groupTarget);
    for (const target_and_bid of [true, false]) {
      await f.provider.applyWrite(op('microsoft_set_audience_target_mode', { target: groupTarget, expected_context_hash: current.context.context_hash, target_and_bid }), guard);
      current = await read(f, groupTarget); expect(current.context.target_and_bid).toBe(target_and_bid);
      expect(f.state.groups[0]!.Settings).toEqual([other, { Type: 'TargetSetting', Details: [age, ...(target_and_bid ? [{ CriterionTypeGroup: 'Audience', TargetAndBid: true }] : [])] }]);
    }
    expect(writes(f.calls)[0]!.body).toEqual({ CampaignId: '9', AdGroups: [{ Id: '90', Settings: [{ Type: 'TargetSetting', Details: [age, { CriterionTypeGroup: 'Audience', TargetAndBid: true }] }] }] });
  });

  it('uses native null Details to restore campaign default and rejects stale parent context', async () => {
    const f = fixture(); f.state.campaign.Settings = [{ Type: 'TargetSetting', Details: [{ CriterionTypeGroup: 'Audience', TargetAndBid: true }] }];
    const before = await read(f), input = { target: campaignTarget, expected_context_hash: before.context.context_hash, target_and_bid: false };
    await f.provider.applyWrite(op('microsoft_set_audience_target_mode', input), guard);
    expect(writes(f.calls)[0]!.body).toEqual({ AccountId: account, Campaigns: [{ Id: '9', Settings: [{ Type: 'TargetSetting', Details: null }] }] });
    await expect(f.provider.applyWrite(op('microsoft_set_audience_target_mode', input), guard)).rejects.toThrow('parent context changed');
  });

  it('fails closed on oversized/missing opposite-level inventories, missing parents and malformed criteria', async () => {
    for (const result of [{}, { AdGroups: Array.from({ length: 51 }, (_, i) => ({ Id: String(i + 1) })) }]) {
      const f = fixture(call => call.path === 'AdGroups/QueryByCampaignId' ? result : undefined);
      await expect(f.provider.previewWrite(op('microsoft_add_audience_target', await addInput(f), 'create'), guard)).rejects.toThrow(); expect(writes(f.calls)).toHaveLength(0);
    }
    const foreign = fixture(call => call.path === 'AdGroups/QueryByIds' ? { AdGroups: [{ Id: '999', Status: 'Paused' }] } : undefined); await expect(read(foreign, groupTarget)).rejects.toThrow('not found');
    const malformed = fixture(call => call.path === 'CampaignCriterions/QueryByIds' ? { CampaignCriterions: [criteria('Campaign', { CampaignId: '888' })] } : undefined); await expect(read(malformed)).rejects.toThrow('ownership or type mismatch');
  });

  it('blocks case aliases in generic criteria and TargetSetting writes before provider access', async () => {
    const f = fixture();
    for (const [resource, body] of [['CampaignCriterions', { criterionTYPE: 'AuDiEnCe' }], ['AdGroupCriterions', { AdGroupCriterions: [{ Criterion: { tYPE: 'AudienceCriterion' } }] }], ['Campaigns', { Campaigns: [{ Settings: [{ tYPE: 'TargetSetting' }] }] }], ['AdGroups', { AdGroups: [{ Settings: [{ Type: 'Target' }] }] }]] as const) {
      await expect(f.provider.previewWrite(op('microsoft_api_update', { resource, body }), guard)).rejects.toThrow(/typed audience-targeting|microsoft_set_audience_target_mode/);
    }
    expect(f.calls).toHaveLength(0);
  });

  it('preserves accepted ad-group IDs on partial errors and never retries an uncertain association', async () => {
    const partial = fixture(call => call.path === 'AdGroupCriterions' ? { AdGroupCriterionIds: ['701'], NestedPartialErrors: [{ Index: 0, BatchErrors: [{ Code: 1, Message: 'Native error' }] }] } : undefined);
    await expect(partial.provider.applyWrite(op('microsoft_add_audience_target', await addInput(partial, { target: groupTarget, exclude: true, expected_target_and_bid: undefined }), 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['701'] } }); expect(writes(partial.calls)).toHaveLength(1);
    const unconfirmed = fixture((call, calls) => call.path === 'CampaignCriterions/QueryByIds' && writes(calls).length ? { CampaignCriterions: [] } : undefined); unconfirmed.state.groups = [];
    await expect(unconfirmed.provider.applyWrite(op('microsoft_add_audience_target', await addInput(unconfirmed), 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['701'] } }); expect(writes(unconfirmed.calls)).toHaveLength(1);
  });
});
