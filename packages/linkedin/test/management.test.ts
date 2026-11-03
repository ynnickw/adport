import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { LinkedInAdsClient } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';

// Reviewed against LinkedIn-owned Marketing202608 campaign/group, targeting
// entity and Rest.li docs, fetched2026-11-03. These are wire-contract fixtures.
const A = '518121035', C = '145282384', G = '635137195', AU = `urn:li:sponsoredAccount:${A}`;
const targeting = { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:101282230'] } }] }, exclude: { or: { 'urn:li:adTargetingFacet:industries': ['urn:li:industry:4'] } } };
const campaign = { id: Number(C), account: AU, name: 'Campaign', status: 'PAUSED', campaignGroup: `urn:li:sponsoredCampaignGroup:${G}`, type: 'TEXT_AD', unitCost: { amount: '1.000001', currencyCode: 'EUR' }, targetingCriteria: targeting, audienceExpansionEnabled: true, runSchedule: { start: 1_800_000_000_000, end: 1_800_086_400_000 } };
const group = { id: Number(G), account: AU, name: 'Group', status: 'PAUSED', totalBudget: { amount: '20.000001', currencyCode: 'EUR' }, runSchedule: { start: 1_800_000_000_000, end: 1_800_086_400_000 } };
type Call = { url: URL; init: RequestInit };
const body = (call: Call) => JSON.parse(String(call.init.body));
const writes = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET');
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'linkedin', accountId: A, tool, payload, kind });
const guard = { forcePausedCreation: true };
function fixture(handler?: (call: Call) => unknown) {
  const calls: Call[] = []; let currentGroup = structuredClone(group), currentCampaign = structuredClone(campaign);
  const client = new LinkedInAdsClient({ accessToken: 'access' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const native = decodeURIComponent(call.url.pathname).replace('/rest/', '');
    if (init.method === 'GET') {
      const values: Record<string, unknown> = { [`adAccounts/${A}`]: { id: Number(A), name: 'Account', currency: 'EUR', status: 'ACTIVE' }, [`adAccounts/${A}/adCampaignGroups/${G}`]: currentGroup, [`adAccounts/${A}/adCampaigns/${C}`]: currentCampaign, [`adAccounts/${A}/adCampaigns`]: { elements: [] }, [`adAccounts/${A}/creatives`]: { elements: [] }, adTargetingFacets: { elements: [{ facetName: 'locations', adTargetingFacetUrn: 'urn:li:adTargetingFacet:locations' }] }, adTargetingEntities: { elements: [{ urn: 'urn:li:geo:101282230', name: 'Germany', facetUrn: 'urn:li:adTargetingFacet:locations' }], paging: { start: 0, count: 50, total: 1 } } };
      if (values[native]) return Response.json(values[native]);
    }
    if (init.method === 'POST' && native === `adAccounts/${A}/adCampaignGroups`) { currentGroup = { ...currentGroup, ...body(call) }; return new Response(null, { status: 201, headers: { 'x-restli-id': G } }); }
    if (init.method === 'POST' && native.endsWith(`/adCampaignGroups/${G}`)) { currentGroup = { ...currentGroup, ...body(call).patch.$set }; return new Response(null, { status: 204 }); }
    if (init.method === 'POST' && native.endsWith(`/adCampaigns/${C}`)) { currentCampaign = { ...currentCampaign, ...body(call).patch.$set }; return new Response(null, { status: 204 }); }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fixture ${init.method} ${native}`);
  });
  return { calls, provider: new LinkedInAdsProvider(client) };
}
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('LinkedIn targeting, metadata and monetary updates', () => {
  it('uses native facet/entity discovery with URN output, locale and bounded paging', async () => {
    const { provider, calls } = fixture(); expect((await provider.management.facets(A)).elements).toHaveLength(1);
    const result = await provider.management.entities({ account_id: A, facet: 'urn:li:adTargetingFacet:locations', locale: { language: 'de', country: 'DE' }, start: 0, count: 50 }); expect(result.truncated).toBe(false);
    const url = calls.at(-1)!.url; expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: 'adTargetingFacet', facet: 'urn:li:adTargetingFacet:locations', queryVersion: 'QUERY_USES_URNS', locale: '(language:de,country:DE)', start: '0', count: '50' }); expect(calls.at(-1)!.init.headers).toMatchObject({ 'X-RestLi-Method': 'FINDER' });
  });
  it('preserves an omitted exclusion and expansion flag when replacing include clauses', async () => {
    const { provider, calls } = fixture(), include = { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278'] } }] };
    await provider.applyWrite(op('linkedin_update_targeting', { campaign_id: C, targeting_criteria: { include } }), guard);
    expect(body(writes(calls)[0]!)).toEqual({ patch: { $set: { targetingCriteria: { include, exclude: targeting.exclude } } } });
    await provider.applyWrite(op('linkedin_update_targeting', { campaign_id: C, audience_expansion_enabled: false }), guard); expect(body(writes(calls)[1]!)).toEqual({ patch: { $set: { audienceExpansionEnabled: false } } });
  });
  it.each([
    { include: { and: [{ or: { 'urn:li:adTargetingFacet:skills': ['urn:li:skill:1'] } }] } },
    { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:1'], 'urn:li:adTargetingFacet:profileLocations': ['urn:li:geo:1'] } }] } },
    { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:country:de'] } }] } },
    { include: targeting.include, exclude: { or: { 'urn:li:adTargetingFacet:audienceMatchingSegments': ['urn:li:adSegment:1'] } } },
  ])('rejects invalid geo/custom audience edits before mutation', async targeting_criteria => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('linkedin_update_targeting', { campaign_id: C, targeting_criteria }), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it('refuses unsupported current targeting instead of silently dropping unknown fields', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/adCampaigns/${C}`) ? { ...campaign, targetingCriteria: { ...targeting, future_native_dimension: true } } : undefined);
    await expect(provider.previewWrite(op('linkedin_update_targeting', { campaign_id: C, targeting_criteria: { include: targeting.include } }), guard)).rejects.toThrow('unsupported'); expect(writes(calls)).toEqual([]);
  });
  it('preserves schedule bounds during metadata edits and rejects an inverted merged schedule', async () => {
    const { provider, calls } = fixture(); await provider.applyWrite(op('linkedin_update_campaign', { campaign_id: C, name: 'Edited', start_time: 1_800_000_000_001 }), guard);
    expect(body(writes(calls)[0]!)).toEqual({ patch: { $set: { name: 'Edited', runSchedule: { start: 1_800_000_000_001, end: campaign.runSchedule.end } } } });
    await expect(provider.previewWrite(op('linkedin_update_campaign', { campaign_id: C, start_time: 1_800_086_400_001 }), guard)).rejects.toThrow('later than start'); expect(writes(calls)).toHaveLength(1);
  });
  it('uses current exact unitCost micros and native decimal strings without changing strategy', async () => {
    const { provider, calls } = fixture(), operation = op('linkedin_set_bid', { campaign_id: C, bid_micros: 1_100_001 });
    expect((await provider.previewWrite(operation, guard)).budgetDeltas).toEqual([{ target: `adCampaigns/${C} unitCost`, fromMicros: 1_000_001, toMicros: 1_100_001 }]); expect(writes(calls)).toEqual([]); await provider.applyWrite(operation, guard); expect(body(writes(calls)[0]!)).toEqual({ patch: { $set: { unitCost: { amount: '1.100001', currencyCode: 'EUR' } } } });
  });
  it('accepts semantically identical decimal readback and rejects a foreign current currency', async () => {
    let applied = false;
    const normalized = fixture(call => { if (call.init.method === 'POST') { applied = true; return undefined; } if (applied && call.url.pathname.endsWith(`/adCampaigns/${C}`)) return { ...campaign, unitCost: { amount: '1.1', currencyCode: 'EUR' } }; });
    await expect(normalized.provider.applyWrite(op('linkedin_set_bid', { campaign_id: C, bid_micros: 1_100_000 }), guard)).resolves.toMatchObject({ applied: true });
    const foreign = fixture(call => call.url.pathname.endsWith(`/adCampaigns/${C}`) ? { ...campaign, unitCost: { amount: '1', currencyCode: 'USD' } } : undefined); await expect(foreign.provider.previewWrite(op('linkedin_set_bid', { campaign_id: C, bid_micros: 1_100_000 }), guard)).rejects.toThrow('currency differs'); expect(writes(foreign.calls)).toEqual([]);
  });
  it('refuses bids managed by a dynamic group, missing money and foreign parents', async () => {
    const dynamic = fixture(call => call.url.pathname.endsWith(`/adCampaignGroups/${G}`) ? { ...group, budgetOptimization: { budgetOptimizationStrategy: 'DYNAMIC' } } : undefined); await expect(dynamic.provider.previewWrite(op('linkedin_set_bid', { campaign_id: C, bid_micros: 1_100_001 }), guard)).rejects.toThrow('dynamic campaign group'); expect(writes(dynamic.calls)).toEqual([]);
    const foreign = fixture(call => call.url.pathname.endsWith(`/adCampaignGroups/${G}`) ? { ...group, account: 'urn:li:sponsoredAccount:999' } : undefined); await expect(foreign.provider.previewWrite(op('linkedin_set_bid', { campaign_id: C, bid_micros: 1_100_001 }), guard)).rejects.toThrow('mismatch');
    const missing = fixture(call => call.url.pathname.endsWith(`/adCampaigns/${C}`) ? { ...campaign, unitCost: null } : undefined); await expect(missing.provider.previewWrite(op('linkedin_set_bid', { campaign_id: C, bid_micros: 1_100_001 }), guard)).rejects.toThrow('current native money');
  });
  it('applies the normal exact-argument and budget/protected-account policies to bids', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'linkedin-management-')); dirs.push(directory); const { provider, calls } = fixture(), audit = new AuditLog(path.join(directory, 'audit')), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(directory, 'pending')), audit), runtime = await createContext({ engine, providerModules: [{ provider, tools: linkedinTools(provider) }] });
    const args = { account_id: A, campaign_id: C, bid_micros: 1_100_001 }, pending = await runtime.registry.call('linkedin_set_bid', args, runtime.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]);
    await expect(runtime.registry.call('linkedin_set_bid', { ...args, bid_micros: 1_100_002, pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('differs'); await runtime.registry.call('linkedin_set_bid', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx); expect(writes(calls)).toHaveLength(1);
    await expect(runtime.registry.call('linkedin_set_bid', { ...args, bid_micros: 2_000_001 }, runtime.ctx)).rejects.toThrow('budget-delta cap'); const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(directory, 'protected')), audit); await expect(protectedEngine.validate(provider, op('linkedin_set_bid', { campaign_id: C, bid_micros: 1_100_001 }))).rejects.toThrow('protected');
  });
});

describe('LinkedIn campaign-group lifecycle', () => {
  const create = { name: 'QA group', start_time: group.runSchedule.start, end_time: group.runSchedule.end, total_budget_micros: 20_000_001, status: 'ACTIVE' };
  it('coerces requested ACTIVE creation to native non-serving DRAFT and verifies its readback', async () => {
    const { provider, calls } = fixture(), operation = op('linkedin_create_campaign_group', create, 'create'), preview = await provider.previewWrite(operation, guard);
    expect(preview.coercions[0]).toContain('non-serving DRAFT'); expect(preview.budgetDeltas[0]?.toMicros).toBe(20_000_001); expect(writes(calls)).toEqual([]); await provider.applyWrite(operation, guard);
    expect(body(writes(calls)[0]!)).toEqual({ account: AU, name: 'QA group', runSchedule: group.runSchedule, status: 'DRAFT', totalBudget: { amount: '20.000001', currencyCode: 'EUR' } });
  });
  it('requires advertiser confirmation for ACTIVE creation when policy permits it and for activation', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('linkedin_create_campaign_group', create, 'create'), { forcePausedCreation: false })).rejects.toThrow('explicit advertiser'); await expect(provider.previewWrite(op('linkedin_set_campaign_group_status', { campaign_group_id: G, status: 'ACTIVE' }), guard)).rejects.toThrow('explicit advertiser'); expect(writes(calls)).toEqual([]);
    await provider.applyWrite(op('linkedin_set_campaign_group_status', { campaign_group_id: G, status: 'PAUSED' }), guard); expect(body(writes(calls)[0]!)).toEqual({ patch: { $set: { status: 'PAUSED' } } });
  });
  it('bounds UTF-8 names and requires an end for group lifetime caps', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('linkedin_create_campaign_group', { ...create, name: '界'.repeat(67) }, 'create'), guard)).rejects.toThrow('200 UTF-8 bytes'); await expect(provider.previewWrite(op('linkedin_create_campaign_group', { ...create, end_time: undefined }, 'create'), guard)).rejects.toThrow('requires end_time'); expect(writes(calls)).toEqual([]);
  });
  it('updates ordinary lifetime caps with current exact micros and preserves metadata schedules', async () => {
    const { provider, calls } = fixture(), operation = op('linkedin_set_campaign_group_budget', { campaign_group_id: G, budget_micros: 22_000_001 }); expect((await provider.previewWrite(operation, guard)).budgetDeltas[0]).toMatchObject({ fromMicros: 20_000_001, toMicros: 22_000_001 }); await provider.applyWrite(operation, guard); expect(body(writes(calls)[0]!)).toEqual({ patch: { $set: { totalBudget: { amount: '22.000001', currencyCode: 'EUR' } } } });
    await provider.applyWrite(op('linkedin_update_campaign_group', { campaign_group_id: G, end_time: group.runSchedule.end + 1 }), guard); expect(body(writes(calls)[1]!)).toEqual({ patch: { $set: { runSchedule: { start: group.runSchedule.start, end: group.runSchedule.end + 1 } } } });
  });
  it.each([
    { ...group, budgetOptimization: { budgetOptimizationStrategy: 'DYNAMIC' } },
    { ...group, runSchedule: { start: group.runSchedule.start } },
    { ...group, totalBudget: null },
  ])('rejects unsupported group cap modes without mutation', async value => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/adCampaignGroups/${G}`) ? value : undefined); await expect(provider.previewWrite(op('linkedin_set_campaign_group_budget', { campaign_group_id: G, budget_micros: 22_000_001 }), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it('deletes empty draft groups and reports non-draft deletion as pending', async () => {
    const existing = fixture(); expect((await existing.provider.applyWrite(op('linkedin_delete_campaign_group', { campaign_group_id: G }, 'remove'), guard)).details).toEqual({ deletion: 'PENDING_DELETION' }); expect(body(writes(existing.calls)[0]!)).toEqual({ patch: { $set: { status: 'PENDING_DELETION' } } });
    const draft = fixture(call => call.init.method === 'GET' && call.url.pathname.endsWith(`/adCampaignGroups/${G}`) ? { ...group, status: 'DRAFT' } : undefined); expect((await draft.provider.applyWrite(op('linkedin_delete_campaign_group', { campaign_group_id: G }, 'remove'), guard)).details).toEqual({ deletion: 'DELETED' }); expect(writes(draft.calls)[0]!.init.method).toBe('DELETE');
  });
  it('requires child-first cleanup for groups and campaigns', async () => {
    const groupWithChild = fixture(call => call.url.pathname.endsWith('/adCampaigns') ? { elements: [campaign] } : undefined); await expect(groupWithChild.provider.previewWrite(op('linkedin_delete_campaign_group', { campaign_group_id: G }, 'remove'), guard)).rejects.toThrow('contained campaigns'); expect(writes(groupWithChild.calls)).toEqual([]);
    const campaignWithAd = fixture(call => call.url.pathname.endsWith('/creatives') ? { elements: [{ id: 'urn:li:sponsoredCreative:123', account: AU, campaign: `urn:li:sponsoredCampaign:${C}`, intendedStatus: 'PAUSED' }] } : undefined); await expect(campaignWithAd.provider.previewWrite(op('linkedin_delete_campaign', { campaign_id: C }, 'remove'), guard)).rejects.toThrow('contained creatives'); expect(writes(campaignWithAd.calls)).toEqual([]);
  });
  it('retains the resource ID when native readback changes delivery unexpectedly', async () => {
    const { provider } = fixture(call => call.url.pathname.endsWith(`/adCampaignGroups/${G}`) && call.init.method === 'GET' ? { ...group, status: 'ACTIVE' } : undefined); await expect(provider.applyWrite(op('linkedin_update_campaign_group', { campaign_group_id: G, name: 'Edited' }), guard)).rejects.toMatchObject({ details: { resource_ids: [G] } });
  });
});
