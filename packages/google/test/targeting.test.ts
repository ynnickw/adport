import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, nextPageArguments, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';
import { schedules, targetingUpdate } from '../src/targeting-schemas.js';

// Official v25 googleapis@eecf37ae and current criteria/language guide2026-10-30.
// Initial native GETs on2026-11-06 verified required GAQL leaf fields, exact
// resource identities and omitted device bidModifier (kept unavailable).
type Row = Record<string, any>;
const A = '1234567890', C = '42', ROOT = `customers/${A}`, CAMP = `${ROOT}/campaigns/${C}`, guard = { forcePausedCreation: true };
const criterion = (id: string, type: string, info: Row, negative = false) => ({ resourceName: `${ROOT}/campaignCriteria/${C}~${id}`, campaign: CAMP, criterionId: id, type, status: 'ENABLED', negative, ...info });
const slot = { dayOfWeek: 'MONDAY', startHour: 9, startMinute: 'ZERO', endHour: 17, endMinute: 'ZERO' };
const original = [criterion('201', 'LOCATION', { location: { geoTargetConstant: 'geoTargetConstants/2840' }, bidModifier: 1.1 }), criterion('202', 'LOCATION', { location: { geoTargetConstant: 'geoTargetConstants/2036' } }, true), criterion('203', 'LANGUAGE', { language: { languageConstant: 'languageConstants/1000' } }), criterion('30001', 'DEVICE', { device: { type: 'MOBILE' } }), criterion('301', 'AD_SCHEDULE', { adSchedule: slot, bidModifier: 1.2 }), criterion('401', 'PROXIMITY', {})];
function fixture(options: { type?: string; handler?(url: URL, body: Row): unknown } = {}) {
  const state: Row = { customer: { resourceName: ROOT, id: A, currencyCode: 'EUR', timeZone: 'Europe/Berlin' }, campaign: { resourceName: CAMP, id: C, name: 'Native QA campaign', status: 'ENABLED', advertisingChannelType: options.type ?? 'DISPLAY', advertisingChannelSubType: 'UNSPECIFIED', biddingStrategyType: 'MANUAL_CPC', campaignBudget: `${ROOT}/campaignBudgets/24`, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST', negativeGeoTargetType: 'PRESENCE' } }, budget: { resourceName: `${ROOT}/campaignBudgets/24`, amountMicros: '3000000', period: 'DAILY', explicitlyShared: false }, criteria: structuredClone(original) };
  const calls: Array<{ url: URL; body: Row; init: RequestInit }> = [];let nextId = 900;
  const client = new GoogleAdsRestClient({ clientId: 'inert', clientSecret: 'inert', refreshToken: 'inert', loginCustomerId: '9876543210' }, 'v25', async (raw, init = {}) => {
    const url = new URL(String(raw)), body = url.hostname === 'oauth2.googleapis.com' ? {} : JSON.parse(String(init.body ?? '{}'));calls.push({ url, body, init });
    const custom = options.handler?.(url, body);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'inert', expires_in: 3600 });
    if (url.pathname.endsWith('googleAds:search')) {
      const query = String(body.query);
      if (query.includes(' FROM customer ')) return Response.json({ results: [{ customer: state.customer }] });
      if (query.includes(' FROM campaign ')) return Response.json({ results: [{ campaign: state.campaign, campaignBudget: state.budget }] });
      if (query.includes(' FROM campaign_criterion ')) return Response.json({ results: state.criteria.filter((row: Row) => row.status !== 'REMOVED').map((row: Row) => ({ campaign: { id: C }, campaignCriterion: row })) });
      if (query.includes(' FROM geo_target_constant ') || query.includes(' FROM language_constant ')) {
        const geo = query.includes(' FROM geo_target_constant '), ids = query.match(/\.id IN \(([^)]+)\)/)![1]!.split(',');
        return Response.json({ results: ids.map(id => ({ [geo ? 'geoTargetConstant' : 'languageConstant']: { resourceName: `${geo ? 'geoTargetConstants' : 'languageConstants'}/${id}`, id, name: `Native <name> ${id}`, ...(geo ? { countryCode: 'US', targetType: 'Country', status: 'ENABLED' } : { code: 'en', targetable: true }) } })) });
      }
      throw new Error('Unexpected native query');
    }
    if (!url.pathname.endsWith('googleAds:mutate')) throw new Error('Unexpected native endpoint');
    expect(body.partialFailure).toBe(false);
    if (body.validateOnly) return Response.json({});
    const responses = body.mutateOperations.map((raw: Row) => {
      if (raw.campaignOperation) { const patch = raw.campaignOperation.update;state.campaign.geoTargetTypeSetting = { ...state.campaign.geoTargetTypeSetting, ...patch.geoTargetTypeSetting };return { campaignResult: { resourceName: CAMP } }; }
      const operation = raw.campaignCriterionOperation;
      if (operation.remove) { state.criteria = state.criteria.filter((row: Row) => row.resourceName !== operation.remove);return { campaignCriterionResult: { resourceName: operation.remove } }; }
      if (operation.update) { const row = state.criteria.find((row: Row) => row.resourceName === operation.update.resourceName);for (const field of operation.updateMask.split(',')) row[field === 'bid_modifier' ? 'bidModifier' : field] = field === 'bid_modifier' ? Math.fround(operation.update.bidModifier) : operation.update[field];return { campaignCriterionResult: { resourceName: row.resourceName } }; }
      const value = operation.create, type = value.location ? 'LOCATION' : value.language ? 'LANGUAGE' : 'AD_SCHEDULE', id = String(nextId++), row = criterion(id, type, { ...value });state.criteria.push(row);return { campaignCriterionResult: { resourceName: row.resourceName } };
    });
    return Response.json({ mutateOperationResponses: responses });
  });
  return { state, calls, client, provider: new GoogleAdsProvider(client) };
}
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.url.pathname.endsWith('googleAds:mutate'));
async function operation(f: ReturnType<typeof fixture>, fields: Row): Promise<WriteOperation> { const current = await f.provider.targeting.list({ account_id: A, campaign_id: C });return { provider: 'google', accountId: A, kind: 'update', tool: 'google_update_targeting', payload: { campaign_id: C, expected_snapshot_hash: current.snapshot_hash, acknowledge_delivery_effects: true, ...fields } }; }
const weekly = { day: 'MONDAY', start_hour: 9, start_minute: 0, end_hour: 17, end_minute: 0 };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('targeting payload and native temporal/ratio units', () => {
  it.each([
    {}, { locations: {} }, { locations: { include: {} } }, { locations: { include: { add_ids: ['2840', '2840'] } } }, { languages: { add_ids: ['1000'], remove_ids: ['1000'] } },
    { device_bid_modifiers: [{ device: 'MOBILE', bid_modifier: 0.01 }] }, { device_bid_modifiers: [{ device: 'MOBILE', bid_modifier: 11 }] }, { device_bid_modifiers: [{ device: 'MOBILE', bid_modifier: 0 }, { device: 'MOBILE', bid_modifier: 1 }] },
    { criterion_statuses: [{ criterion_id: '203', status: 'REMOVED' }] }, { positive_geo_target_type: 'UNKNOWN' }, { locations: { include: { add_ids: ['2840 OR 1=1'] } } },
  ])('rejects ambiguous, unbounded or native-incompatible input: %j', fields => { expect(targetingUpdate.safeParse({ campaign_id: C, expected_snapshot_hash: 'a'.repeat(64), acknowledge_delivery_effects: true, ...fields }).success).toBe(false); });
  it('requires source hash and delivery acknowledgement, with explicit device zero and weekly clear', () => {
    const base = { campaign_id: C, expected_snapshot_hash: 'a'.repeat(64), acknowledge_delivery_effects: true };
    expect(targetingUpdate.safeParse({ ...base, device_bid_modifiers: [{ device: 'MOBILE', bid_modifier: 0 }] }).success).toBe(true);expect(targetingUpdate.safeParse({ ...base, ad_schedules: [] }).success).toBe(true);
    expect(targetingUpdate.safeParse({ ...base, acknowledge_delivery_effects: false, ad_schedules: [] }).success).toBe(false);
  });
  it.each([
    [{ ...weekly, end_hour: 24, end_minute: 15 }], [{ ...weekly, start_minute: 5 }], [{ ...weekly, start_hour: 22, end_hour: 2 }], [weekly, { ...weekly, start_hour: 16, end_hour: 18 }],
    Array.from({ length: 7 }, (_, i) => ({ ...weekly, start_hour: i * 2, end_hour: i * 2 + 1 })),
  ])('rejects invalid native schedule intervals: %j', values => { expect(schedules.safeParse(values).success).toBe(false); });
});

describe('campaign targeting reads and stable native scope', () => {
  it('preserves omitted native device bids and paginates a complete configuration snapshot', async () => {
    const f = fixture(), first = await f.provider.targeting.list({ account_id: A, campaign_id: C, page_size: 1 });
    expect(first).toMatchObject({ total_criteria: 6, truncated: true, snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/), records: [{ id: '201', name: 'Native <name> 2840', kind: 'LOCATION', scope: 'Targeted' }] });
    const second = await f.provider.targeting.list({ account_id: A, campaign_id: C, page_size: 1, cursor: first.next_cursor });expect(second.criteria[0]!.criterionId).toBe('202');
    const all = await f.provider.targeting.list({ account_id: A, campaign_id: C });expect(all.records.find(row => row.id === '30001')).toMatchObject({ bid_multiplier: 'Not reported' });expect(all.criteria.find(row => row.criterionId === '30001')).not.toHaveProperty('bidModifier');
    expect(nextPageArguments(googleTools(f.provider).find(tool => tool.name === 'google_campaign_targeting')!, { account_id: A, campaign_id: C, page_size: 1 }, first)).toEqual({ account_id: A, campaign_id: C, page_size: 1, cursor: first.next_cursor });
    const query = f.calls.find(call => call.body.query?.includes(' FROM campaign_criterion '))!.body.query;expect(query).toContain('LIMIT 20001');expect(query).toContain("campaign_criterion.status != 'REMOVED'");expect(query).toContain('include_drafts=true');expect(mutations(f)).toEqual([]);
  });
  it('rejects continuation after source, account, page-size or parent changes', async () => {
    const f = fixture(), first = await f.provider.targeting.list({ account_id: A, campaign_id: C, page_size: 1 });
    for (const input of [{ page_size: 2 }, { campaign_id: '43' }]) await expect(f.provider.targeting.list({ account_id: A, campaign_id: C, page_size: 1, cursor: first.next_cursor, ...input })).rejects.toThrow();
    f.state.campaign.status = 'PAUSED';await expect(f.provider.targeting.list({ account_id: A, campaign_id: C, page_size: 1, cursor: first.next_cursor })).rejects.toThrow(/continuation/);
  });
  it.each(['foreign', 'duplicate', 'wrong-type', 'wrong-resource', 'missing-device', 'missing-status', 'negative-language'] as const)('rejects unverifiable criterion rows: %s', async mode => {
    const f = fixture();const row = f.state.criteria[0];if (mode === 'foreign') row.campaign = 'customers/9999999999/campaigns/42';if (mode === 'duplicate') f.state.criteria.push(structuredClone(row));if (mode === 'wrong-type') row.device = { type: 'MOBILE' };if (mode === 'wrong-resource') row.resourceName = `${ROOT}/campaignCriteria/99~201`;if (mode === 'missing-device') delete f.state.criteria.find((value: Row) => value.type === 'DEVICE').device;if (mode === 'missing-status') delete row.status;if (mode === 'negative-language') f.state.criteria.find((value: Row) => value.type === 'LANGUAGE').negative = true;
    await expect(f.provider.targeting.list({ account_id: A, campaign_id: C })).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it('fails complete-context reads at the bound and stops repeated empty native page cursors', async () => {
    const bounded = fixture({ handler: (_url, body) => body.query?.includes(' FROM campaign_criterion ') ? { results: Array(20_001).fill({}) } : undefined });await expect(bounded.provider.targeting.list({ account_id: A, campaign_id: C })).rejects.toThrow(/bound/);
    const looping = fixture({ handler: (_url, body) => body.query?.includes(' FROM campaign_criterion ') ? { results: [], nextPageToken: 'repeat' } : undefined });await expect(looping.provider.targeting.list({ account_id: A, campaign_id: C })).rejects.toThrow(/pagination/);expect(looping.calls.filter(call => call.body.query?.includes(' FROM campaign_criterion '))).toHaveLength(2);
  });
  it.each([{ results: '' }, { results: [] , nextPageToken: 0 }])('does not certify empty targeting from an invalid native envelope: %j', response => {
    const f = fixture({ handler: (_url, body) => body.query?.includes(' FROM campaign_criterion ') ? response : undefined });return expect(f.provider.targeting.list({ account_id: A, campaign_id: C })).rejects.toThrow(/envelope/);
  });
  it('keeps criteria when optional name hydration fails and labels legacy Search language state', async () => {
    const f = fixture({ type: 'SEARCH', handler: (_url, body) => body.query?.includes(' FROM geo_target_constant ') ? new Response('{}', { status: 403 }) : undefined });const result = await f.provider.targeting.list({ account_id: A, campaign_id: C });expect(result.warnings[0]).toContain('names were not resolved');expect(result.records.find(row => row.kind === 'LANGUAGE')).toMatchObject({ serving: 'Legacy · not used by Search' });expect(result.criteria).toHaveLength(6);
  });
});

describe('typed native targeting edits and independent readback', () => {
  it('atomically changes only selected location IDs and geo intent, preserving exclusions, other dimensions, status and budgets', async () => {
    const f = fixture(), op = await operation(f, { locations: { include: { add_ids: ['2826'], remove_ids: ['2840'] } }, positive_geo_target_type: 'PRESENCE' }), originalBudget = structuredClone(f.state.budget);
    const preview = await f.provider.previewWrite(op, guard);expect(preview).toMatchObject({ serverValidated: true, review: { title: 'Update campaign targeting', fields: expect.arrayContaining([{ label: 'Location inclusion intent', before: 'PRESENCE_OR_INTEREST', after: 'PRESENCE' }]) } });expect(mutations(f)).toHaveLength(1);expect(mutations(f)[0]!.body).toMatchObject({ validateOnly: true, partialFailure: false });expect(f.state.criteria).toEqual(original);
    const result = await f.provider.applyWrite(op, guard), body = mutations(f)[1]!.body;expect(body.mutateOperations).toEqual([{ campaignCriterionOperation: { remove: `${ROOT}/campaignCriteria/42~201` } }, { campaignCriterionOperation: { create: { campaign: CAMP, status: 'ENABLED', negative: false, location: { geoTargetConstant: 'geoTargetConstants/2826' } } } }, { campaignOperation: { update: { resourceName: CAMP, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' } }, updateMask: 'geo_target_type_setting.positive_geo_target_type' } }]);
    expect(result).toMatchObject({ applied: true, details: { independent_scoped_readback_verified: true, other_criterion_types_submitted: false } });expect(f.state.criteria.filter((row: Row) => row.criterionId !== '900')).toEqual(original.filter(row => row.criterionId !== '201'));expect(f.state.campaign.status).toBe('ENABLED');expect(f.state.campaign.geoTargetTypeSetting.negativeGeoTargetType).toBe('PRESENCE');expect(f.state.budget).toEqual(originalBudget);
    expect(mutations(f)[1]!.init.headers).toMatchObject({ 'login-customer-id': '9876543210' });expect(mutations(f)).toHaveLength(2);
  });
  it('replaces immutable schedules, preserves matching interval modifiers and exposes all-day clearing', async () => {
    const f = fixture(), update = await operation(f, { ad_schedules: [weekly, { ...weekly, day: 'TUESDAY', start_hour: 0, end_hour: 24, bid_modifier: 0.7 }] });
    await f.provider.applyWrite(update, guard);const ops = mutations(f)[0]!.body.mutateOperations;expect(ops).toHaveLength(1);expect(ops[0]).toMatchObject({ campaignCriterionOperation: { create: { adSchedule: { dayOfWeek: 'TUESDAY', startHour: 0, startMinute: 'ZERO', endHour: 24, endMinute: 'ZERO' }, bidModifier: 0.7 } } });expect(f.state.criteria.find((row: Row) => row.criterionId === '301').bidModifier).toBe(1.2);
    const clear = await operation(f, { ad_schedules: [] }), preview = await f.provider.previewWrite(clear, guard);expect(JSON.stringify(preview.review)).toContain('No ad-schedule time restriction');await f.provider.applyWrite(clear, guard);expect(f.state.criteria.some((row: Row) => row.type === 'AD_SCHEDULE')).toBe(false);
  });
  it('uses an exact bid-only mask, handles native float32 and treats device zero as exclusion rather than deletion', async () => {
    const f = fixture(), op = await operation(f, { device_bid_modifiers: [{ device: 'MOBILE', bid_modifier: 0.7 }] });
    await f.provider.applyWrite(op, guard);expect(mutations(f)[0]!.body.mutateOperations).toEqual([{ campaignCriterionOperation: { update: { resourceName: `${ROOT}/campaignCriteria/42~30001`, device: { type: 'MOBILE' }, bidModifier: 0.7 }, updateMask: 'bid_modifier' } }]);expect(f.state.criteria.find((row: Row) => row.criterionId === '30001').bidModifier).toBe(Math.fround(0.7));
    await f.provider.applyWrite(await operation(f, { device_bid_modifiers: [{ device: 'MOBILE', bid_modifier: 0 }] }), guard);expect(f.state.criteria.find((row: Row) => row.criterionId === '30001')).toMatchObject({ status: 'ENABLED', bidModifier: 0 });expect(f.state.criteria).toHaveLength(6);
  });
  it('supports eligible language deltas but rejects new Search languages and allows legacy cleanup only', async () => {
    const display = fixture();await display.provider.applyWrite(await operation(display, { languages: { add_ids: ['1001'], remove_ids: ['1000'] } }), guard);expect(display.state.criteria.filter((row: Row) => row.type === 'LANGUAGE')).toMatchObject([{ language: { languageConstant: 'languageConstants/1001' } }]);
    const search = fixture({ type: 'SEARCH' });await expect(search.provider.previewWrite(await operation(search, { languages: { add_ids: ['1001'] } }), guard)).rejects.toThrow(/Search manual language/);expect(mutations(search)).toEqual([]);
    const preview = await search.provider.previewWrite(await operation(search, { languages: { remove_ids: ['1000'] } }), guard);expect(preview.notes).toContain('Search legacy language criteria are not used in serving; removal is cleanup, not a new language restriction.');expect(mutations(search)[0]!.body.mutateOperations).toEqual([{ campaignCriterionOperation: { remove: `${ROOT}/campaignCriteria/42~203` } }]);
  });
  it.each(['stale', 'already-added', 'unknown-remove', 'same-location', 'device', 'removed-status', 'empty-change'] as const)('rejects unsafe or absent changes before native mutation: %s', async mode => {
    const f = fixture(), fields: Row = mode === 'already-added' ? { locations: { include: { add_ids: ['2840'] } } } : mode === 'unknown-remove' ? { locations: { include: { remove_ids: ['999'] } } } : mode === 'same-location' ? { locations: { exclude: { add_ids: ['2840'] } } } : mode === 'device' ? { device_bid_modifiers: [{ device: 'DESKTOP', bid_modifier: 0 }] } : mode === 'removed-status' ? { locations: { include: { remove_ids: ['2840'] } }, criterion_statuses: [{ criterion_id: '201', status: 'PAUSED' }] } : { positive_geo_target_type: mode === 'empty-change' ? 'PRESENCE_OR_INTEREST' : 'PRESENCE' };
    const op = await operation(f, fields);if (mode === 'stale') f.state.budget.amountMicros = '4000000';await expect(f.provider.previewWrite(op, guard)).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it.each(['missing', 'foreign', 'disabled', 'duplicate'] as const)('validates added constant identity and availability: %s', async mode => {
    const f = fixture({ handler: (_url, body) => body.query?.includes(' FROM geo_target_constant ') && body.query.includes('(2826)') ? { results: mode === 'missing' ? [] : Array.from({ length: mode === 'duplicate' ? 2 : 1 }, () => ({ geoTargetConstant: { id: '2826', resourceName: mode === 'foreign' ? 'languageConstants/2826' : 'geoTargetConstants/2826', status: mode === 'disabled' ? 'REMOVAL_PLANNED' : 'ENABLED' } })) } : undefined });
    await expect(f.provider.previewWrite(await operation(f, { locations: { include: { add_ids: ['2826'] } } }), guard)).rejects.toThrow();expect(mutations(f)).toEqual([]);
  });
  it.each(['receipt-count', 'receipt-type', 'receipt-foreign', 'partial-failure', 'budget', 'status', 'unmentioned', 'removed-remains', 'created-wrong', 'transport'] as const)('retains acknowledged IDs and never replays unconfirmed writes: %s', async mode => {
    let applied = false;const f = fixture({ handler: (url, body) => {
      if (url.pathname.endsWith('googleAds:mutate')) {
        applied = true;if (mode === 'transport') throw new Error('unknown');
        if (mode.startsWith('receipt') || mode === 'partial-failure') return mode === 'receipt-count' ? { mutateOperationResponses: [] } : mode === 'receipt-type' ? { mutateOperationResponses: [{ campaignResult: { resourceName: CAMP } }, { campaignResult: { resourceName: CAMP } }] } : mode === 'receipt-foreign' ? { mutateOperationResponses: [{ campaignCriterionResult: { resourceName: `${ROOT}/campaignCriteria/42~201` } }, { campaignCriterionResult: { resourceName: 'customers/9999999999/campaignCriteria/42~900' } }] } : { mutateOperationResponses: [], partialFailureError: { code: 1 } };
      }
      if (applied && body.query?.includes(' FROM campaign ')) { if (mode === 'budget') f.state.budget.amountMicros = '4000000';if (mode === 'status') f.state.campaign.status = 'PAUSED'; }
      if (applied && body.query?.includes(' FROM campaign_criterion ')) { if (mode === 'unmentioned') f.state.criteria.find((row: Row) => row.type === 'DEVICE').bidModifier = 10;if (mode === 'removed-remains') f.state.criteria.push(structuredClone(original[0]));if (mode === 'created-wrong') f.state.criteria.find((row: Row) => row.criterionId === '900').location.geoTargetConstant = 'geoTargetConstants/999'; }
      return undefined;
    } });
    const op = await operation(f, { locations: { include: { add_ids: ['2826'], remove_ids: ['2840'] } } });await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resourceIds: expect.arrayContaining([`${ROOT}/campaignCriteria/42~201`]) } });expect(mutations(f)).toHaveLength(1);
  });
  it('refuses current Search creation language arguments before any native call while retaining eligible Display fields', async () => {
    const f = fixture();await expect(f.provider.previewWrite({ provider: 'google', accountId: A, kind: 'create', tool: 'google_create_campaign', payload: { name: 'Search', daily_budget_micros: 1000000, language_ids: ['1000'] } }, guard)).rejects.toThrow(/Search no longer supports/);expect(f.calls).toEqual([]);
    await f.provider.previewWrite({ provider: 'google', accountId: A, kind: 'create', tool: 'google_create_campaign', payload: { name: 'Display', channel_type: 'DISPLAY', daily_budget_micros: 1000000, language_ids: ['1000'] } }, guard);expect(mutations(f)[0]!.body.mutateOperations.some((value: Row) => value.campaignCriterionOperation?.create?.language?.languageConstant === 'languageConstants/1000')).toBe(true);
  });
});

describe('shared typed targeting policy gate', () => {
  it('requires exact approval arguments, repeats native validation at apply, rechecks snapshots and protects accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'google-targeting-'));dirs.push(dir);const f = fixture(), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), runtime = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] }), payload = (await operation(f, { device_bid_modifiers: [{ device: 'MOBILE', bid_modifier: 0.7 }] })).payload, args = { ...payload, account_id: A };
    const preview = await runtime.registry.call('google_update_targeting', args, runtime.ctx) as any;expect(mutations(f)).toHaveLength(1);expect(mutations(f)[0]!.body.validateOnly).toBe(true);
    await expect(runtime.registry.call('google_update_targeting', { ...args, device_bid_modifiers: [{ device: 'MOBILE', bid_modifier: 2 }], pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(mutations(f)).toHaveLength(1);
    await runtime.registry.call('google_update_targeting', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);expect(mutations(f)).toHaveLength(3);expect(mutations(f).map(call => call.body.validateOnly)).toEqual([true, true, false]);await expect(runtime.registry.call('google_update_targeting', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(mutations(f)).toHaveLength(3);
    const current = { account_id: A, ...(await operation(f, { positive_geo_target_type: 'PRESENCE' })).payload }, next = await runtime.registry.call('google_update_targeting', current, runtime.ctx) as any;f.state.campaign.status = 'PAUSED';await expect(runtime.registry.call('google_update_targeting', { ...current, pending_operation_id: next.pending_operation_id }, runtime.ctx)).rejects.toThrow(/changed/);expect(mutations(f)).toHaveLength(4);
    const protectedRuntime = await createContext({ engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(join(dir, 'protected')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });await expect(protectedRuntime.registry.call('google_update_targeting', current, protectedRuntime.ctx)).rejects.toThrow(/protected/);expect(mutations(f)).toHaveLength(4);
  });
  it('consumes the approval after an uncertain native apply and prevents replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'google-targeting-unknown-'));dirs.push(dir);const f = fixture({ handler: (url, body) => { if (url.pathname.endsWith('googleAds:mutate') && body.validateOnly === false) throw new Error('Unknown native outcome');return undefined; } }), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] }), args = { account_id: A, ...(await operation(f, { positive_geo_target_type: 'PRESENCE' })).payload }, preview = await runtime.registry.call('google_update_targeting', args, runtime.ctx) as any;
    const request = { ...args, pending_operation_id: preview.pending_operation_id };await expect(runtime.registry.call('google_update_targeting', request, runtime.ctx)).rejects.toMatchObject({ details: { approval_consumed: true, apply_state: 'UNCONFIRMED' } });expect(mutations(f).map(call => call.body.validateOnly)).toEqual([true, true, false]);await expect(runtime.registry.call('google_update_targeting', request, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(mutations(f)).toHaveLength(3);
  });
});
