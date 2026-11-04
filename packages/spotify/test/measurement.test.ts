import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type WriteOperation } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { SpotifyAdsClient } from '../src/client.js';
import { SpotifyAdsProvider } from '../src/provider.js';
import { spotifyTools } from '../src/tools.js';

const A = '8e4fe0d2-88aa-42f0-ac90-1ab694b6344c', B = '11111111-1111-4111-8111-111111111111', F = '99999999-9999-4999-8999-999999999999';
const D = '22222222-2222-4222-8222-222222222222', N = '33333333-3333-4333-8333-333333333333', I = '44444444-4444-4444-8444-444444444444';
const C = '55555555-5555-4555-8555-555555555555', CI = '66666666-6666-4666-8666-666666666666', M = '77777777-7777-4777-8777-777777777777', P = 'cd2f1480ba3d4f9b9c5a39893c0def91';
const PIXEL = { id: P, integration_id: I, dataset_id: D, name: 'QA Pixel', domain: 'https://example.com', aam_opt_in: false, aam_fields: [], cookie_opt_in: false, events_received: [] };
const CAPI = { capi_connection_id: C, integration_id: CI, dataset_id: D, name: 'QA CAPI', events_received: [], access_token: 'native-capi-secret-must-not-escape' };
const APP = { id: M, name: 'QA Mobile', platform: 'IOS', platform_app_id: '123456789', mobile_measurement_partner: 'SINGULAR', shared_ad_accounts: [{ id: A, name: 'Selected' }], link_token: 'native-link-secret-must-not-escape' };
type Row = Record<string, unknown>;
type Options = { empty?: boolean; foreignShares?: boolean; missingShares?: boolean; missingPaging?: boolean; nullPixelMetadata?: boolean; nullPixelBindingOnRead?: boolean; pixelMatchingEnabled?: boolean; pixelMatchingUnknown?: boolean; badIdentity?: boolean; shareFailure?: boolean; updateIgnored?: boolean; readbackDenied?: boolean; postDenied?: boolean; corruptRouting?: boolean; retainDatasetSource?: boolean; datasetResponse?: Row; mobileResponse?: Row; diagnosticResponse?: Row };
function fixture(options: Options = {}) {
  const pixels = new Map<string, Row>(), capis = new Map<string, Row>(), apps = new Map<string, Row>(), datasets = new Map<string, Row>();
  if (!options.empty) {
    pixels.set(P, structuredClone(PIXEL));capis.set(C, structuredClone(CAPI));apps.set(M, structuredClone(APP));
    const shares = options.missingShares ? undefined : [{ id: A, name: 'Selected' }, ...(options.foreignShares ? [{ id: F, name: 'Foreign private account' }] : [])];
    datasets.set(D, { id: D, name: 'QA Dataset', pixel: pixels.get(P), capi_integration: capis.get(C), shared_ad_accounts: shares, ad_set_count: 0, is_archived: false, is_receiving_events: false });
    apps.get(M)!.shared_ad_accounts = shares;
  }
  let business = B, written = false;
  const calls: Array<{ url: URL; method: string; headers: Headers; body: Row | undefined }> = [];
  const client = new SpotifyAdsClient({ clientId: 'inert-client', clientSecret: 'inert-client-secret', refreshToken: 'inert-refresh' }, (async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET', body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) as Row : undefined;
    calls.push({ url, method, headers: new Headers(init.headers), body });
    if (url.hostname === 'accounts.spotify.com') return Response.json({ access_token: 'inert-access', expires_in: 3600 });
    const path = url.pathname.replace('/ads/v3/', ''), base = `businesses/${B}`;
    if (path === `ad_accounts/${A}`) return Response.json({ id: options.badIdentity ? F : A, business_id: business });
    if (method !== 'GET' && options.postDenied) return Response.json({ messages: ['Permission denied'] }, { status: 403 });
    if (method === 'GET' && written && options.readbackDenied) return Response.json({}, { status: 403 });
    if (path === `${base}/ad_accounts/${A}/datasets` && method === 'GET') {
      const rows = [...datasets.values()].filter(d => !Array.isArray(d.shared_ad_accounts) || (d.shared_ad_accounts as Row[]).some(a => a.id === A));
      return Response.json(options.datasetResponse ?? { datasets: rows, ...(options.missingPaging ? {} : { paging: { offset: 0, total_results: rows.length } }) });
    }
    if (path === `${base}/ad_accounts/${A}/mobile_apps` && method === 'GET') {
      const rows = [...apps.values()].filter(d => !Array.isArray(d.shared_ad_accounts) || (d.shared_ad_accounts as Row[]).some(a => a.id === A)), offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      return Response.json(options.mobileResponse ?? { mobile_apps: rows.slice(offset, offset + limit), paging: { offset, total_results: rows.length } });
    }
    if (path === `${base}/pixels` && method === 'POST') {
      written = true;const datasetId = String(body!.dataset_id ?? N), pixel = { ...PIXEL, ...body, dataset_id: options.corruptRouting ? null : datasetId, ...(options.nullPixelMetadata ? { integration_id: null, aam_fields: null, auto_capture_fields: null, events_received: null } : {}), ...(options.pixelMatchingEnabled ? { aam_opt_in: true } : {}), ...(options.pixelMatchingUnknown ? { aam_opt_in: null } : {}) };pixels.set(P, pixel);
      const dataset = datasets.get(datasetId) ?? { id: datasetId, name: 'Native auto dataset', shared_ad_accounts: [], ad_set_count: 0 };dataset.pixel = pixel;datasets.set(datasetId, dataset);
      return Response.json(pixel, { status: 201 });
    }
    if (path === `${base}/capi` && method === 'POST') {
      written = true;const datasetId = String(body!.dataset_id ?? N), capi = { ...CAPI, ...body, dataset_id: datasetId };capis.set(C, capi);
      const dataset = datasets.get(datasetId) ?? { id: datasetId, name: 'Native auto dataset', shared_ad_accounts: [], ad_set_count: 0 };dataset.capi_integration = capi;datasets.set(datasetId, dataset);
      return Response.json(capi, { status: 201 });
    }
    if (path === `${base}/mobile_apps` && method === 'POST') { written = true;const app = { ...APP, ...(body!.mobile_app as Row), shared_ad_accounts: [] };apps.set(M, app);return Response.json(app, { status: 201 }); }
    if (path === `${base}/datasets` && method === 'POST') {
      written = true;const created: Row = { id: N, name: body!.name, shared_ad_accounts: [], ad_set_count: 0 };
      for (const integration of body!.integration_ids as string[]) for (const dataset of datasets.values()) for (const key of ['pixel', 'capi_integration']) {
        const member = dataset[key] as Row | null | undefined;
        if (member && member.integration_id === integration) { member.dataset_id = N;created[key] = member;if (!options.retainDatasetSource) dataset[key] = null; }
      }
      datasets.set(N, created);return Response.json(created, { status: 201 });
    }
    const share = path.match(/^businesses\/([^/]+)\/(datasets|mobile_apps)\/([^/]+)\/ad_accounts\/([^/]+)$/);
    if (share && method !== 'GET') {
      written = true;const row = (share[2] === 'datasets' ? datasets : apps).get(share[3]!)!;
      row.shared_ad_accounts = [...(row.shared_ad_accounts as Row[]).filter(a => a.id !== share[4]), ...(method === 'POST' ? [{ id: share[4], name: 'Selected' }] : [])];
      return options.shareFailure ? Response.json({}, { status: 503 }) : new Response(null, { status: 204 });
    }
    const removed = path.match(/^businesses\/([^/]+)\/datasets\/([^/]+)\/integrations\/([^/]+)$/);
    if (removed && method === 'DELETE') {
      written = true;const previous = datasets.get(removed[2]!)!, created: Row = { id: N, name: 'Native moved dataset', shared_ad_accounts: [], ad_set_count: 0 };
      for (const key of ['pixel', 'capi_integration']) { const member = previous[key] as Row | null | undefined;if (member && member.integration_id === removed[3]) { member.dataset_id = N;created[key] = member;previous[key] = null; } }
      datasets.set(N, created);return Response.json(created);
    }
    const diagnostics = path.match(/^businesses\/([^/]+)\/datasets\/([^/]+)\/diagnostics$/);
    if (diagnostics) return Response.json(options.diagnosticResponse ?? { dataset_id: diagnostics[2], datasources: [{ datasource_type: 'PIXEL', datasource_id: P, granularity: 'DAILY', timeseries: [{ timestamp: 0, total: 0, event_counts: [{ name: 'VIEW', event_count: 0 }] }] }] });
    const resource = path.match(/^businesses\/([^/]+)\/(datasets|pixels|capi|mobile_apps)\/([^/]+)$/);
    if (resource) {
      const store = resource[2] === 'datasets' ? datasets : resource[2] === 'pixels' ? pixels : resource[2] === 'capi' ? capis : apps, row = store.get(resource[3]!);
      if (!row) return Response.json({}, { status: 404 });
      if (method === 'PATCH') { written = true;if (!options.updateIgnored) Object.assign(row, body); }
      return Response.json(options.nullPixelBindingOnRead && resource[2] === 'pixels' && method === 'GET' ? { ...row, dataset_id: null } : row);
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  }) as typeof fetch);
  const provider = new SpotifyAdsProvider(client), tools = spotifyTools(provider);
  const op = (name: string, input: Row): WriteOperation => {
    const { account_id, ...payload } = tools.find(t => t.name === name)!.input.parse({ account_id: A, ...input }) as Row;
    return { provider: 'spotify', accountId: String(account_id), tool: name, kind: name.startsWith('spotify_create') ? 'create' : name.includes('remove') ? 'remove' : 'update', payload };
  };
  const native = () => calls.filter(c => c.url.hostname === 'api-partner.spotify.com'), writes = () => native().filter(c => c.method !== 'GET');
  return { client, provider, tools, op, calls, native, writes, datasets, pixels, capis, apps, moveBusiness: (id: string) => { business = id; } };
}
const guard = { forcePausedCreation: true };
const details = (value: Awaited<ReturnType<SpotifyAdsProvider['applyWrite']>>) => value.details as { resource_receipt: string };

// Current official Spotify v3 OpenAPI SHA2561ea6ac0, fetched2026-11-05. Native ownership, payloads and receipt boundaries, not mock-only success assertions.
describe('Spotify account-scoped measurement resources', () => {
  it('uses the selected account’s native business and unpaged account dataset endpoint', async () => {
    const f = fixture(), result = await f.provider.measurement.context(A);
    expect(result).toMatchObject({ account_id: A, business_id: B, complete: true, truncated: false });
    expect(f.native().map(c => c.url.pathname)).toEqual([`/ads/v3/ad_accounts/${A}`, `/ads/v3/businesses/${B}/ad_accounts/${A}/datasets`]);expect(f.native()[1]!.url.search).toBe('');
    expect(f.native().every(c => c.headers.get('authorization') === 'Bearer inert-access')).toBe(true);expect(f.writes()).toHaveLength(0);
    expect(result.datasets[0]).not.toHaveProperty('configuration_hash');
  });
  it('redacts other account identities, active CAPI values and MMP link tokens from all read projections', async () => {
    const f = fixture({ foreignShares: true }), context = await f.provider.measurement.context(A), mobile = await f.provider.measurement.getMobile({ account_id: A, mobile_app_id: M }), capi = await f.provider.measurement.getCapi({ account_id: A, dataset_id: D });
    expect(context.datasets[0]).toMatchObject({ other_shared_account_count: 1, shared_ad_accounts: [{ id: A }] });
    const text = JSON.stringify({ context, mobile, capi });expect(text).not.toMatch(/native-capi-secret|native-link-secret|Foreign private account/);expect(text).not.toContain(F);
  });
  it('returns native unknown completeness without inventing pagination or zero rows', async () => {
    const f = fixture({ missingPaging: true });expect(await f.provider.measurement.datasets(A)).toMatchObject({ complete: null, truncated: true });
    expect((await f.provider.measurement.datasets(A)).datasets).toHaveLength(1);expect(f.native().every(c => !c.url.search)).toBe(true);
  });
  it.each([{ datasets: [] }, { datasets: [{ id: D }] }])('preserves dataset rows when native paging is null: %j', async ({ datasets }) => {
    const f = fixture({ datasetResponse: { datasets, paging: null } });
    const result = await f.provider.measurement.context(A);
    expect(result).toMatchObject({ complete: null, truncated: true, paging: null });
    expect(result.datasets.map(row => row.id)).toEqual(datasets.map(row => row.id));
    expect(f.native().every(call => !call.url.search)).toBe(true);
    expect(f.writes()).toHaveLength(0);
  });
  it('preserves nullable inventory statistics and activity without converting them to zero or false', async () => {
    const f = fixture({ datasetResponse: { datasets: [{ id: D, name: null, ad_set_count: null, is_receiving_lead_events: null }], paging: null } });
    const result = await f.provider.measurement.context(A);
    expect(result).toMatchObject({ complete: null, datasets: [{ id: D, name: null, ad_set_count: null, is_receiving_lead_events: null }] });
    expect(f.writes()).toHaveLength(0);
  });
  it.each([{ datasetResponse: { datasets: [], paging: { offset: 1, total_results: 0 } } }, { datasetResponse: { datasets: [{ id: D }, { id: D }], paging: { offset: 0, total_results: 2 } } }, { badIdentity: true }])('rejects inconsistent native inventory/account identities: %o', async options => {
    await expect(fixture(options).provider.measurement.context(A)).rejects.toThrow(/spotify:/);
  });
  it('rejects an unshared arbitrary business dataset before revealing its contents', async () => {
    const f = fixture();f.datasets.get(D)!.shared_ad_accounts = [{ id: F, name: 'Private' }];
    await expect(f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).rejects.toThrow('not shared');expect(f.writes()).toHaveLength(0);
  });
  it('preserves native null Pixel metadata and does not invent an integration or activity', async () => {
    const f = fixture();Object.assign(f.pixels.get(P)!, { integration_id: null, aam_fields: null, auto_capture_fields: null, events_received: null });
    expect((await f.provider.measurement.getPixel({ account_id: A, dataset_id: D })).pixel).toMatchObject({ id: P, integration_id: null, aam_opt_in: false, aam_fields: null, auto_capture_fields: null, events_received: null });
    expect(f.writes()).toHaveLength(0);
  });
  it('keeps null sharing unknown and rejects metadata edits without verified exclusivity', async () => {
    const f = fixture();f.datasets.get(D)!.shared_ad_accounts = null;
    const current = (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    expect(current).toMatchObject({ shared_ad_accounts: null, other_shared_account_count: null });
    await expect(f.provider.previewWrite(f.op('spotify_update_dataset', { dataset_id: D, expected_configuration_hash: current.configuration_hash, name: 'Changed' }), guard)).rejects.toThrow('restricted');
    expect(f.writes()).toHaveLength(0);
  });
  it('verifies AAM-off creation with native null optional fields and no duplicate POST', async () => {
    const f = fixture({ empty: true, nullPixelMetadata: true });
    const result = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA Pixel', domain: 'https://example.com' }), guard);
    expect(result).toMatchObject({ applied: true, resourceIds: [P, N] });
    expect(f.writes()).toHaveLength(2);
    expect(f.writes().filter(call => call.url.pathname.endsWith('/pixels'))).toHaveLength(1);
    expect(await f.provider.measurement.created({ account_id: A, resource_receipt: details(result).resource_receipt })).toMatchObject({ pixel: { aam_opt_in: false, aam_fields: null, integration_id: null } });
  });
  it.each(['enabled', 'unknown'])('never treats null fields as verified AAM-off when native matching is %s', async matching => {
    const f = fixture({ empty: true, nullPixelMetadata: true, ...(matching === 'enabled' ? { pixelMatchingEnabled: true } : { pixelMatchingUnknown: true }) });
    await expect(f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA Pixel', domain: 'https://example.com' }), guard)).rejects.toThrow('unconfirmed');
    expect(f.writes()).toHaveLength(1);
  });
  it('never follows an explicitly conflicting Pixel binding', async () => {
    const f = fixture({ empty: true });
    const result = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA Pixel', domain: 'https://example.com' }), guard);
    f.pixels.get(P)!.dataset_id = F;
    const before = f.native().length;
    const read = await f.provider.measurement.created({ account_id: A, resource_receipt: details(result).resource_receipt });
    expect(read).toMatchObject({ pixel: { id: P, dataset_id: F }, dataset: null, needs_dataset_sharing: null,
      dataset_binding: { expected_dataset_id: N, observed_dataset_id: F, matches_receipt: false, verified_dataset_id: null } });
    expect(f.native().slice(before).map(call => call.url.pathname)).toEqual([`/ads/v3/ad_accounts/${A}`, `/ads/v3/businesses/${B}/pixels/${P}`]);
    await expect(f.provider.measurement.getPixel({ account_id: A, dataset_id: N })).rejects.toThrow('binding mismatch');
    expect(f.writes()).toHaveLength(2);
  });
  it('independently verifies only the receipt-locked parent when native Pixel binding is null', async () => {
    const f = fixture({ empty: true });
    const result = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA Pixel', domain: 'https://example.com' }), guard);
    f.pixels.get(P)!.dataset_id = null;const before = f.native().length;
    const read = await f.provider.measurement.created({ account_id: A, resource_receipt: details(result).resource_receipt });
    expect(read).toMatchObject({ pixel: { id: P, dataset_id: null }, dataset: { id: N }, needs_dataset_sharing: false,
      dataset_binding: { observed_dataset_id: null, matches_receipt: false, verified_dataset_id: N, verification_source: 'dataset' } });
    expect(f.native().slice(before).map(call => call.url.pathname)).toEqual([`/ads/v3/ad_accounts/${A}`, `/ads/v3/businesses/${B}/pixels/${P}`, `/ads/v3/businesses/${B}/datasets/${N}`]);
    const current = await f.provider.measurement.getPixel({ account_id: A, dataset_id: N });
    await f.provider.applyWrite(f.op('spotify_update_pixel', { dataset_id: N, expected_configuration_hash: current.pixel.configuration_hash, name: 'Renamed QA' }), guard);
    expect(f.writes().at(-1)).toMatchObject({ method: 'PATCH', body: { name: 'Renamed QA' } });
  });
  it('completes one Pixel creation using the native POST parent and independently verified reverse edge', async () => {
    const f = fixture({ empty: true, nullPixelMetadata: true, nullPixelBindingOnRead: true });
    const result = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA Pixel', domain: 'https://example.com' }), guard);
    expect(result).toMatchObject({ applied: true, resourceIds: [P, N] });
    expect(f.writes()).toHaveLength(2);
    expect(await f.provider.measurement.created({ account_id: A, resource_receipt: details(result).resource_receipt })).toMatchObject({ pixel: { dataset_id: null }, dataset: { id: N }, dataset_binding: { observed_dataset_id: null, verified_dataset_id: N, verification_source: 'dataset' } });
  });
  it('verifies CAPI through its owned parent while preserving a null child binding', async () => {
    const f = fixture();f.capis.get(C)!.dataset_id = null;
    const current = await f.provider.measurement.getCapi({ account_id: A, dataset_id: D });
    expect(current).toMatchObject({ capi_integration: { dataset_id: null }, dataset_binding: { verified_dataset_id: D, verification_source: 'dataset' } });
    expect(JSON.stringify(current)).not.toContain('native-capi-secret');
    await f.provider.applyWrite(f.op('spotify_update_capi_integration', { dataset_id: D, expected_configuration_hash: current.capi_integration.configuration_hash, name: 'Renamed CAPI' }), guard);
    expect(f.writes()).toHaveLength(1);expect(f.writes()[0]).toMatchObject({ method: 'PATCH', body: { name: 'Renamed CAPI' } });
  });
  it.each(['missing_edge', 'missing_parent'])('keeps the exact child readable but rejects unverified null binding: %s', async failure => {
    const f = fixture({ empty: true });
    const result = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA Pixel', domain: 'https://example.com' }), guard);
    f.pixels.get(P)!.dataset_id = null;
    if (failure === 'missing_parent') f.datasets.delete(N);
    else f.datasets.get(N)!.pixel = { id: 'foreign-pixel', name: 'Foreign resource must not escape' };
    const read = await f.provider.measurement.created({ account_id: A, resource_receipt: details(result).resource_receipt });
    expect(read).toMatchObject({ pixel: { id: P, dataset_id: null }, dataset: null, needs_dataset_sharing: null, dataset_binding: { verified_dataset_id: null } });
    expect(JSON.stringify(read)).not.toContain('Foreign resource');
    expect(f.writes()).toHaveLength(2);
  });
  it('does not authorize business-wide metadata updates for a multi-account shared resource', async () => {
    const f = fixture({ foreignShares: true }), current = (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    await expect(f.provider.previewWrite(f.op('spotify_update_dataset', { dataset_id: D, expected_configuration_hash: current.configuration_hash, name: 'Changed' }), guard)).rejects.toThrow('restricted to this selected account');expect(f.writes()).toHaveLength(0);
  });
  it('uses the account collection to prove membership when native resource GET omits sharing', async () => {
    const f = fixture({ missingShares: true });
    expect(await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).toHaveProperty('dataset.id', D);
    expect(await f.provider.measurement.getMobile({ account_id: A, mobile_app_id: M })).toHaveProperty('mobile_app.id', M);
    expect(f.native().some(c => c.url.pathname.endsWith(`/ad_accounts/${A}/mobile_apps`))).toBe(true);
  });
  it('creates a Pixel with explicit AAM-off wire fields, shares only with this account and verifies both steps', async () => {
    const f = fixture({ empty: true }), operation = f.op('spotify_create_pixel', { name: 'Private QA Pixel', domain: 'https://example.com' });
    const preview = await f.provider.previewWrite(operation, guard);expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [] });expect(f.writes()).toHaveLength(0);
    const result = await f.provider.applyWrite(operation, guard), writes = f.writes();expect(result).toMatchObject({ applied: true, resourceIds: [P, N] });
    expect(writes).toHaveLength(2);expect(writes[0]).toMatchObject({ method: 'POST', body: { name: 'Private QA Pixel', domain: 'https://example.com', aam_opt_in: false, aam_fields: [] } });expect(writes[0]!.url.pathname).toBe(`/ads/v3/businesses/${B}/pixels`);
    expect(writes[1]!.url.pathname).toBe(`/ads/v3/businesses/${B}/datasets/${N}/ad_accounts/${A}`);expect(writes[1]!.body).toBeUndefined();expect(writes[1]!.headers.has('content-type')).toBe(false);
    expect(await f.provider.measurement.created({ account_id: A, resource_receipt: details(result).resource_receipt })).toMatchObject({ needs_dataset_sharing: false, dataset: { id: N, shared_ad_accounts: [{ id: A }] } });
  });
  it('adds CAPI to an existing authorized dataset without issuing credentials or creating another dataset', async () => {
    const f = fixture();f.datasets.get(D)!.capi_integration = null;f.capis.clear();const current = (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    const result = await f.provider.applyWrite(f.op('spotify_create_capi_integration', { name: 'QA CAPI new', dataset_id: D, expected_dataset_configuration_hash: current.configuration_hash }), guard);
    expect(result).toMatchObject({ applied: true, resourceIds: [C, D] });expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toEqual({ name: 'QA CAPI new', dataset_id: D });
    expect(f.native().some(c => c.url.pathname.includes('/tokens'))).toBe(false);expect(JSON.stringify(result)).not.toContain('native-capi-secret');
  });
  it('returns signed recovery context after an uncertain share without replaying creation or transfer', async () => {
    const f = fixture({ empty: true, shareFailure: true });
    const error = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA', domain: 'https://example.com' }), guard).catch(e => e);
    expect(error.details).toMatchObject({ resource_ids: [P, N], resource_receipt: expect.any(String) });expect(f.writes()).toHaveLength(2);
    expect(await f.provider.measurement.created({ account_id: A, resource_receipt: error.details.resource_receipt })).toMatchObject({ needs_dataset_sharing: false });expect(f.writes()).toHaveLength(2);
  });
  it('does not claim a Pixel creation succeeded with a missing native dataset binding', async () => {
    const f = fixture({ empty: true, corruptRouting: true });const error = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA', domain: 'https://example.com' }), guard).catch(e => e);
    expect(error.details).toMatchObject({ resource_ids: [P], resource_receipt: expect.any(String) });expect(f.writes()).toHaveLength(1);
    expect(await f.provider.measurement.created({ account_id: A, resource_receipt: error.details.resource_receipt })).toMatchObject({ dataset: null });expect(f.writes()).toHaveLength(1);
  });
  it('rejects changed dataset snapshots and duplicate native Pixel sources before a create', async () => {
    const f = fixture(), current = (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    await expect(f.provider.previewWrite(f.op('spotify_create_pixel', { name: 'Duplicate', domain: 'https://example.com', dataset_id: D, expected_dataset_configuration_hash: current.configuration_hash }), guard)).rejects.toThrow('already has');
    f.datasets.get(D)!.name = 'Changed';await expect(f.provider.previewWrite(f.op('spotify_update_dataset', { dataset_id: D, expected_configuration_hash: current.configuration_hash, name: 'New' }), guard)).rejects.toThrow('configuration changed');expect(f.writes()).toHaveLength(0);
  });
  it.each(['pixel', 'capi', 'dataset'] as const)('patches native %s metadata and independently verifies unchanged routing/settings', async kind => {
    const f = fixture(), current = kind === 'pixel' ? (await f.provider.measurement.getPixel({ account_id: A, dataset_id: D })).pixel : kind === 'capi' ? (await f.provider.measurement.getCapi({ account_id: A, dataset_id: D })).capi_integration : (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    const name = kind === 'capi' ? 'spotify_update_capi_integration' : `spotify_update_${kind}`;
    expect(await f.provider.applyWrite(f.op(name, { dataset_id: D, expected_configuration_hash: current.configuration_hash, name: 'Renamed QA' }), guard)).toHaveProperty('applied', true);
    expect(f.writes()).toHaveLength(1);expect(f.writes()[0]).toMatchObject({ method: 'PATCH', body: { name: 'Renamed QA' } });expect(f.pixels.get(P)!.aam_opt_in).toBe(false);
  });
  it.each([{ updateIgnored: true }, { readbackDenied: true }])('keeps uncertain metadata updates unconfirmed and never retries: %o', async options => {
    const f = fixture(options), current = (await f.provider.measurement.getPixel({ account_id: A, dataset_id: D })).pixel;
    await expect(f.provider.applyWrite(f.op('spotify_update_pixel', { dataset_id: D, expected_configuration_hash: current.configuration_hash, name: 'Changed' }), guard)).rejects.toMatchObject({ details: { resource_ids: [P] } });expect(f.writes()).toHaveLength(1);
  });
  it('unshares only the selected account, preserves other shares and provides status-only reconciliation', async () => {
    const f = fixture({ foreignShares: true }), current = (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    const result = await f.provider.applyWrite(f.op('spotify_set_dataset_sharing', { dataset_id: D, expected_configuration_hash: current.configuration_hash, shared: false, acknowledge_measurement_effects: true }), guard);
    expect(f.writes()).toHaveLength(1);expect(f.writes()[0]).toMatchObject({ method: 'DELETE', body: undefined });
    const receipt = details(result).resource_receipt;expect(await f.provider.measurement.sharingStatus({ account_id: A, resource_receipt: receipt })).toMatchObject({ shared_with_selected_account: false, other_shared_account_count: 1 });
    const count = f.native().length;await expect(f.provider.measurement.created({ account_id: A, resource_receipt: receipt })).rejects.toThrow('mismatched');await expect(f.provider.measurement.getDataset({ account_id: A, dataset_id: D, resource_receipt: receipt })).rejects.toThrow('mismatched');expect(f.native()).toHaveLength(count);
  });
  it('reconciles mobile unsharing without returning resource contents through the status receipt', async () => {
    const f = fixture(), current = (await f.provider.measurement.getMobile({ account_id: A, mobile_app_id: M })).mobile_app;
    const result = await f.provider.applyWrite(f.op('spotify_set_mobile_app_sharing', { mobile_app_id: M, expected_configuration_hash: current.configuration_hash, shared: false, acknowledge_measurement_effects: true }), guard);
    const status = await f.provider.measurement.sharingStatus({ account_id: A, resource_receipt: details(result).resource_receipt });
    expect(status).toMatchObject({ kind: 'mobile_app', shared_with_selected_account: false });expect(status).not.toHaveProperty('name');expect(JSON.stringify(status)).not.toContain('native-link-secret');
  });
  it('creates a dataset from explicitly approved integration bindings and verifies its new routing', async () => {
    const f = fixture(), current = (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    const result = await f.provider.applyWrite(f.op('spotify_create_dataset', { name: 'Regrouped QA', sources: [{ dataset_id: D, integration_id: CI, expected_configuration_hash: current.configuration_hash }], acknowledge_measurement_effects: true }), guard);
    expect(result).toMatchObject({ resourceIds: [N] });expect(f.writes()[0]!.body).toEqual({ name: 'Regrouped QA', integration_ids: [CI] });expect(f.capis.get(C)!.dataset_id).toBe(N);
    expect(f.writes().some(c => c.url.pathname === `/ads/v3/businesses/${B}/datasets/${N}/ad_accounts/${A}`)).toBe(true);
  });
  it('models native integration removal as a move into a new dataset with signed recovery', async () => {
    const f = fixture(), current = (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    const result = await f.provider.applyWrite(f.op('spotify_remove_dataset_integration', { dataset_id: D, expected_configuration_hash: current.configuration_hash, integration_id: I, acknowledge_measurement_effects: true }), guard);
    expect(result).toMatchObject({ resourceIds: [D, N] });expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.url.pathname).toBe(`/ads/v3/businesses/${B}/datasets/${D}/integrations/${I}`);expect(f.writes()[0]!.body).toBeUndefined();
    expect(await f.provider.measurement.created({ account_id: A, resource_receipt: details(result).resource_receipt })).toMatchObject({ dataset: { id: N }, needs_dataset_sharing: true });
  });
  it('registers native mobile metadata with the wrapper body, shares the app and never returns link tokens', async () => {
    const f = fixture({ empty: true }), input = { name: 'QA Mobile', platform: 'IOS', platform_app_id: '123456789', mobile_measurement_partner: 'SINGULAR' };
    const result = await f.provider.applyWrite(f.op('spotify_create_mobile_app', input), guard);expect(f.writes()[0]!.body).toEqual({ mobile_app: input });expect(f.writes()[1]!.url.pathname).toBe(`/ads/v3/businesses/${B}/mobile_apps/${M}/ad_accounts/${A}`);
    const read = await f.provider.measurement.created({ account_id: A, resource_receipt: details(result).resource_receipt });expect(JSON.stringify({ result, read })).not.toContain('native-link-secret');
  });
  it.each(['spotify_create_dataset', 'spotify_remove_dataset_integration'])('verifies both parent edges with a null Pixel GET binding for %s', async tool => {
    const f = fixture({ nullPixelBindingOnRead: true }), current = (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    const input = tool === 'spotify_create_dataset'
      ? { name: 'Regrouped QA', sources: [{ dataset_id: D, integration_id: I, expected_configuration_hash: current.configuration_hash }], acknowledge_measurement_effects: true }
      : { dataset_id: D, integration_id: I, expected_configuration_hash: current.configuration_hash, acknowledge_measurement_effects: true };
    expect(await f.provider.applyWrite(f.op(tool, input), guard)).toMatchObject({ applied: true });
    expect(f.datasets.get(D)!.pixel).toBeNull();expect((f.datasets.get(N)!.pixel as Row).id).toBe(P);
    expect(f.writes().filter(call => call.url.pathname.endsWith('/datasets') || call.method === 'DELETE')).toHaveLength(1);
  });
  it('does not confirm regrouping when a null-bound integration remains in its old parent', async () => {
    const f = fixture({ nullPixelBindingOnRead: true, retainDatasetSource: true }), current = (await f.provider.measurement.getDataset({ account_id: A, dataset_id: D })).dataset;
    await expect(f.provider.applyWrite(f.op('spotify_create_dataset', { name: 'QA Regroup', sources: [{ dataset_id: D, integration_id: I, expected_configuration_hash: current.configuration_hash }], acknowledge_measurement_effects: true }), guard)).rejects.toThrow('unconfirmed');
    expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.method).toBe('POST');
  });
  it('updates mobile metadata with the required native name and preserves omitted partner settings', async () => {
    const f = fixture(), current = (await f.provider.measurement.getMobile({ account_id: A, mobile_app_id: M })).mobile_app;
    await f.provider.applyWrite(f.op('spotify_update_mobile_app', { mobile_app_id: M, expected_configuration_hash: current.configuration_hash, name: 'Renamed Mobile' }), guard);
    expect(f.writes()[0]).toMatchObject({ method: 'PATCH', body: { name: 'Renamed Mobile' } });expect(f.apps.get(M)!.mobile_measurement_partner).toBe('SINGULAR');
  });
  it('uses native mobile pagination and rejects offset, repeated or stalled pages', async () => {
    const f = fixture(), first = await f.provider.measurement.mobileApps({ account_id: A, limit: 1, offset: 0 });expect(first).toMatchObject({ truncated: false });expect(f.native().at(-1)!.url.searchParams.get('limit')).toBe('1');
    const broken = fixture({ mobileResponse: { mobile_apps: [], paging: { offset: 0, total_results: 1 } } });await expect(broken.provider.measurement.mobileApps({ account_id: A, limit: 1, offset: 0 })).rejects.toThrow('stalled');
  });
  it('sends required granularities as repeated native query parameters and preserves diagnostic counts', async () => {
    const f = fixture(), result = await f.provider.measurement.diagnostics({ account_id: A, dataset_id: D, granularities: ['DAILY', 'HOURLY'], datasource_ids: [P] });expect(result.datasources[0]!.timeseries[0]!.total).toBe(0);
    const request = f.native().at(-1)!;expect(request.url.searchParams.getAll('granularities')).toEqual(['DAILY', 'HOURLY']);expect(request.url.searchParams.getAll('datasource_ids')).toEqual([P]);expect(f.writes()).toHaveLength(0);
  });
  it('rejects a foreign diagnostic dataset instead of labeling its data as this account’s', async () => {
    const f = fixture({ diagnosticResponse: { dataset_id: N, datasources: [] } });await expect(f.provider.measurement.diagnostics({ account_id: A, dataset_id: D, granularities: ['DAILY'] })).rejects.toThrow('identity/filter mismatch');
  });
  it('rejects altered, wrong-account, wrong-purpose, expired and other-app receipts before resource access', async () => {
    const f = fixture({ empty: true }), result = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA', domain: 'https://example.com' }), guard), receipt = details(result).resource_receipt, native = f.client.verifyMeasurementReceipt(receipt) as Row, count = f.native().length;
    for (const value of [receipt+'x', f.client.measurementReceipt({ ...native, expires_at: 1 }), f.client.measurementReceipt({ ...native, account_id: F }), f.client.measurementReceipt({ ...native, purpose: 'sharing' })]) await expect(f.provider.measurement.created({ account_id: A, resource_receipt: value })).rejects.toThrow();
    expect(f.native()).toHaveLength(count);
    const other = new SpotifyAdsClient({ clientId: 'different-app', clientSecret: 'different-secret', refreshToken: 'inert' });expect(() => other.verifyMeasurementReceipt(receipt)).toThrow('invalid');
    const refreshed = new SpotifyAdsClient({ clientId: 'inert-client', clientSecret: 'inert-client-secret', refreshToken: 'rotated-refresh' });expect(refreshed.verifyMeasurementReceipt(receipt)).toMatchObject({ account_id: A, business_id: B });
  });
  it('rejects noncanonical signature aliases and rechecks current native business after a valid receipt', async () => {
    const f = fixture({ empty: true }), result = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA', domain: 'https://example.com' }), guard), receipt = details(result).resource_receipt;
    const [payload, signature] = receipt.split('.'), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', last = alphabet.indexOf(signature!.at(-1)!);
    expect(() => f.client.verifyMeasurementReceipt(`${payload}.${signature!.slice(0,-1)}${alphabet[last^1]}`)).toThrow('invalid');
    f.moveBusiness(F);await expect(f.provider.measurement.created({ account_id: A, resource_receipt: receipt })).rejects.toThrow('business changed');
  });
  it('does not let an initially unbound creation receipt authorize an unrelated parent dataset', async () => {
    const f = fixture({ empty: true, corruptRouting: true }), error = await f.provider.applyWrite(f.op('spotify_create_pixel', { name: 'QA', domain: 'https://example.com' }), guard).catch(e => e);
    f.pixels.get(P)!.dataset_id = N;f.datasets.get(N)!.shared_ad_accounts = [{ id: F, name: 'Foreign private account' }];f.datasets.get(N)!.capi_integration = { ...CAPI, dataset_id: N };
    await expect(f.provider.measurement.getDataset({ account_id: A, dataset_id: N, resource_receipt: error.details.resource_receipt })).rejects.toThrow('not shared');
    const result = await f.provider.measurement.created({ account_id: A, resource_receipt: error.details.resource_receipt });expect(result.dataset).toBeNull();expect(JSON.stringify(result)).not.toContain('Foreign private account');expect(JSON.stringify(result)).not.toContain('native-capi-secret');
  });
  it('rejects unsupported tracking/credential fields and implicit AAM opt-in before API calls', () => {
    const f = fixture();
    for (const input of [{ name: 'QA', domain: 'https://example.com', aam_opt_in: true, aam_fields: ['EMAIL'] }, { name: 'QA', domain: 'https://example.com', auto_capture_opt_in: true }, { name: 'QA', domain: 'https://user:pass@example.com' }]) expect(() => f.op('spotify_create_pixel', input)).toThrow();
    expect(() => f.op('spotify_update_mobile_app', { mobile_app_id: M, expected_configuration_hash: 'a'.repeat(64), name: 'QA', link_token: 'forbidden' })).toThrow();expect(f.calls).toHaveLength(0);
  });
  it('uses the real shared policy token, rejects changed arguments and consumes apply once', async () => {
    const home = await mkdtemp(join(tmpdir(), 'adport-spotify-measurement-')), previous = process.env.ADPORT_HOME;process.env.ADPORT_HOME = home;
    const f = fixture({ empty: true });
    try {
      const runtime = await createContext({ providerModules: [{ provider: f.provider, tools: f.tools }] }), input = { account_id: A, name: 'Registry QA', domain: 'https://example.com' };
      const preview = await runtime.registry.call('spotify_create_pixel', input, runtime.ctx) as { pending_operation_id: string };expect(f.writes()).toHaveLength(0);
      await expect(runtime.registry.call('spotify_create_pixel', { ...input, name: 'Changed', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
      expect(await runtime.registry.call('spotify_create_pixel', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toHaveProperty('applied', true);
      await expect(runtime.registry.call('spotify_create_pixel', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(2);
    } finally { if(previous===undefined)delete process.env.ADPORT_HOME;else process.env.ADPORT_HOME=previous;await rm(home,{recursive:true,force:true}); }
  });
});
