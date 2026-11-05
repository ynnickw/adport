import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { LinkedInAdsClient, LINKEDIN_API_VERSION } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';

// Synthetic wire fixtures checked2026-11-05 against the official Marketing202608
// conversion-tracking, conversions-api and conversions-api-schema contracts.
const A = '551000001', F = '551000002', C = '2001', V = '1001', T = '3001', urn = `urn:li:sponsoredAccount:${A}`, cu = `urn:li:sponsoredCampaign:${C}`, vu = `urn:lla:llaPartnerConversion:${V}`;
const native = { id: Number(V), account: urn, name: 'QA rule', type: 'LEAD', enabled: false, attributionType: 'LAST_TOUCH_BY_CAMPAIGN', postClickAttributionWindowSize: 30, viewThroughAttributionWindowSize: 7, campaigns: [], associatedCampaigns: [], lastModified: 1700000000000, imagePixelTag: '<img src="https://px.ads.linkedin.com/collect/?pid=synthetic">' };
type Call = { url: URL; init: RequestInit };
const body = (call: Call) => JSON.parse(String(call.init.body));
const guard = { forcePausedCreation: true }, dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture(handler?: (call: Call) => unknown | Response) {
  const calls: Call[] = [], state = { rule: structuredClone(native) as Record<string, unknown>, tags: [] as Array<Record<string, unknown>>, associations: [] as Array<{ campaign: string; conversion: string; associatedAt: number }> };
  const client = new LinkedInAdsClient({ accessToken: 'qa-only' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const resource = call.url.pathname, method = init.method, start = Number(call.url.searchParams.get('start') ?? 0), count = Number(call.url.searchParams.get('count') ?? 50);
    const page = <T>(rows: T[]) => Response.json({ elements: rows.slice(start, start + count), paging: { start, count, total: rows.length, links: [] } });
    if (resource === `/rest/adAccounts/${A}`) return Response.json({ id: Number(A), name: 'Synthetic advertiser', currency: 'EUR', status: 'DRAFT' });
    if (resource === `/rest/adAccounts/${A}/adCampaigns/${C}`) return Response.json({ id: Number(C), account: urn, name: 'QA campaign', status: 'PAUSED' });
    if (resource === '/rest/conversions' && method === 'GET') return page([state.rule]);
    if (resource === `/rest/conversions/${V}` && method === 'GET') return Response.json(state.rule);
    if (resource === '/rest/conversions' && method === 'POST') { state.rule = { ...native, ...body(call) }; return Response.json(state.rule, { status: 201, headers: { 'x-restli-id': V } }); }
    if (resource === `/rest/conversions/${V}` && method === 'POST') { Object.assign(state.rule, body(call).patch.$set, { lastModified: Number(state.rule.lastModified) + 1 }); return new Response(null, { status: 204 }); }
    if (resource === '/rest/insightTags' && method === 'GET') return page(state.tags);
    if (resource === '/rest/insightTags' && method === 'POST') { state.tags = [{ id: Number(T), ...body(call), firstPartyTrackingEnabled: true, tag: '<script>synthetic-only</script>' }]; return new Response(null, { status: 201, headers: { 'x-restli-id': T } }); }
    if (resource === `/rest/insightTags/${T}` && method === 'POST') { Object.assign(state.tags[0]!, body(call).patch.$set); return new Response(null, { status: 204 }); }
    if (resource === '/rest/campaignConversions' && method === 'GET') return page(state.associations);
    if (resource.startsWith('/rest/campaignConversions/(') && ['PUT', 'DELETE'].includes(method ?? '')) { state.associations = method === 'PUT' ? [{ campaign: cu, conversion: vu, associatedAt: 1700000000100 }] : []; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected ${method} ${resource}`);
  });
  return { provider: new LinkedInAdsProvider(client), calls, state, client };
}
const mutations = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET');
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'linkedin', accountId: A, tool, payload, kind });
async function reference(provider: LinkedInAdsProvider) { return { conversion_id: V, expected_snapshot_hash: (await provider.measurement.getConversion(A, V)).conversion.snapshot_hash }; }
async function creation(provider: LinkedInAdsProvider) { return { expected_account_hash: (await provider.measurement.conversions({ account_id: A })).account_snapshot_hash, name: 'New QA rule', type: 'LEAD' }; }

describe('LinkedIn measurement native reads', () => {
  it('defines each shared lazy tool once and distinguishes additive creation from existing-data edits', () => {
    const tools = linkedinTools(new Proxy({} as LinkedInAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    const names = ['linkedin_insight_tags', 'linkedin_insight_tag_domains', 'linkedin_conversions', 'linkedin_get_conversion', 'linkedin_campaign_conversions', 'linkedin_create_insight_tag', 'linkedin_update_insight_tag', 'linkedin_create_conversion', 'linkedin_update_conversion', 'linkedin_set_campaign_conversion'];
    for (const name of names) { expect(tools.filter(tool => tool.name === name)).toHaveLength(1); expect(tools.find(tool => tool.name === name)?.catalog).toMatchObject({ category: 'measurement' }); }
    for (const name of names.slice(0, 5)) expect(tools.find(tool => tool.name === name)).toMatchObject({ presentation: 'records', annotations: { readOnly: true } });
    for (const name of names.slice(5)) expect(tools.find(tool => tool.name === name)).toMatchObject({ annotations: { readOnly: false, destructive: !name.startsWith('linkedin_create_') } });
  });
  it('pins account finder, offset, protocol/version headers and native owned snapshots', async () => {
    const f = fixture(), result = await f.provider.measurement.conversions({ account_id: A });
    expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toEqual({ q: 'account', account: urn, start: '0', count: '50' });
    expect(f.calls.at(-1)!.url.href).toContain('account=urn%3Ali%3AsponsoredAccount%3A');
    expect(f.calls.at(-1)!.init.headers).toMatchObject({ 'Linkedin-Version': LINKEDIN_API_VERSION, 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'FINDER' });
    expect(result).toMatchObject({ currency: 'EUR', complete: true, truncated: false, elements: [{ id: V, enabled: false, editable: true }], records: [{ name: 'QA rule', status: 'Disabled' }] });
    expect(result.account_snapshot_hash).toMatch(/^[a-f0-9]{64}$/); expect(result.elements[0]).toHaveProperty('snapshot_hash'); expect(mutations(f.calls)).toEqual([]);
  });
  it('keeps shared conversion discovery read-only and never labels a foreign owned rule as editable', async () => {
    const f = fixture(call => call.url.pathname === '/rest/conversions' ? { elements: [{ ...native, account: `urn:li:sponsoredAccount:${F}`, ownershipType: 'SHARED' }], paging: { start: 0, count: 50 } } : undefined);
    expect((await f.provider.measurement.conversions({ account_id: A, include_shared: true })).elements[0]).toMatchObject({ editable: false, ownershipType: 'SHARED' });
    expect(f.calls.at(-1)!.url.searchParams.get('conversionOwnershipTypes')).toBe('List(OWNED,SHARED)');
    await expect(f.provider.measurement.conversions({ account_id: A })).rejects.toThrow('advertiser');
  });
  it.each([{ id: 99 }, { account: `urn:li:sponsoredAccount:${F}` }, { ownershipType: 'SHARED' }, { associatedCampaigns: [{ campaign: cu, conversion: 'urn:lla:llaPartnerConversion:99' }] }])('rejects mismatched single-rule identity/ownership %#', async changed => {
    const f = fixture(call => call.url.pathname === `/rest/conversions/${V}` ? { ...native, ...changed } : undefined);
    await expect(f.provider.measurement.getConversion(A, V)).rejects.toThrow('advertiser/ID'); expect(mutations(f.calls)).toEqual([]);
  });
  it('uses the account query on single-rule GET and retains inert native pixel code as data', async () => {
    const f = fixture(), result = await f.provider.measurement.getConversion(A, V);
    expect(f.calls.at(-1)!.url.searchParams.get('account')).toBe(urn); expect(result.conversion.imagePixelTag).toBe(native.imagePixelTag); expect(result.records).not.toEqual(expect.arrayContaining([expect.objectContaining({ imagePixelTag: expect.anything() })]));
  });
  it('advances by the actual native page width and refuses foreign next URLs', async () => {
    const f = fixture(call => call.url.pathname === '/rest/conversions' ? { elements: [native], paging: { start: 0, count: 10, total: 20, links: [{ rel: 'next', href: 'https://untrusted.test' }] } } : undefined);
    expect(await f.provider.measurement.conversions({ account_id: A, count: 50 })).toMatchObject({ next_start: 10, complete: false, truncated: true }); expect(f.calls.every(call => call.url.hostname === 'api.linkedin.com')).toBe(true);
  });
  it.each([
    { elements: [native, native] }, { elements: [native], paging: { start: 1, count: 50 } }, { elements: [native], paging: { start: 0, count: 0 } }, { elements: [native], paging: { start: 0, count: 51 } }, { elements: [native], paging: { start: 0, count: 50, total: 0 } }, { elements: [], paging: { start: 0, count: 50, total: 1 } },
  ])('rejects contradictory or duplicate conversion pages %#', async response => {
    const f = fixture(call => call.url.pathname === '/rest/conversions' ? response : undefined);
    await expect(f.provider.measurement.conversions({ account_id: A })).rejects.toThrow();
  });
  it('does not invent completeness or continuation when paging metadata is absent', async () => {
    const f = fixture(call => call.url.pathname === '/rest/conversions' ? { elements: [native] } : undefined);
    expect(await f.provider.measurement.conversions({ account_id: A })).toMatchObject({ complete: null });
    expect((await f.provider.measurement.conversions({ account_id: A })).next_start).toBeUndefined();
    await expect(f.provider.measurement.conversions({ account_id: A, start: 50 })).rejects.toThrow('pagination');
  });
  it.each([-1, -7])('preserves a negative native total%d without treating it as zero or dropping returned rules', async total => {
    const f = fixture(call => call.url.pathname === '/rest/conversions' ? { elements: [native], paging: { start: 0, count: 1, total, links: [] } } : undefined);
    const result = await f.provider.measurement.conversions({ account_id: A, count: 1 });
    expect(result).toMatchObject({ elements: [{ id: V }], paging: { total }, complete: false, truncated: true, next_start: 1 });
    expect(result.notes?.join(' ')).toContain('not a row count');
  });
  it('accepts an exhausted empty page with an unknown negative total without inventing a numeric total', async () => {
    const f = fixture(call => call.url.pathname === '/rest/conversions' ? { elements: [], paging: { start: 0, count: 10, total: -1, links: [] } } : undefined);
    const result = await f.provider.measurement.conversions({ account_id: A, count: 10 });
    expect(result).toMatchObject({ elements: [], paging: { total: -1 }, complete: true, truncated: false }); expect(result.next_start).toBeUndefined();
  });
  it('honors a native relative offset by extracting only the number and rebuilding scoped requests', async () => {
    const f = fixture(call => call.url.pathname === '/rest/conversions' ? { elements: [native], paging: { start: 0, count: 10, total: 20, links: [{ rel: 'next', href: `https://api.linkedin.com/rest/conversions?q=account&account=${encodeURIComponent(urn)}&start=1&count=10` }] } } : undefined);
    expect(await f.provider.measurement.conversions({ account_id: A, count: 10 })).toMatchObject({ next_start: 1, truncated: true }); expect(f.calls).toHaveLength(2);
  });
  it('reports bounded schema field/type diagnostics without exposing native values', async () => {
    const f = fixture(call => call.url.pathname === '/rest/conversions' ? { elements: [{ ...native, enabled: 'do-not-disclose-native-value' }] } : undefined);
    let error: unknown;
    try { await f.provider.measurement.conversions({ account_id: A }); } catch (value) { error = value; }
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { resource: 'conversions', schema_issues: [{ field_path: '/elements/0/enabled', code: 'invalid_type', received_type: 'string', expected_type: 'boolean' }] } });
    expect(JSON.stringify(error)).not.toContain('do-not-disclose-native-value'); expect(mutations(f.calls)).toEqual([]);
  });
});

describe('LinkedIn measurement guarded configuration', () => {
  it('creates a disabled website rule with explicit windows and no auto-association or tracking requests', async () => {
    const f = fixture(), input = await creation(f.provider), operation = op('linkedin_create_conversion', input, 'create');
    await f.provider.previewWrite(operation, guard); expect(mutations(f.calls)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ applied: true, resourceIds: [V] });
    const write = mutations(f.calls)[0]!;
    expect(write.url.href).toBe('https://api.linkedin.com/rest/conversions');
    expect(body(write)).toEqual({ account: urn, name: input.name, type: 'LEAD', enabled: false, attributionType: 'LAST_TOUCH_BY_CAMPAIGN', postClickAttributionWindowSize: 30, viewThroughAttributionWindowSize: 7 });
    expect(f.calls.at(-1)!.url.pathname).toBe(`/rest/conversions/${V}`);
    expect(f.calls.every(call => call.url.hostname === 'api.linkedin.com' && !call.url.pathname.includes('conversionEvents'))).toBe(true);
  });
  it('supports documented CAPI types, extended windows and exact currency without expanding scopes', async () => {
    const f = fixture(), input = { ...await creation(f.provider), source: 'CONVERSIONS_API', type: 'MARKETING_QUALIFIED_LEAD', post_click_window_days: 365, view_through_window_days: 180, value_type: 'FIXED', value: { amount: '9007199254740993.123456789', currencyCode: 'EUR' } };
    const preview = await f.provider.previewWrite(op('linkedin_create_conversion', input, 'create'), guard); expect(preview.changes.join(' ')).toContain('rw_conversions');
    await f.provider.applyWrite(op('linkedin_create_conversion', input, 'create'), guard);
    expect(body(mutations(f.calls)[0]!)).toMatchObject({ conversionMethod: 'CONVERSIONS_API', type: input.type, postClickAttributionWindowSize: 365, value: input.value });
  });
  it.each([
    { post_click_window_days: 90 }, { type: 'QUALIFIED_LEAD' }, { value_type: 'FIXED' }, { value: { amount: '1', currencyCode: 'USD' } }, { source: 'CONVERSIONS_API', type: 'OTHER', post_click_window_days: 180 }, { source: 'CONVERSIONS_API', url_match_rule_expression: [] }, { source: 'CONVERSIONS_API', value_type: 'FIXED' }, { source: 'CONVERSIONS_API', type: 'OTHER', view_through_window_days: 365 },
  ])('rejects unsupported source/window/value combinations before a write %#', async changed => {
    const f = fixture(); await expect(f.provider.previewWrite(op('linkedin_create_conversion', { ...await creation(f.provider), ...changed }, 'create'), guard)).rejects.toThrow(); expect(mutations(f.calls)).toEqual([]);
  });
  it('partial-updates only supplied fields, preserving unknown configuration and associations', async () => {
    const f = fixture(); f.state.rule = { ...f.state.rule, vendorField: 'preserve', value: { amount: '10.00', currencyCode: 'EUR' }, urlMatchRuleExpression: [[{ matchType: 'EXACT', matchValue: 'example.test/thanks' }]] };
    const input = { ...await reference(f.provider), name: 'Renamed' }, operation = op('linkedin_update_conversion', input);
    await f.provider.previewWrite(operation, guard); expect(mutations(f.calls)).toEqual([]); await f.provider.applyWrite(operation, guard);
    const write = mutations(f.calls)[0]!;
    expect(write.init.method).toBe('POST'); expect(write.url.searchParams.get('account')).toBe(urn); expect(write.init.headers).toMatchObject({ 'X-RestLi-Method': 'PARTIAL_UPDATE' }); expect(body(write)).toEqual({ patch: { $set: { name: 'Renamed' } } });
    expect(f.state.rule).toMatchObject({ vendorField: 'preserve', enabled: false, value: { amount: '10.00' }, urlMatchRuleExpression: [[{ matchValue: 'example.test/thanks' }]] });
  });
  it('renames an existing rule without rejecting unrelated newer native configuration', async () => {
    const f = fixture(); f.state.rule = { ...f.state.rule, type: 'FUTURE_NATIVE_TYPE', postClickAttributionWindowSize: 180 };
    await f.provider.applyWrite(op('linkedin_update_conversion', { ...await reference(f.provider), name: 'Name only' }), guard);
    expect(body(mutations(f.calls)[0]!)).toEqual({ patch: { $set: { name: 'Name only' } } });
  });
  it('switches CAPI value handling to NO_VALUE while preserving the omitted stored monetary value', async () => {
    const f = fixture(); f.state.rule = { ...f.state.rule, conversionMethod: 'CONVERSIONS_API', valueType: 'FIXED', value: { amount: '10', currencyCode: 'EUR' } };
    await f.provider.applyWrite(op('linkedin_update_conversion', { ...await reference(f.provider), value_type: 'NO_VALUE' }), guard);
    expect(body(mutations(f.calls)[0]!)).toEqual({ patch: { $set: { valueType: 'NO_VALUE' } } }); expect(f.state.rule.value).toEqual({ amount: '10', currencyCode: 'EUR' });
  });
  it('disables through native partial update and never invents a conversion DELETE endpoint', async () => {
    const f = fixture(); f.state.rule.enabled = true;
    await f.provider.applyWrite(op('linkedin_update_conversion', { ...await reference(f.provider), enabled: false }), guard);
    expect(body(mutations(f.calls)[0]!)).toEqual({ patch: { $set: { enabled: false } } }); expect(f.calls.some(call => call.init.method === 'DELETE')).toBe(false);
  });
  it('replaces the complete supplied URL expression without changing other rule settings', async () => {
    const f = fixture(), expression = [[{ matchType: 'STARTS_WITH', matchValue: 'example.test/products' }, { matchType: 'CONTAINS', matchValue: '/thanks' }], [{ matchType: 'EXACT', matchValue: 'example.test/done' }]];
    await f.provider.applyWrite(op('linkedin_update_conversion', { ...await reference(f.provider), url_match_rule_expression: expression }), guard);
    expect(body(mutations(f.calls)[0]!)).toEqual({ patch: { $set: { urlMatchRuleExpression: expression } } });
  });
  it('rejects stale/no-op snapshots, invalid kinds and foreign providers before mutation', async () => {
    const f = fixture(), input = await reference(f.provider); f.state.rule.lastModified = 1700000000010;
    await expect(f.provider.previewWrite(op('linkedin_update_conversion', { ...input, name: 'Changed' }), guard)).rejects.toThrow('snapshot');
    await expect(f.provider.previewWrite(op('linkedin_update_conversion', { ...await reference(f.provider), name: native.name }), guard)).rejects.toThrow('already match');
    await expect(f.provider.previewWrite(op('linkedin_create_conversion', await creation(f.provider)), guard)).rejects.toThrow('kind');
    await expect(f.provider.previewWrite({ ...op('linkedin_update_conversion', input), provider: 'meta' }, guard)).rejects.toThrow('kind'); expect(mutations(f.calls)).toEqual([]);
  });
  it('preserves the created resource identity when native readback fails and never retries', async () => {
    let created = false;
    const f = fixture(call => { if (call.url.pathname === '/rest/conversions' && call.init.method === 'POST') { created = true; return new Response(null, { status: 201, headers: { 'x-restli-id': V } }); } if (created && call.url.pathname === `/rest/conversions/${V}`) return new Response('{}', { status: 503 }); });
    await expect(f.provider.applyWrite(op('linkedin_create_conversion', await creation(f.provider), 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [V] } }); expect(mutations(f.calls)).toHaveLength(1);
  });
  it('binds the real registry preview/apply to input, project account and one consumed token', async () => {
    const f = fixture(), dir = await mkdtemp(path.join(tmpdir(), 'adport-linkedin-measurement-')); dirs.push(dir);
    const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit')));
    const rt = await createContext({ engine, providerModules: [{ provider: f.provider, tools: linkedinTools(f.provider) }] }), args = { account_id: A, ...await creation(f.provider) };
    const preview = await rt.registry.call('linkedin_create_conversion', args, rt.ctx) as { pending_operation_id: string }; expect(mutations(f.calls)).toEqual([]);
    await expect(rt.registry.call('linkedin_create_conversion', { ...args, name: 'changed', pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(await rt.registry.call('linkedin_create_conversion', { ...args, pending_operation_id: preview.pending_operation_id }, rt.ctx)).toMatchObject({ applied: true });
    await expect(rt.registry.call('linkedin_create_conversion', { ...args, pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toThrow(); expect(mutations(f.calls)).toHaveLength(1);
  });
});

describe('LinkedIn Insight Tag and campaign association contracts', () => {
  it('creates one unused advertiser tag and updates the unshared native flag with readback', async () => {
    const f = fixture(), context = await f.provider.measurement.insightTags(A), create = op('linkedin_create_insight_tag', { expected_account_hash: context.account_snapshot_hash }, 'create');
    await f.provider.previewWrite(create, guard); expect(mutations(f.calls)).toEqual([]); await f.provider.applyWrite(create, guard);
    expect(body(mutations(f.calls)[0]!)).toEqual({ sponsoredAccounts: [urn] });
    const tag = (await f.provider.measurement.insightTags(A)).elements[0]!;
    await f.provider.applyWrite(op('linkedin_update_insight_tag', { insight_tag_id: T, expected_snapshot_hash: tag.snapshot_hash, first_party_tracking_enabled: false }), guard);
    expect(body(mutations(f.calls)[1]!)).toEqual({ patch: { $set: { firstPartyTrackingEnabled: false } } });
  });
  it('rejects foreign, duplicate or shared-write tag membership and an existing tag create', async () => {
    const f = fixture(); f.state.tags = [{ id: Number(T), sponsoredAccounts: [urn, `urn:li:sponsoredAccount:${F}`], firstPartyTrackingEnabled: true }];
    const tags = await f.provider.measurement.insightTags(A);
    await expect(f.provider.previewWrite(op('linkedin_update_insight_tag', { insight_tag_id: T, expected_snapshot_hash: tags.elements[0]!.snapshot_hash, first_party_tracking_enabled: false }), guard)).rejects.toThrow('multi-account');
    await expect(f.provider.previewWrite(op('linkedin_create_insight_tag', { expected_account_hash: tags.account_snapshot_hash }, 'create'), guard)).rejects.toThrow('already has');
    f.state.tags[0]!.sponsoredAccounts = [`urn:li:sponsoredAccount:${F}`]; await expect(f.provider.measurement.insightTags(A)).rejects.toThrow('membership'); expect(mutations(f.calls)).toEqual([]);
  });
  it('binds domain diagnostics to the selected tag and does not execute callbacks', async () => {
    const f = fixture(call => call.url.pathname === '/rest/insightTagDomains' ? { elements: [{ domainName: 'example.test', insightTag: `urn:tscp:insightTag:${T}`, blocked: true, lastCallbackAt: 1700000000000 }], paging: { start: 0, count: 50 } } : undefined);
    f.state.tags = [{ id: Number(T), sponsoredAccounts: [urn], firstPartyTrackingEnabled: true }];
    expect(await f.provider.measurement.domains({ account_id: A })).toMatchObject({ records: [{ domain: 'example.test', status: 'Blocked' }], complete: true });
    expect(f.calls.at(-1)!.url.searchParams.get('account')).toBe(urn); expect(mutations(f.calls)).toEqual([]);
  });
  it.each([true, false])('uses the exact encoded composite key and native204 for associated=%s', async associated => {
    const f = fixture(); if (!associated) f.state.associations = [{ campaign: cu, conversion: vu, associatedAt: 1700000000000 }];
    const rule = await reference(f.provider), membership = await f.provider.measurement.campaignConversions({ account_id: A, campaign_id: C, complete_snapshot: true });
    const operation = op('linkedin_set_campaign_conversion', { campaign_id: C, conversion_id: V, associated, expected_conversion_hash: rule.expected_snapshot_hash, expected_associations_hash: membership.associations_snapshot_hash });
    await f.provider.previewWrite(operation, guard); expect(mutations(f.calls)).toEqual([]); await f.provider.applyWrite(operation, guard);
    const write = mutations(f.calls)[0]!;
    expect(write.url.href).toBe(`https://api.linkedin.com/rest/campaignConversions/(campaign:urn%3Ali%3AsponsoredCampaign%3A${C},conversion:urn%3Alla%3AllaPartnerConversion%3A${V})`);
    expect(write.init.method).toBe(associated ? 'PUT' : 'DELETE'); expect(write.init.body).toBe(associated ? JSON.stringify({ campaign: cu, conversion: vu }) : undefined);
    expect(f.state.associations).toHaveLength(associated ? 1 : 0); expect(f.calls.some(call => /conversionEvents|collect/.test(call.url.href))).toBe(false);
  });
  it('collects a complete multi-page association snapshot, with bounded widget records', async () => {
    const f = fixture(); f.state.associations = Array.from({ length: 125 }, (_, i) => ({ campaign: cu, conversion: `urn:lla:llaPartnerConversion:${i + 1}`, associatedAt: 1700000000000 }));
    const result = await f.provider.measurement.campaignConversions({ account_id: A, campaign_id: C, complete_snapshot: true });
    expect(result).toMatchObject({ complete: true, truncated: false }); expect(result.elements).toHaveLength(125); expect(result.records).toHaveLength(100); expect(result.associations_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls.filter(call => call.url.pathname === '/rest/campaignConversions').map(call => call.url.searchParams.get('start'))).toEqual(['0', '100']);
  });
  it('refuses a supposedly complete association snapshot when the collected membership misses its known total', async () => {
    const f = fixture(call => call.url.pathname === '/rest/campaignConversions' ? { elements: [{ campaign: cu, conversion: Number(call.url.searchParams.get('start')) === 0 ? vu : 'urn:lla:llaPartnerConversion:1002', associatedAt: 1700000000000 }], paging: { start: Number(call.url.searchParams.get('start')), count: 100, total: 101, links: [] } } : undefined);
    await expect(f.provider.measurement.campaignConversions({ account_id: A, campaign_id: C, complete_snapshot: true })).rejects.toThrow('completeness'); expect(mutations(f.calls)).toEqual([]);
  });
  it('rejects incomplete or foreign campaign membership and stale association snapshots', async () => {
    const f = fixture(call => call.url.pathname === '/rest/campaignConversions' ? { elements: [] } : undefined), rule = await reference(f.provider);
    await expect(f.provider.previewWrite(op('linkedin_set_campaign_conversion', { campaign_id: C, conversion_id: V, associated: true, expected_conversion_hash: rule.expected_snapshot_hash, expected_associations_hash: 'a'.repeat(64) }), guard)).rejects.toThrow('completeness');
    const foreign = fixture(call => call.url.pathname === '/rest/campaignConversions' ? { elements: [{ campaign: 'urn:li:sponsoredCampaign:999', conversion: vu }], paging: { start: 0, count: 50 } } : undefined);
    await expect(foreign.provider.measurement.campaignConversions({ account_id: A, campaign_id: C })).rejects.toThrow('scope'); expect(mutations(f.calls)).toEqual([]);
  });
  it('does not accept injected composite identifiers or retry a failed association write', async () => {
    const f = fixture(call => call.init.method === 'PUT' ? new Response('{}', { status: 503 }) : undefined);
    await expect(f.client.setCampaignConversion('1)&evil=true', V, true)).rejects.toThrow('identity'); expect(f.calls).toEqual([]);
    const input = { campaign_id: C, conversion_id: V, associated: true, expected_conversion_hash: (await reference(f.provider)).expected_snapshot_hash, expected_associations_hash: (await f.provider.measurement.campaignConversions({ account_id: A, campaign_id: C, complete_snapshot: true })).associations_snapshot_hash };
    await expect(f.provider.applyWrite(op('linkedin_set_campaign_conversion', input), guard)).rejects.toThrow('503'); expect(mutations(f.calls)).toHaveLength(1);
  });
});
