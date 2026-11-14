import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { SnapchatAdsClient, SNAPCHAT_TOKEN_URL } from '../src/client.js';
import { SnapchatAdsProvider } from '../src/provider.js';
import { snapchatTools } from '../src/tools.js';

// Current official customer-list, website/mobile/ad/profile engagement, lookalike,
// Snap Pixel, audience_size_v2 and custom-conversion examples reviewed2026-11-03.
const A = 'account-1', C = 'campaign-1', G = 'squad-1', SEG = '123456', PIXEL = 'pixel-1', APP = 'app-1', PROFILE = 'profile-1';
const segment = { id: SEG, ad_account_id: A, name: 'QA audience', description: 'Existing description', source_type: 'FIRST_PARTY', retention_in_days: 180, upload_status: 'NO_UPLOAD' };
const pixel = { id: PIXEL, ad_account_id: A, name: 'QA Pixel' };
const custom = { id: 'conversion-1', event_source: { id: PIXEL, type: 'PIXEL' }, name: 'QA conversion', event_type: 'PURCHASE', rules: [{ key: 'CUSTOMER_STATUS', values: ['new'], operator: 'I_EQUAL_TO' }] };
const group = { id: G, campaign_id: C, status: 'PAUSED', event_sources: { future_source: ['existing'] } };
const guard = { forcePausedCreation: true };
type Call = { url: URL; init: RequestInit };
const json = (call: Call) => JSON.parse(String(call.init.body));
const envelope = (plural: string, singular: string, rows: unknown[]) => ({ request_status: 'SUCCESS', [plural]: rows.map(row => ({ sub_request_status: 'SUCCESS', [singular]: row })) });
const writes = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET' && call.url.href !== SNAPCHAT_TOKEN_URL);
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'snapchat', accountId: A, tool, kind, payload });
function fixture(handler?: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client = new SnapchatAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === SNAPCHAT_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (init.method === 'GET') {
      const defaults: Record<string, unknown> = {
        [`/v1/adaccounts/${A}/pixels`]: envelope('pixels', 'pixel', [pixel]),
        [`/v1/adaccounts/${A}/segments`]: envelope('segments', 'segment', [segment]),
        [`/v1/segments/${SEG}`]: envelope('segments', 'segment', [segment]),
        [`/v1/adsquads/${G}`]: envelope('adsquads', 'adsquad', [group]),
        [`/v1/campaigns/${C}`]: envelope('campaigns', 'campaign', [{ id: C, ad_account_id: A, status: 'PAUSED' }]),
        [`/v1/adaccounts/${A}/sharing_policies`]: { request_status: 'SUCCESS', sharing_policies: [{ sharing_policy_id: 'policy-1', source: { resource_id: call.url.searchParams.get('shared_resource_types') === 'mobile_apps' ? APP : PROFILE, resource_type: call.url.searchParams.get('shared_resource_types') } }] },
      };
      if (defaults[call.url.pathname]) return Response.json(defaults[call.url.pathname]);
    }
    throw new Error(`Unexpected request ${init.method} ${call.url.href}`);
  });
  return { provider: new SnapchatAdsProvider(client), calls };
}
const segmentCreate = (call: Call) => call.init.method === 'POST' && call.url.pathname.endsWith('/segments') ? envelope('segments', 'segment', [{ id: SEG, ...json(call).segments[0] }]) : undefined;

describe('Snapchat audience configuration and ownership', () => {
  it.each([
    ['snapchat_create_customer_audience', { name: 'Empty customer list', retention_in_days: 9999 }, { source_type: 'FIRST_PARTY', retention_in_days: 9999 }],
    ['snapchat_create_website_audience', { name: 'Website audience', pixel_id: PIXEL, events: ['PURCHASE', 'START_CHECKOUT'] }, { source_type: 'PIXEL', prefill: true, pixel_id: PIXEL, pixel_spec_object: { or: { event: [{ eq: 'PURCHASE' }, { eq: 'START_CHECKOUT' }] } } }],
    ['snapchat_create_mobile_audience', { name: 'App audience', mobile_app_id: APP, events: ['AD_CLICK'] }, { source_type: 'MOBILE', prefill: true, mobile_metadata: { mobile_snapkit_id: APP, mobile_app_spec: { or: { event: [{ eq: 'AD_CLICK' }] } } } }],
    ['snapchat_create_engagement_audience', { name: 'Engagement audience', engagement_specs: [{ source_type: 'CAMPAIGN', source_id: C, engagement_type: 'PROMOTED_STORY_TAP' }, { source_type: 'AD_ACCOUNT', source_id: A, engagement_type: 'PAID_IMPRESSIONS' }] }, { source_type: 'ENGAGEMENT', source_subtype: 'AD_ENGAGEMENT', retention_in_days: 395 }],
    ['snapchat_create_profile_audience', { name: 'Profile audience', profile_id: PROFILE, engagement_type: 'ENGAGERS' }, { source_type: 'PROFILE_ENGAGEMENT', creation_spec: { engagement_type: 'ENGAGERS', source_profile_id: PROFILE }, retention_in_days: 180 }],
    ['snapchat_create_lookalike', { name: 'Lookalike', seed_segment_id: SEG, countries: ['US', 'CA'], type: 'SIMILARITY' }, { source_type: 'LOOKALIKE', creation_spec: { seed_segment_id: SEG, countries: ['US', 'CA'], type: 'SIMILARITY' }, retention_in_days: 180 }],
  ] as const)('builds documented native request for %s without launching delivery', async (tool, payload, expected) => {
    const { provider, calls } = fixture(segmentCreate), operation = op(tool, payload, 'create');
    expect((await provider.previewWrite(operation, guard)).serverValidated).toBe(false); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [SEG] });
    expect(writes(calls)[0]!.url.pathname).toBe(`/v1/adaccounts/${A}/segments`); expect(json(writes(calls)[0]!)).toMatchObject({ segments: [{ ad_account_id: A, ...expected }] });
  });
  it('preserves omitted metadata during native PUT and sends no read-only fields', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PUT' ? envelope('segments', 'segment', [{ ...segment, ...json(call).segments[0] }]) : undefined);
    await provider.applyWrite(op('snapchat_update_audience', { segment_id: SEG, name: 'Renamed' }), guard);
    expect(json(writes(calls)[0]!)).toEqual({ segments: [{ id: SEG, name: 'Renamed', description: segment.description, retention_in_days: 180, ad_account_id: A }] });
    expect(writes(calls)[0]!.init.headers).toMatchObject({ 'content-type': 'application/json' });
  });
  it.each(['PIXEL', 'SEED', 'CAMPAIGN', 'ACCOUNT', 'PROFILE', 'APP'])('rejects foreign %s before creating an audience', async type => {
    const { provider, calls } = fixture(call => type === 'SEED' && call.url.pathname === `/v1/segments/${SEG}` ? envelope('segments', 'segment', [{ ...segment, ad_account_id: 'other' }]) : type === 'CAMPAIGN' && call.url.pathname === `/v1/campaigns/${C}` ? envelope('campaigns', 'campaign', [{ id: C, ad_account_id: 'other' }]) : undefined);
    const operation = type === 'PIXEL' ? op('snapchat_create_website_audience', { name: 'New', pixel_id: 'other', events: ['PURCHASE'] }, 'create') : type === 'SEED' ? op('snapchat_create_lookalike', { name: 'New', seed_segment_id: SEG, countries: ['US'] }, 'create') : type === 'PROFILE' ? op('snapchat_create_profile_audience', { name: 'New', profile_id: 'other', engagement_type: 'ENGAGERS' }, 'create') : type === 'APP' ? op('snapchat_create_mobile_audience', { name: 'New', mobile_app_id: 'other', events: ['PURCHASE'] }, 'create') : op('snapchat_create_engagement_audience', { name: 'New', engagement_specs: [{ source_type: type === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_ACCOUNT', source_id: type === 'CAMPAIGN' ? C : 'other', engagement_type: 'PAID_IMPRESSIONS' }] }, 'create');
    await expect(provider.previewWrite(operation, guard)).rejects.toThrow(/not available|not owned|ownership|different account/); expect(writes(calls)).toEqual([]);
  });
  it('checks source-specific retention limits and wrong returned ownership before reporting success', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v1/segments/${SEG}` ? envelope('segments', 'segment', [{ ...segment, source_type: 'LOOKALIKE' }]) : undefined);
    await expect(provider.previewWrite(op('snapchat_update_audience', { segment_id: SEG, retention_in_days: 181 }), guard)).rejects.toThrow('retention'); expect(writes(calls)).toEqual([]);
    const wrong = fixture(call => call.init.method === 'POST' ? envelope('segments', 'segment', [{ id: SEG, ...json(call).segments[0], ad_account_id: 'other' }]) : undefined);
    await expect(wrong.provider.applyWrite(op('snapchat_create_customer_audience', { name: 'New' }, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [SEG] } });
  });
  it('uses native DELETE and rejects a failed deletion envelope', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'DELETE' ? { request_status: 'SUCCESS', segments: [] } : undefined);
    expect(await provider.applyWrite(op('snapchat_delete_audience', { segment_id: SEG }, 'remove'), guard)).toMatchObject({ resourceIds: [SEG] }); expect(writes(calls)[0]!.url.pathname).toBe(`/v1/segments/${SEG}`);
    const failed = fixture(call => call.init.method === 'DELETE' ? { request_status: 'ERROR', segments: [] } : undefined);
    await expect(failed.provider.applyWrite(op('snapchat_delete_audience', { segment_id: SEG }, 'remove'), guard)).rejects.toThrow('API request failed');
  });
});

describe('Snapchat audience identifiers', () => {
  const hashes = ['a'.repeat(64), 'b'.repeat(64)];
  it.each([false, true])('uses native one-key SHA-256 schema and count receipts, remove=%s', async remove => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/users') ? { request_status: 'SUCCESS', users: [{ sub_request_status: 'SUCCESS', user: { number_uploaded_users: 2 } }] } : undefined);
    const operation = op(remove ? 'snapchat_remove_audience_users' : 'snapchat_add_audience_users', { segment_id: SEG, schema: 'EMAIL_SHA256', hashes }, remove ? 'remove' : 'update');
    const preview = await provider.previewWrite(operation, guard); expect(JSON.stringify(preview)).not.toContain(hashes[0]); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [SEG], details: { uploaded_identifiers: 2 } });
    expect(writes(calls)[0]!.init.method).toBe(remove ? 'DELETE' : 'POST'); expect(json(writes(calls)[0]!)).toEqual({ users: [{ ...(remove ? { id: SEG } : {}), schema: ['EMAIL_SHA256'], data: hashes.map(h => [h]) }] });
  });
  it.each([{ hashes: ['person@example.com'] }, { hashes: ['a'.repeat(64), 'a'.repeat(64)] }, { hashes: ['A'.repeat(64)] }])('rejects raw, duplicated or unnormalized identifiers: %j', async invalid => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('snapchat_add_audience_users', { segment_id: SEG, schema: 'EMAIL_SHA256', hashes: invalid.hashes }), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it('rejects count mismatches and redacts hashes echoed in native errors', async () => {
    const { provider } = fixture(call => call.url.pathname.endsWith('/users') ? { request_status: 'SUCCESS', users: [{ sub_request_status: 'SUCCESS', user: { number_uploaded_users: 1 } }] } : undefined);
    await expect(provider.applyWrite(op('snapchat_add_audience_users', { segment_id: SEG, schema: 'EMAIL_SHA256', hashes }), guard)).rejects.toMatchObject({ details: { resource_ids: [SEG], received_count: 1 } });
    const failed = fixture(call => call.url.pathname.endsWith('/users') ? Response.json({ display_message: `Rejected ${hashes[0]} secret access` }, { status: 400 }) : undefined);
    try { await failed.provider.applyWrite(op('snapchat_add_audience_users', { segment_id: SEG, schema: 'EMAIL_SHA256', hashes }), guard); throw new Error('Expected failure'); } catch (error) { expect(JSON.stringify(error)).not.toContain(hashes[0]); expect((error as Error).message).toContain('[redacted hash]'); }
  });
  it('clears only an owned FIRST_PARTY audience via all_users and never substitutes deletion', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/all_users') ? envelope('segments', 'segment', [segment]) : undefined);
    await provider.applyWrite(op('snapchat_clear_audience_users', { segment_id: SEG }, 'remove'), guard); expect(writes(calls)[0]!.url.pathname).toBe(`/v1/segments/${SEG}/all_users`); expect(writes(calls)[0]!.init.method).toBe('DELETE');
    const event = fixture(call => call.url.pathname === `/v1/segments/${SEG}` ? envelope('segments', 'segment', [{ ...segment, source_type: 'PIXEL' }]) : undefined);
    await expect(event.provider.previewWrite(op('snapchat_clear_audience_users', { segment_id: SEG }, 'remove'), guard)).rejects.toThrow('FIRST_PARTY'); expect(writes(event.calls)).toEqual([]);
  });
});

describe('Snapchat measurement setup', () => {
  it('offers documented pixel reads/rename and does not invent a Pixel creation API', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PUT' ? envelope('pixels', 'pixel', [{ ...pixel, ...json(call).pixels[0] }]) : undefined);
    expect(snapchatTools(provider).map(t => t.name)).not.toContain('snapchat_create_pixel'); expect((await provider.management.pixels(A)).setup_note).toContain('Ads Manager');
    await provider.applyWrite(op('snapchat_rename_pixel', { pixel_id: PIXEL, name: 'New name' }), guard); expect(json(writes(calls)[0]!)).toEqual({ pixels: [{ id: PIXEL, name: 'New name', ad_account_id: A }] });
    const shared = fixture(call => call.url.pathname.endsWith('/pixels') ? envelope('pixels', 'pixel', [{ ...pixel, ad_account_id: 'other' }]) : undefined);
    await expect(shared.provider.previewWrite(op('snapchat_rename_pixel', { pixel_id: PIXEL, name: 'New name' }), guard)).rejects.toThrow('owned'); expect(writes(shared.calls)).toEqual([]);
  });
  it('associates measurement with a verified child while preserving other event-source dimensions', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? envelope('adsquads', 'adsquad', [{ ...group, pixel_id: PIXEL, event_sources: { future_source: ['existing'], MOBILE_APP: [APP] } }]) : undefined);
    await provider.applyWrite(op('snapchat_set_adsquad_measurement', { ad_squad_id: G, pixel_id: PIXEL, mobile_app_id: APP }), guard);
    expect(writes(calls)[0]!.url.pathname).toBe(`/v1/campaigns/${C}/adsquads/${G}`); expect(json(writes(calls)[0]!)).toEqual([{ op: 'add', path: '/pixel_id', value: PIXEL }, { op: 'replace', path: '/event_sources', value: { future_source: ['existing'], MOBILE_APP: [APP] } }]);
  });
  it('creates typed custom conversion rules and accepts reordered native event-source keys', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? envelope('custom_conversions', 'custom_conversion', [{ id: custom.id, ...json(call).custom_conversions[0], event_source: { type: 'PIXEL', id: PIXEL } }]) : undefined);
    await provider.applyWrite(op('snapchat_create_custom_conversion', { name: custom.name, source_type: 'PIXEL', source_id: PIXEL, event_type: 'PURCHASE', rules: custom.rules }, 'create'), guard);
    expect(writes(calls)[0]!.url.pathname).toBe(`/v1/pixels/${PIXEL}/custom_conversions`); expect(json(writes(calls)[0]!)).toEqual({ custom_conversions: [{ name: custom.name, event_type: 'PURCHASE', rules: custom.rules }] });
  });
  it.each([{ key: 'PRICE', values: ['12'], operator: 'GREATER_THAN' }, { key: 'CUSTOMER_STATUS', values: ['new'], operator: 'GREATER_THAN' }])('rejects invalid rule types before creating a conversion: %j', async rule => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('snapchat_create_custom_conversion', { name: 'New', source_type: 'PIXEL', source_id: PIXEL, event_type: 'PURCHASE', rules: [rule] }, 'create'), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it('reads source-bound rules and rejects a foreign source in a successful envelope', async () => {
    const { provider } = fixture(call => call.url.pathname.endsWith('/custom_conversions') ? envelope('custom_conversions', 'custom_conversion', [custom]) : undefined);
    expect((await provider.management.conversions({ account_id: A, source_type: 'PIXEL', source_id: PIXEL, limit: 50 })).items).toHaveLength(1);
    const wrong = fixture(call => call.url.pathname.endsWith('/custom_conversions') ? envelope('custom_conversions', 'custom_conversion', [{ ...custom, event_source: { id: 'other', type: 'PIXEL' } }]) : undefined);
    await expect(wrong.provider.management.conversions({ account_id: A, source_type: 'PIXEL', source_id: PIXEL, limit: 50 })).rejects.toThrow('source mismatch');
  });
  it('deletes only a custom conversion whose Pixel is owned by this account', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v1/custom_conversions/${custom.id}` ? call.init.method === 'GET' ? envelope('custom_conversions', 'custom_conversion', [custom]) : { request_status: 'SUCCESS', custom_conversions: [] } : undefined);
    await provider.applyWrite(op('snapchat_delete_custom_conversion', { custom_conversion_id: custom.id }, 'remove'), guard); expect(writes(calls)[0]!.init.method).toBe('DELETE');
    const app = fixture(call => call.url.pathname.startsWith('/v1/custom_conversions/') ? envelope('custom_conversions', 'custom_conversion', [{ ...custom, event_source: { id: APP, type: 'MOBILE_APP' } }]) : undefined);
    await expect(app.provider.previewWrite(op('snapchat_delete_custom_conversion', { custom_conversion_id: custom.id }, 'remove'), guard)).rejects.toThrow('shared resources'); expect(writes(app.calls)).toEqual([]);
  });
  it('verifies audience-size account hierarchy and native lower/upper bounds', async () => {
    const { provider } = fixture(call => call.url.pathname.endsWith('/audience_size_v2') ? { request_status: 'SUCCESS', audience_size: { ad_squad_id: G, audience_size_minimum: 100, audience_size_maximum: 200 } } : undefined);
    expect(await provider.management.audienceSize(A, G)).toMatchObject({ audience_size_minimum: 100, audience_size_maximum: 200 });
    const wrong = fixture(call => call.url.pathname.endsWith('/audience_size_v2') ? { request_status: 'SUCCESS', audience_size: { audience_size_minimum: 200, audience_size_maximum: 100 } } : undefined);
    await expect(wrong.provider.management.audienceSize(A, G)).rejects.toThrow('bounds');
  });
});
