import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { SpotifyAdsClient, SPOTIFY_TOKEN_URL } from '../src/client.js';
import { SpotifyAdsProvider } from '../src/provider.js';
import { spotifyTools } from '../src/tools.js';
import { createAudience, createReport } from '../src/management-tools.js';

// Wire contracts: Spotify's official live v3 OpenAPI, fetched 2026-11-03.
const A = '10000000-0000-4000-8000-000000000001', B = '10000000-0000-4000-8000-000000000002', C = '10000000-0000-4000-8000-000000000003';
const guard = { forcePausedCreation: true };
type Call = { url: URL; init: RequestInit };
function fixture(handler: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new SpotifyAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === SPOTIFY_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const result = handler(call); return result instanceof Response ? result : Response.json(result);
  });
  return { provider: new SpotifyAdsProvider(client), calls };
}
function op(tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'create'): WriteOperation { return { tool, provider: 'spotify', accountId: A, kind, payload }; }
const writes = (calls: Call[]) => calls.filter(c => c.init.method !== 'GET' && c.url.href !== SPOTIFY_TOKEN_URL);
const body = (call: Call) => JSON.parse(String(call.init.body));

describe('Spotify native audiences and exports', () => {
  it('constructs all shared tool definitions without touching a provider or duplicating names', () => {
    const provider = new Proxy({} as SpotifyAdsProvider, { get() { throw new Error('Provider access during schema construction'); } });
    const tools = spotifyTools(provider), names = tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length); expect(names).toContain('spotify_create_audience'); expect(names).toContain('spotify_insight_report');
  });
  it('creates engagement audiences from an account-owned campaign with the documented discriminator', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'GET' ? { id: B, ad_account_id: A } : { id: C, name: 'QA audience', type: 'CUSTOM' });
    const operation = op('spotify_create_audience', { name: 'QA audience', subtype: 'AD_ENGAGEMENT', campaign_ids: [B], lookback_days: 30, exposure_type: 'CLICKS' });
    await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]);
    await provider.applyWrite(operation, guard);
    const write = writes(calls)[0]!; expect(write.url.pathname).toBe(`/ads/v3/ad_accounts/${A}/audiences`);
    expect(body(write)).toEqual({ ...operation.payload, audience_type: 'CUSTOM' });
  });
  it('rejects a foreign campaign before any audience is created', async () => {
    const { provider, calls } = fixture(() => ({ id: B, ad_account_id: C }));
    await expect(provider.applyWrite(op('spotify_create_audience', { name: 'QA audience', subtype: 'AD_ENGAGEMENT', campaign_ids: [B], lookback_days: 30, exposure_type: 'CLICKS' }), guard)).rejects.toThrow('another account');
    expect(writes(calls)).toEqual([]);
  });
  it('proves ownership through the account collection when native campaign metadata has a null account ID', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/campaigns/${B}`) ? { id: B, ad_account_id: null } : { paging: { offset: 0, total_results: 1 }, campaigns: [{ id: B, ad_account_id: null }] });
    expect((await provider.creatives.get(A, 'campaigns', B, false)).id).toBe(B);
    expect(calls.at(-1)!.url.pathname).toBe(`/ads/v3/ad_accounts/${A}/campaigns`);
    expect(writes(calls)).toEqual([]);
  });
  it('rejects a null-account campaign absent from the selected account collection', async () => {
    const { provider } = fixture(call => call.url.pathname.endsWith(`/campaigns/${B}`) ? { id: B, ad_account_id: null } : { paging: { offset: 0, total_results: 1 }, campaigns: [{ id: C, ad_account_id: null }] });
    await expect(provider.creatives.get(A, 'campaigns', B, false)).rejects.toThrow('not present');
  });
  it('requires web-event datasets to appear in the account’s eligible list', async () => {
    const { provider, calls } = fixture(() => ({ datasets: [], paging: { offset: 0, total_results: 0 } }));
    await expect(provider.applyWrite(op('spotify_create_audience', { name: 'QA audience', subtype: 'WEB_EVENT', dataset_ids: [B], included_events: ['PURCHASE'], lookback_days: 30 }), guard)).rejects.toThrow('eligible');
    expect(writes(calls)).toEqual([]);
  });
  it('keeps existing seed ownership and native LOOKALIKE type in a new audience', async () => {
    const { provider, calls } = fixture(call => ({ id: call.init.method === 'GET' ? B : C, name: 'QA audience', type: call.init.method === 'GET' ? 'CUSTOM' : 'LOOKALIKE', ad_account_id: A }));
    await provider.applyWrite(op('spotify_create_lookalike_audience', { name: 'QA audience', seed_audience_id: B }), guard);
    expect(body(writes(calls)[0]!)).toEqual({ name: 'QA audience', seed_audience_id: B, audience_type: 'LOOKALIKE' });
  });
  it('preserves the current audience type and sends only requested metadata on PATCH', async () => {
    const { provider, calls } = fixture(() => ({ id: B, name: 'New name', type: 'LOOKALIKE' }));
    await provider.applyWrite(op('spotify_update_audience', { audience_id: B, name: 'New name' }, 'update'), guard);
    expect(body(writes(calls)[0]!)).toEqual({ audience_type: 'LOOKALIKE', name: 'New name' });
    expect(writes(calls)[0]!.init.method).toBe('PATCH');
  });
  it('does not claim deletion when Spotify confirms zero removed audiences', async () => {
    const { provider } = fixture(call => call.init.method === 'GET' ? { id: B, name: 'QA audience', type: 'CUSTOM' } : { deletion_count: 0 });
    await expect(provider.applyWrite(op('spotify_delete_audience', { audience_id: B }, 'remove'), guard)).rejects.toThrow('one removed record');
  });
  it('rejects customer-list upload payloads and ambiguous engagement sources', () => {
    expect(createAudience.safeParse({ name: 'QA audience', subtype: 'CUSTOMER_LIST', lookback_days: 30 }).success).toBe(false);
    expect(createAudience.safeParse({ name: 'QA audience', subtype: 'AD_ENGAGEMENT', campaign_ids: [B], ad_set_ids: [C], lookback_days: 30, exposure_type: 'CLICKS' }).success).toBe(false);
  });
  it('passes native missing/suppressed insight fields through without inventing conversions', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith(`/ad_sets/${B}`) ? { id: B, campaign_id: C } : call.url.pathname.endsWith(`/campaigns/${C}`) ? { id: C, ad_account_id: A } : { rows: [{ stats: [{ field_type: 'CLICKS', field_value: 4 }] }] });
    const result = await provider.management.insights({ account_id: A, ad_set_id: B, fields: ['CLICKS', 'PURCHASES'], insight_dimension: 'PLATFORM' });
    expect(result).toEqual({ rows: [{ stats: [{ field_type: 'CLICKS', field_value: 4 }] }] });
    expect(calls.at(-1)!.url.searchParams.getAll('fields')).toEqual(['CLICKS', 'PURCHASES']);
    expect(calls.at(-1)!.url.searchParams.getAll('entity_ids')).toEqual([B]); expect(calls.at(-1)!.url.searchParams.get('entity_ids_type')).toBe('AD_SET');
  });
  it('previews an export without submitting a job and then uses native POST fields and receipt ID', async () => {
    const { provider, calls } = fixture(() => ({ id: B }));
    const operation = op('spotify_create_report', { name: 'QA_export', granularity: 'LIFETIME', dimensions: ['AD_ACCOUNT_NAME'], metrics: ['SPEND'] });
    await provider.previewWrite(operation, guard); expect(calls).toEqual([]);
    expect(await provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [B] });
    expect(writes(calls)[0]!.url.pathname).toBe(`/ads/v3/ad_accounts/${A}/async_reports`);
    expect(body(writes(calls)[0]!)).toEqual(operation.payload);
  });
  it('rejects incomplete daily dates, reversed ranges and dated insight exports', () => {
    const base = { name: 'QA_export', granularity: 'DAY', dimensions: ['AD_ACCOUNT_NAME'], metrics: ['SPEND'] };
    expect(createReport.safeParse(base).success).toBe(false);
    expect(createReport.safeParse({ ...base, report_start: '2026-11-02T00:00:00Z', report_end: '2026-11-01T00:00:00Z' }).success).toBe(false);
    expect(createReport.safeParse({ ...base, granularity: 'LIFETIME', insight_dimension: 'PLATFORM', report_start: '2026-11-01T00:00:00Z' }).success).toBe(false);
  });
  it('retains Unicode report names and rejects invalid punctuation independently of exported JSON Schema patterns', () => {
    const base = { granularity: 'LIFETIME', dimensions: ['AD_ACCOUNT_NAME'], metrics: ['SPEND'] };
    expect(createReport.parse({ ...base, name: '  Übersicht 日本語 2026  ' }).name).toBe('Übersicht 日本語 2026');
    for (const name of ['a', 'a'.repeat(121), 'invalid/name', 'invalid.name', 'invalid\nname']) expect(createReport.safeParse({ ...base, name }).success).toBe(false);
  });
});
