import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// REST JSON requests and subtype restrictions: MicrosoftDocs/Advertising@fdee2fcf.
type Row = Record<string, unknown>;
const account = '777', guard = { forcePausedCreation: true };
function fixture(override?: (path: string, body: Row, method: string) => unknown) {
  const calls: Array<{ path: string; body: Row; init: RequestInit }> = [];
  const state = { status: 'Paused', criteria: [{ Id: '42', CampaignId: '9', Type: 'BiddableCampaignCriterion', Status: 'Active', Criterion: { Type: 'DayTimeCriterion', Day: 'Monday', FromHour: 9, FromMinute: 'Zero', ToHour: 17, ToMinute: 'Zero' }, CriterionBid: { Type: 'BidMultiplier', Multiplier: 0 } }] as Row[] };
  const client = new MicrosoftAdsClient({ developerToken: 'dev', clientId: 'client', refreshToken: 'refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    const path = url.pathname.replace(/^.*\/v13\//, ''), body = JSON.parse(String(init.body ?? '{}')) as Row, method = init.method ?? 'POST';
    calls.push({ path, body, init });
    const custom = override?.(path, body, method);
    if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001' }] });
    if (path === 'Campaigns/QueryByAccountId') return Response.json({ Campaigns: [{ Id: '9', Name: 'Owned QA parent', Status: state.status }] });
    if (path === 'CampaignCriterions/QueryByIds') return Response.json({ CampaignCriterions: state.criteria.filter(value => (value.Criterion as Row).Type === `${body.CriterionType}Criterion`), PartialErrors: [] });
    if (path === 'GeoLocationsFileUrl/Query') return Response.json({ FileUrl: 'https://download.example.invalid/locations', FileUrlExpiryTimeUtc: '2026-11-03T00:15:00Z', LastModifiedTimeUtc: '2026-11-02T00:00:00Z' });
    if (path === 'CampaignCriterions' && method === 'POST') {
      const items = (body.CampaignCriterions as Row[]).map((value, index) => ({ ...value, Id: String(43 + index), Status: 'Active' }));
      state.criteria.push(...items);
      return Response.json({ CampaignCriterionIds: items.map(value => value.Id), NestedPartialErrors: [] });
    }
    if (path === 'CampaignCriterions' && method === 'PUT') {
      for (const value of body.CampaignCriterions as Row[]) state.criteria = state.criteria.map(current => current.Id === value.Id ? { ...current, ...value } : current);
      return Response.json({ NestedPartialErrors: [] });
    }
    if (path === 'CampaignCriterions' && method === 'DELETE') { state.criteria = state.criteria.filter(value => !(body.CampaignCriterionIds as string[]).includes(String(value.Id))); return Response.json({ PartialErrors: [] }); }
    throw new Error(`Unexpected path ${path}`);
  });
  return { provider: new MicrosoftAdsProvider(client), calls, state };
}
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'microsoft', accountId: account, payload, kind });
const ref = { campaign_id: '9', criterion_id: '42', criterion_type: 'DayTime' };
const devices = ['Computers', 'Smartphones', 'Tablets'].map((device_name, index) => ({ type: 'Device', device_name, bid_adjustment_percent: [20, -100, 0][index] }));

describe('Microsoft campaign targeting', () => {
  it('uses one lazy tool definition with strict native constraints', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager access'); } })), add = tools.find(value => value.name === 'microsoft_add_campaign_targets')!.input;
    expect(add.safeParse({ account_id: account, campaign_id: '9', targets: devices }).success).toBe(true);
    expect(add.safeParse({ account_id: account, campaign_id: '9', targets: devices.slice(0, 1) }).success).toBe(false);
    expect(add.safeParse({ account_id: account, campaign_id: '9', targets: devices.map(value => ({ ...value, bid_adjustment_percent: -100 })) }).success).toBe(false);
    expect(tools.find(value => value.name === 'microsoft_campaign_targets')!.input.safeParse({ account_id: account, campaign_id: '9', criterion_type: 'Targets' }).success).toBe(false);
    expect(tools.find(value => value.name === 'microsoft_remove_campaign_targets')!.input.safeParse({ account_id: account, campaign_id: '9', criterion_type: 'LocationIntent', criterion_ids: ['9'] }).success).toBe(false);
  });

  it('queries one concrete subtype after verifying campaign ownership and rejects foreign native rows', async () => {
    const f = fixture(); expect(await f.provider.targeting.list({ account_id: account, campaign_id: '9', criterion_type: 'DayTime' })).toMatchObject({ rows: [{ Id: '42' }], truncated: false });
    expect(f.calls.at(-1)!.body).toEqual({ CampaignId: '9', CampaignCriterionIds: null, CriterionType: 'DayTime' });
    const foreign = fixture(path => path === 'CampaignCriterions/QueryByIds' ? { CampaignCriterions: [{ Id: '42', CampaignId: '99', Type: 'BiddableCampaignCriterion', Criterion: { Type: 'DayTimeCriterion' } }] } : undefined);
    await expect(foreign.provider.targeting.list({ account_id: account, campaign_id: '9', criterion_type: 'DayTime' })).rejects.toThrow('identity mismatch');
    await expect(f.provider.targeting.list({ account_id: account, campaign_id: '99', criterion_type: 'Age' })).rejects.toThrow('not found');
  });

  it('adds all three devices using percentage values and the Targets mutation selector, without changing parent status', async () => {
    const f = fixture(), operation = op('microsoft_add_campaign_targets', { campaign_id: '9', targets: devices }, 'create');
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [] });
    expect(f.calls.some(value => value.path === 'CampaignCriterions')).toBe(false);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['43', '44', '45'] });
    expect(f.calls.find(value => value.path === 'CampaignCriterions')!.body).toEqual({ CriterionType: 'Targets', CampaignCriterions: devices.map(value => ({ CampaignId: '9', Type: 'BiddableCampaignCriterion', Criterion: { Type: 'DeviceCriterion', DeviceName: value.device_name }, CriterionBid: { Type: 'BidMultiplier', Multiplier: value.bid_adjustment_percent } })) });
    expect(f.calls.some(value => value.path === 'Campaigns')).toBe(false);
  });

  it('blocks native Active-only target creation on an active campaign under paused_creation', async () => {
    const f = fixture(); f.state.status = 'Active';
    await expect(f.provider.previewWrite(op('microsoft_add_campaign_targets', { campaign_id: '9', targets: [{ type: 'Age', age_range: 'EighteenToTwentyFour' }] }, 'create'), guard)).rejects.toThrow('cannot be paused');
    expect(f.calls.some(value => value.path === 'CampaignCriterions')).toBe(false);
  });

  it('does not silently replace an existing target or create duplicate identities within one request', async () => {
    const f = fixture(), existing = { type: 'DayTime', day: 'Monday', from_hour: 9, from_minute: 'Zero', to_hour: 17, to_minute: 'Zero' };
    await expect(f.provider.previewWrite(op('microsoft_add_campaign_targets', { campaign_id: '9', targets: [existing] }, 'create'), guard)).rejects.toThrow('already exists');
    const duplicate = { type: 'Gender', gender: 'Female' };
    await expect(f.provider.previewWrite(op('microsoft_add_campaign_targets', { campaign_id: '9', targets: [duplicate, duplicate] }, 'create'), guard)).rejects.toThrow('already exists');
    expect(f.calls.some(value => value.path === 'CampaignCriterions')).toBe(false);
  });

  it('serializes negative locations without an inapplicable bid or invented status', async () => {
    const f = fixture();
    await f.provider.applyWrite(op('microsoft_add_campaign_targets', { campaign_id: '9', targets: [{ type: 'Location', location_id: '190', exclude: true }] }, 'create'), guard);
    expect((f.calls.find(value => value.path === 'CampaignCriterions')!.body.CampaignCriterions as Row[])[0]).toEqual({ CampaignId: '9', Type: 'NegativeCampaignCriterion', Criterion: { Type: 'LocationCriterion', LocationId: '190' } });
    await expect(f.provider.previewWrite(op('microsoft_add_campaign_targets', { campaign_id: '9', targets: [{ type: 'Location', location_id: '190', exclude: true, bid_adjustment_percent: 0 }] }, 'create'), guard)).rejects.toThrow('cannot have a bid');
  });

  it('omits bids for location intent and keeps native radius and schedule units', async () => {
    const f = fixture();
    await f.provider.applyWrite(op('microsoft_add_campaign_targets', { campaign_id: '9', targets: [{ type: 'LocationIntent', intent_option: 'PeopleIn' }, { type: 'Radius', latitude: 48.1, longitude: 11.5, radius: 20, radius_unit: 'Kilometers' }, { type: 'DayTime', day: 'Friday', from_hour: 18, from_minute: 'Fifteen', to_hour: 24, to_minute: 'Zero', bid_adjustment_percent: -10 }] }, 'create'), guard);
    const sent = f.calls.find(value => value.path === 'CampaignCriterions')!.body.CampaignCriterions as Row[];
    expect(sent[0]).not.toHaveProperty('CriterionBid');
    expect(sent[1]!.Criterion).toMatchObject({ Type: 'RadiusCriterion', Radius: '20', RadiusUnit: 'Kilometers', LatitudeDegrees: 48.1 });
    expect(sent[2]!.Criterion).toMatchObject({ Type: 'DayTimeCriterion', FromMinute: 'Fifteen', ToHour: 24, ToMinute: 'Zero' });
    await expect(f.provider.previewWrite(op('microsoft_add_campaign_targets', { campaign_id: '9', targets: [{ type: 'Radius', latitude: 0, longitude: 0, radius: 501, radius_unit: 'Miles' }] }, 'create'), guard)).rejects.toThrow('cannot exceed');
    await expect(f.provider.previewWrite(op('microsoft_add_campaign_targets', { campaign_id: '9', targets: [{ type: 'DayTime', day: 'Monday', from_hour: 20, from_minute: 'Zero', to_hour: 24, to_minute: 'Fifteen' }] }, 'create'), guard)).rejects.toThrow('must end after');
  });

  it('updates only the bid percentage and binds the expected native current value', async () => {
    const f = fixture(), operation = op('microsoft_set_campaign_target_bid', { ...ref, bid_adjustment_percent: 20, expected_current_percent: 0 });
    await expect(f.provider.previewWrite(op(operation.tool, { ...operation.payload, expected_current_percent: 1 }), guard)).rejects.toThrow('bid changed');
    await f.provider.applyWrite(operation, guard);
    expect(f.calls.find(value => value.init.method === 'PUT')!.body).toEqual({ CriterionType: 'Targets', CampaignCriterions: [{ CampaignId: '9', Id: '42', Type: 'BiddableCampaignCriterion', CriterionBid: { Type: 'BidMultiplier', Multiplier: 20 } }] });
    expect(f.state.criteria[0]!.Criterion).toMatchObject({ Day: 'Monday', FromHour: 9 });
    await expect(f.provider.previewWrite(op(operation.tool, { ...operation.payload, bid_adjustment_percent: -100, expected_current_percent: 20 }), guard)).rejects.toThrow('Only devices');
  });

  it('refuses HTTP-success no-op updates and preserves the resource ID without retrying', async () => {
    const f = fixture((path, _body, method) => path === 'CampaignCriterions' && method === 'PUT' ? { NestedPartialErrors: [] } : undefined);
    await expect(f.provider.applyWrite(op('microsoft_set_campaign_target_bid', { ...ref, bid_adjustment_percent: 20, expected_current_percent: 0 }), guard)).rejects.toMatchObject({ details: { resourceIds: ['42'] } });
    expect(f.calls.filter(value => value.init.method === 'PUT')).toHaveLength(1);
  });

  it('updates location intent without sending a bid or modifying immutable target attributes', async () => {
    const f = fixture(); f.state.criteria = [{ Id: '42', CampaignId: '9', Type: 'BiddableCampaignCriterion', Status: 'Active', Criterion: { Type: 'LocationIntentCriterion', IntentOption: 'PeopleIn' } }];
    await f.provider.applyWrite(op('microsoft_set_campaign_location_intent', { campaign_id: '9', criterion_id: '42', expected_current_intent: 'PeopleIn', intent_option: 'PeopleInOrSearchingForOrViewingPages' }), guard);
    expect((f.calls.find(value => value.init.method === 'PUT')!.body.CampaignCriterions as Row[])[0]).toEqual({ CampaignId: '9', Id: '42', Type: 'BiddableCampaignCriterion', Criterion: { Type: 'LocationIntentCriterion', IntentOption: 'PeopleInOrSearchingForOrViewingPages' } });
  });

  it('handles nested partial creation failures and retains successful IDs for reconciliation', async () => {
    const f = fixture(path => path === 'CampaignCriterions' ? { CampaignCriterionIds: ['43', null], NestedPartialErrors: [{ Index: 1, BatchErrors: [{ Code: 123 }] }] } : undefined);
    await expect(f.provider.applyWrite(op('microsoft_add_campaign_targets', { campaign_id: '9', targets: [{ type: 'Gender', gender: 'Female' }, { type: 'Gender', gender: 'Male' }] }, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['43'] } });
    expect(f.calls.filter(value => value.path === 'CampaignCriterions')).toHaveLength(1);
  });

  it('deletes one owned criterion with native Targets, then confirms using its concrete read subtype', async () => {
    const f = fixture();
    expect(await f.provider.applyWrite(op('microsoft_remove_campaign_targets', { campaign_id: '9', criterion_type: 'DayTime', criterion_ids: ['42'] }, 'remove'), guard)).toEqual({ applied: true, resourceIds: ['42'] });
    expect(f.calls.find(value => value.init.method === 'DELETE')!.body).toEqual({ CampaignId: '9', CampaignCriterionIds: ['42'], CriterionType: 'Targets' });
    expect(f.calls.at(-1)!.body.CriterionType).toBe('DayTime');
  });

  it('requires the complete native device set before deletion (live native code2957)', async () => {
    const f = fixture(); f.state.criteria = devices.map((value, index) => ({ Id: String(43 + index), CampaignId: '9', Type: 'BiddableCampaignCriterion', Status: 'Active', Criterion: { Type: 'DeviceCriterion', DeviceName: value.device_name }, CriterionBid: { Type: 'BidMultiplier', Multiplier: value.bid_adjustment_percent } }));
    await expect(f.provider.previewWrite(op('microsoft_remove_campaign_targets', { campaign_id: '9', criterion_type: 'Device', criterion_ids: ['43'] }, 'remove'), guard)).rejects.toThrow('all three device');
    expect(f.calls.some(value => value.init.method === 'DELETE')).toBe(false);
    expect(await f.provider.applyWrite(op('microsoft_remove_campaign_targets', { campaign_id: '9', criterion_type: 'Device', criterion_ids: ['43', '44', '45'] }, 'remove'), guard)).toEqual({ applied: true, resourceIds: ['43', '44', '45'] });
    expect(f.calls.find(value => value.init.method === 'DELETE')!.body).toEqual({ CampaignId: '9', CriterionType: 'Targets', CampaignCriterionIds: ['43', '44', '45'] });
  });

  it('returns native geo-file version2 metadata without downloading an external URL', async () => {
    const f = fixture(); expect(await f.provider.targeting.geoFile({ account_id: account, language_locale: 'de' })).toMatchObject({ FileUrlExpiryTimeUtc: '2026-11-03T00:15:00Z' });
    expect(f.calls.at(-1)!.body).toEqual({ Version: '2.0', LanguageLocale: 'de' });
    expect(f.calls).toHaveLength(3);
  });
});
