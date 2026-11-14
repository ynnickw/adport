import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { targetingWrite } from '../src/general-targeting-schemas.js';
import { microsoftTools } from '../src/tools.js';
import { campaignSelection, GENERAL_ACCOUNT as account, generalCriterion, generalFixture, groupSelection, type GeneralRow as Row } from './general-targeting-fixture.js';
const guard = { forcePausedCreation: true }, op = (payload: Row): WriteOperation => ({ provider: 'microsoft', accountId: account, tool: 'microsoft_update_targeting', kind: 'update', payload });
const devices = ['Computers', 'Smartphones', 'Tablets'].map((device_name, n) => ({ type: 'Device', device_name, bid_adjustment_percent: n ? -100 : 20 }));
const schedule = { type: 'DayTime', day: 'Tuesday', from_hour: 0, from_minute: 'Zero', to_hour: 24, to_minute: 'Zero', bid_adjustment_percent: 10 };

// Contracts: MicrosoftDocs@5bde65c3 and BingAds REST SDK@4b6fb31c; live account timezone/clock reads2026-11-06.
describe('Microsoft scoped general targeting', () => {
  it('defines one shared scoped write and a records viewer without eager provider work', () => {
    const defs = microsoftTools(new Proxy({} as never, { get() { throw Error('Eager'); } }));expect(defs.find(value => value.name === 'microsoft_targeting_context')).toMatchObject({ presentation: 'records', pagination: { cursorInput: 'cursor' }, catalog: { exposure: 'specialist' } });expect(defs.find(value => value.name === 'microsoft_update_targeting')?.description).toContain('IDENTICAL');
  });
  it('reads concrete selectors, account timezone, native clocks and inherited records with bound paging', async () => {
    const f = generalFixture(), first = await f.provider.generalTargeting.list({ account_id: account, target: groupSelection, page_size: 1 });expect(first).toMatchObject({ account: { TimeZone: 'AmsterdamBerlinBernRomeStockholmVienna' }, inheritance: { Location: { source: 'Campaign', criterion_count: 1 } }, schedule_clock: { source: 'Campaign', use_searcher_time_zone: false, timezone: 'AmsterdamBerlinBernRomeStockholmVienna' }, truncated: true, records: [{ name: 'Location 190', effective: true }] });
    expect(f.calls.find(value => value.path === 'AdGroups/QueryByIds')?.body.ReturnAdditionalFields).toContain('AdScheduleUseSearcherTimeZone');expect(f.calls.filter(value => value.path.endsWith('Criterions/QueryByIds')).every(value => value.body.CriterionType !== 'Targets')).toBe(true);
    const second = await f.provider.generalTargeting.list({ account_id: account, target: groupSelection, page_size: 1, cursor: first.next_cursor });expect(second.records[0]!.criterion_id).toBe('102');f.state.campaign.DailyBudget = 2;await expect(f.provider.generalTargeting.list({ account_id: account, target: groupSelection, page_size: 1, cursor: first.next_cursor })).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.writes()).toEqual([]);
  });
  it('binds continuation to scope, page size and filters', async () => {
    const f = generalFixture(), first = await f.provider.generalTargeting.list({ account_id: account, target: groupSelection, page_size: 1 });for (const input of [{ target: campaignSelection, page_size: 1 }, { target: groupSelection, page_size: 2 }, { target: groupSelection, page_size: 1, criterion_types: ['DayTime' as const] }]) await expect(f.provider.generalTargeting.list({ account_id: account, ...input, cursor: first.next_cursor })).rejects.toThrow(/continuation/);
  });
  it('adds a complete device set using percentage fields and preserves parent configuration and inherited schedules', async () => {
    const f = generalFixture(), before = structuredClone(f.state), args = await f.args({ action: 'add', targets: devices });const preview = await f.provider.previewWrite(op(args), guard);expect(preview.review?.fields).toContainEqual(expect.objectContaining({ label: 'Effective targeting', after: expect.objectContaining({ Device: { source: 'AdGroup', criterion_count: 3 } }) }));expect(f.writes()).toEqual([]);
    const result = await f.provider.applyWrite(op(args), guard);expect(result).toMatchObject({ resourceIds: ['400', '401', '402'], details: { independent_readback_verified: true } });expect(f.writes()).toHaveLength(1);expect(f.writes()[0]).toMatchObject({ path: 'AdGroupCriterions', method: 'POST', headers: { CustomerAccountId: account, CustomerId: '9001' }, body: { CriterionType: 'Targets', AdGroupCriterions: expect.arrayContaining([{ AdGroupId: '8', Type: 'BiddableAdGroupCriterion', Criterion: { Type: 'DeviceCriterion', DeviceName: 'Computers' }, CriterionBid: { Type: 'BidMultiplier', Multiplier: 20 } }]) } });expect(f.state.account).toEqual(before.account);expect(f.state.campaign).toEqual(before.campaign);expect(f.state.group).toEqual(before.group);
  });
  it('allows new native Active targets only under an effectively paused parent', async () => {
    const f = generalFixture();f.state.campaign.Status = 'Active';f.state.group.Status = 'Active';await expect(f.provider.previewWrite(op(await f.args({ action: 'add', targets: [schedule] })), guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });f.state.group.Status = 'Paused';await f.provider.previewWrite(op(await f.args({ action: 'add', targets: [schedule] })), guard);expect(f.writes()).toEqual([]);
  });
  it('shows that one ad-group geo exclusion overrides the entire campaign geo family', async () => {
    const f = generalFixture(), args = await f.args({ action: 'add', targets: [{ type: 'Location', location_id: '999', exclude: true }] });const preview = await f.provider.previewWrite(op(args), guard);expect(preview.review?.fields).toContainEqual(expect.objectContaining({ label: 'Effective targeting', before: expect.objectContaining({ Location: { source: 'Campaign', criterion_count: 1 } }), after: expect.objectContaining({ Location: { source: 'AdGroup', criterion_count: 1 }, LocationIntent: { source: 'AdGroup', criterion_count: 0 }, Radius: { source: 'AdGroup', criterion_count: 0 } }) }));await f.provider.applyWrite(op(args), guard);expect(f.writes()[0]!.body.AdGroupCriterions[0]).not.toHaveProperty('CriterionBid');
  });
  it('treats location intent alone as inert for geo inheritance and omits inapplicable bids', async () => {
    const f = generalFixture();await f.provider.applyWrite(op(await f.args({ action: 'add', targets: [{ type: 'LocationIntent', intent_option: 'PeopleIn' }] })), guard);const read = await f.provider.generalTargeting.list({ account_id: account, target: groupSelection });expect(read.inheritance.Location!.source).toBe('Campaign');expect(read.records.find(value => value.source === 'AdGroup')?.effective).toBe(false);expect(f.writes()[0]!.body.AdGroupCriterions[0]).not.toHaveProperty('CriterionBid');
  });
  it('marks a retained default intent inapplicable when neither level has geographic criteria', async () => {
    const f = generalFixture();f.state.campaignCriteria = f.state.campaignCriteria.filter(value => value.Criterion.Type === 'LocationIntentCriterion');const context = await f.provider.generalTargeting.list({ account_id: account, target: groupSelection });expect(context.records).toHaveLength(1);expect(context.records[0]!.effective).toBe(false);expect(context.inheritance.Location!.criterion_count).toBe(0);
  });
  it('preserves exact schedule intervals and changes a percentage without inventing a monetary delta', async () => {
    const f = generalFixture();await f.provider.applyWrite(op(await f.args({ action: 'add', targets: [schedule] })), guard);const before = structuredClone(f.state.ownCriteria[0]!.Criterion), args = await f.args({ action: 'set_bid', criterion_id: '400', criterion_type: 'DayTime', bid_adjustment_percent: -90 });const preview = await f.provider.previewWrite(op(args), guard);expect(preview.budgetDeltas).toEqual([]);await f.provider.applyWrite(op(args), guard);expect(f.state.ownCriteria[0]!.Criterion).toEqual(before);expect(f.writes()[1]!.body).toEqual({ AdGroupCriterions: [{ AdGroupId: '8', Id: '400', Type: 'BiddableAdGroupCriterion', CriterionBid: { Type: 'BidMultiplier', Multiplier: -90 } }], CriterionType: 'Targets' });
  });
  it('restores campaign inheritance after removing the last own schedule', async () => {
    const f = generalFixture();f.state.ownCriteria.push(generalCriterion('AdGroup', '200', 'DayTime', { Day: 'Tuesday', FromHour: 8, FromMinute: 'Zero', ToHour: 9, ToMinute: 'Zero' }, 0));const preview = await f.provider.previewWrite(op(await f.args({ action: 'remove', criterion_ids: ['200'] })), guard);expect(preview.review?.fields).toContainEqual(expect.objectContaining({ label: 'Effective targeting', after: expect.objectContaining({ DayTime: { source: 'Campaign', criterion_count: 1 } }) }));await f.provider.applyWrite(op(await f.args({ action: 'remove', criterion_ids: ['200'] })), guard);expect(f.writes()[0]!.body).toEqual({ AdGroupId: '8', AdGroupCriterionIds: ['200'], CriterionType: 'Targets' });
  });
  it.each([campaignSelection, groupSelection])('updates only the schedule clock at $type scope and verifies readback', async target => {
    const f = generalFixture(), current = target.type === 'Campaign' ? f.state.campaign : f.state.group, original = structuredClone(current), next = !current.AdScheduleUseSearcherTimeZone;const result = await f.provider.applyWrite(op(await f.args({ action: 'set_schedule_clock', use_searcher_time_zone: next }, target)), guard);expect(result.details).toMatchObject({ independent_readback_verified: true });expect(current).toEqual({ ...original, AdScheduleUseSearcherTimeZone: next });expect(f.writes()[0]!.body).toEqual(target.type === 'Campaign' ? { AccountId: account, Campaigns: [{ Id: '9', AdScheduleUseSearcherTimeZone: next }] } : { CampaignId: '9', AdGroups: [{ Id: '8', AdScheduleUseSearcherTimeZone: next }] });
  });
  it('rejects missing timezone evidence when scheduling by account time', async () => {
    const f = generalFixture();f.state.group.AdScheduleUseSearcherTimeZone = false;delete f.state.account.TimeZone;await expect(f.provider.previewWrite(op(await f.args({ action: 'add', targets: [schedule] })), guard)).rejects.toThrow(/time zone is not verified/);expect(f.writes()).toEqual([]);
  });
  it('prevents inherited-ID edits, incomplete device removal, all-device exclusion and intent deletion', async () => {
    const f = generalFixture();await expect(f.provider.previewWrite(op(await f.args({ action: 'remove', criterion_ids: ['101'] })), guard)).rejects.toThrow(/inherited/);await f.provider.applyWrite(op(await f.args({ action: 'add', targets: devices })), guard);await expect(f.provider.previewWrite(op(await f.args({ action: 'remove', criterion_ids: ['400'] })), guard)).rejects.toThrow(/complete device/);await expect(f.provider.previewWrite(op(await f.args({ action: 'set_bid', criterion_id: '400', criterion_type: 'Device', bid_adjustment_percent: -100 })), guard)).rejects.toThrow(/at least one/);await expect(f.provider.previewWrite(op(await f.args({ action: 'remove', criterion_ids: ['102'] }, campaignSelection)), guard)).rejects.toThrow(/cannot be deleted/);
  });
  it('rejects overlapping schedules and more than seven intervals per day across existing and new records', async () => {
    const f = generalFixture();await f.provider.applyWrite(op(await f.args({ action: 'add', targets: [schedule] })), guard);await expect(f.provider.previewWrite(op(await f.args({ action: 'add', targets: [{ ...schedule, from_hour: 1 }] })), guard)).rejects.toThrow(/overlap/);const other = generalFixture();const targets = Array.from({ length: 8 }, (_, i) => ({ ...schedule, from_hour: i, to_hour: i + 1 }));await expect(other.provider.previewWrite(op(await other.args({ action: 'add', targets })), guard)).rejects.toThrow(/seven per day/);
  });
  it('binds every write to unchanged parent budgets, inheritance and target metadata', async () => {
    for (const field of ['DailyBudget', 'Status', 'Settings']) { const f = generalFixture(), args = await f.args({ action: 'add', targets: [schedule] });f.state.campaign[field] = field === 'DailyBudget' ? 2 : field === 'Status' ? 'Active' : [];await expect(f.provider.previewWrite(op(args), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.writes()).toEqual([]); }
  });
  it('supports campaign scoped changes with exact wire identities and independently preserves other criteria', async () => {
    const f = generalFixture(), before = structuredClone(f.state.campaignCriteria);await f.provider.applyWrite(op(await f.args({ action: 'add', targets: [{ type: 'Gender', gender: 'Female' }] }, campaignSelection)), guard);expect(f.writes()[0]!.body.CampaignCriterions[0]).toMatchObject({ CampaignId: '9', Type: 'BiddableCampaignCriterion', Criterion: { Type: 'GenderCriterion', GenderType: 'Female' } });expect(f.state.campaignCriteria.slice(0, 3)).toEqual(before);
  });
  it('edits exact owned intent without a bid or an unsupported delete', async () => {
    const f = generalFixture();f.state.ownCriteria.push(generalCriterion('AdGroup', '200', 'LocationIntent', { IntentOption: 'PeopleIn' }));await f.provider.applyWrite(op(await f.args({ action: 'set_location_intent', criterion_id: '200', intent_option: 'PeopleInOrSearchingForOrViewingPages' })), guard);expect(f.writes()[0]!.body.AdGroupCriterions[0]).toEqual({ AdGroupId: '8', Id: '200', Type: 'BiddableAdGroupCriterion', Criterion: { Type: 'LocationIntentCriterion', IntentOption: 'PeopleInOrSearchingForOrViewingPages' } });
  });
  it('preserves unrelated unsupported native devices instead of blocking a non-device change', async () => {
    const f = generalFixture();f.state.ownCriteria.push(generalCriterion('AdGroup', '300', 'Device', { DeviceName: 'ConnectedTV' }, 100));await f.provider.applyWrite(op(await f.args({ action: 'add', targets: [{ type: 'Gender', gender: 'Male' }] })), guard);expect(f.state.ownCriteria[0]!.Criterion.DeviceName).toBe('ConnectedTV');
  });
  it('retains acknowledged IDs and never retries on an accepted-but-unconfirmed readback', async () => {
    const f = generalFixture(call => call.path === 'AdGroupCriterions' && call.method === 'POST' ? { AdGroupCriterionIds: ['700'], NestedPartialErrors: [] } : undefined);await expect(f.provider.applyWrite(op(await f.args({ action: 'add', targets: [schedule] })), guard)).rejects.toMatchObject({ details: { resourceIds: ['700'] } });expect(f.writes()).toHaveLength(1);
  });
  it('rejects unsupported fields and incomplete device sets without silently discarding input', async () => {
    const f = generalFixture(), args = await f.args({ action: 'add', targets: devices });expect(targetingWrite.safeParse({ ...args, change: { action: 'add', targets: [{ type: 'Device', device_name: 'Smartphones' }] } }).success).toBe(false);expect(targetingWrite.safeParse({ ...args, change: { action: 'add', targets: [{ ...schedule, unsupported: true }] } }).success).toBe(false);expect(targetingWrite.safeParse({ ...args, acknowledge_delivery_effects: false }).success).toBe(false);
  });
  it('blocks generic target/clock writes from bypassing scoped inheritance checks', async () => {
    const f = generalFixture();for (const [resource, body] of [['AdGroupCriterions', { CriterionType: 'Targets' }], ['CampaignCriterions', { CampaignCriterions: [{ Criterion: { Type: 'DeviceCriterion' } }] }], ['AdGroups', { AdGroups: [{ Id: '8', AdScheduleUseSearcherTimeZone: false }] }]] as const) await expect(f.provider.previewWrite({ ...op({ resource, body }), tool: 'microsoft_api_update' }, guard)).rejects.toThrow(/microsoft_update_targeting/);expect(f.writes()).toEqual([]);
  });
});
