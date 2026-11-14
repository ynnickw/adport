import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, creativesOutput, verifyMedia, type MediaResolver, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { LinkedInAdsClient, LINKEDIN_API_VERSION } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';

// Native wire formats: LinkedIn-owned Marketing202608 create/manage-creatives,
// text-ads-integrations and Images API docs reviewed2026-11-03.
const A = '518121035', C = '145282384', U = 'urn:li:sponsoredCreative:170811644', I = 'urn:li:image:C4E22AQGX_uq7mQBfAA', AU = `urn:li:sponsoredAccount:${A}`;
const campaign = { id: Number(C), account: AU, name: 'Campaign', status: 'PAUSED', type: 'TEXT_AD' };
const account = { id: Number(A), name: 'Account', currency: 'EUR', status: 'ACTIVE' };
const creative = { id: U, account: AU, campaign: `urn:li:sponsoredCampaign:${C}`, name: 'Creative', intendedStatus: 'PAUSED', content: { textAd: { headline: 'Original', description: 'Original body', landingPage: 'https://example.com', image: I } } };
const image = { id: I, owner: AU, status: 'AVAILABLE', downloadUrl: 'https://media.licdn.com/dms/image/preview.png' };
type Call = { url: URL; init: RequestInit };
const body = (call: Call) => JSON.parse(String(call.init.body));
const writes = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET');
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'linkedin', accountId: A, tool, payload, kind });
const guard = { forcePausedCreation: true };
function fixture(handler?: (call: Call) => unknown, media?: MediaResolver) {
  const calls: Call[] = []; let current = structuredClone(creative);
  const client = new LinkedInAdsClient({ accessToken: 'private-access' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const nativePath = decodeURIComponent(call.url.pathname).replace('/rest/', '');
    if (init.method === 'GET') {
      const values: Record<string, unknown> = { [`adAccounts/${A}`]: account, [`adAccounts/${A}/adCampaigns/${C}`]: campaign, [`adAccounts/${A}/creatives/${U}`]: current, [`adAccounts/${A}/creatives`]: { elements: [current] }, images: { elements: [] }, [`images/${I}`]: image };
      if (values[nativePath]) return Response.json(values[nativePath]);
    }
    if (init.method === 'POST' && nativePath === `adAccounts/${A}/creatives`) { current = { ...current, ...body(call) }; return new Response(null, { status: 201, headers: { 'x-restli-id': encodeURIComponent(U) } }); }
    if (init.method === 'POST' && [ `adAccounts/${A}/creatives/${U}`, `creatives/${U}` ].includes(nativePath)) { current = { ...current, ...body(call).patch.$set }; return new Response(null, { status: 204 }); }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (init.method === 'POST' && nativePath === 'images') return Response.json({ value: { image: I, uploadUrl: 'https://www.linkedin.com/dms-uploads/image/uploaded-image/0?ut=private', uploadUrlExpiresAt: Date.now() + 60_000 } });
    if (init.method === 'PUT') return new Response(null, { status: 201 });
    throw new Error(`Unexpected fixture request ${init.method} ${nativePath}`);
  });
  return { calls, client, provider: new LinkedInAdsProvider(client, media) };
}
const create = { campaign_id: C, name: 'QA', headline: 'New headline', description: 'New body', landing_page: 'https://example.com/new', status: 'ACTIVE', non_political_consent: true, image: I };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('LinkedIn creative wire contracts and review forms', () => {
  it('builds one serializable catalog without eagerly touching the provider', () => {
    const provider = new Proxy({} as LinkedInAdsProvider, { get() { throw new Error('Eager provider access'); } }), tools = linkedinTools(provider);
    expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length); for (const tool of tools) expect(() => z.toJSONSchema(tool.input)).not.toThrow();
  });
  it('uses the account-scoped criteria finder and properly encodes URNs and page tokens', async () => {
    const { provider, calls } = fixture(call => call.url.pathname.endsWith('/creatives') ? { elements: [creative], metadata: { nextPageToken: 'next-page' } } : undefined);
    const result = await provider.creatives.list({ account_id: A, campaign_ids: [C], creative_ids: [U], page_size: 20, page_token: 'prior)&unsafe=x', include_media: true });
    expect(creativesOutput.safeParse(result).success).toBe(true); expect(result.next_page_token).toBe('next-page');
    const request = calls[0]!; expect(request.url.pathname).toBe(`/rest/adAccounts/${A}/creatives`); expect(request.url.href).toContain(`campaigns=List(urn%3Ali%3AsponsoredCampaign%3A${C})`); expect(request.url.searchParams.get('q')).toBe('criteria'); expect(request.url.searchParams.get('unsafe')).toBeNull(); expect(request.init.headers).toMatchObject({ 'X-RestLi-Method': 'FINDER', 'Linkedin-Version': LINKEDIN_API_VERSION });
    expect(result.creatives[0]).toMatchObject({ headlines: ['Original'], descriptions: ['Original body'], media: [{ type: 'image', url: image.downloadUrl }] });
    const action = result.creatives[0]!.actions.find(action => action.tool === 'linkedin_update_text_ad'); expect(action?.arguments).toEqual({ account_id: A, creative_id: U });
    const statuses = result.creatives[0]!.actions.find(action => action.tool === 'linkedin_set_creative_status')!.fields[0]!.options; expect(statuses?.map(option => option.value)).toEqual(['PAUSED', 'ARCHIVED']);
  });
  it('retains references without inventing post copy and warns when owned media cannot be hydrated', async () => {
    const referenced = fixture(call => call.url.pathname.endsWith('/creatives') ? { elements: [{ ...creative, content: { reference: 'urn:li:share:123' } }] } : undefined);
    const result = await referenced.provider.creatives.list({ account_id: A, page_size: 20, include_media: true }); expect(result.creatives[0]!.headlines).toEqual([]); expect(result.warnings[0]!.message).toContain('source-specific access');
    const denied = fixture(call => call.url.pathname.startsWith('/rest/images/') ? Response.json({}, { status: 403 }) : undefined), gallery = await denied.provider.creatives.list({ account_id: A, page_size: 20, include_media: true }); expect(gallery.creatives[0]!.headlines).toEqual(['Original']); expect(gallery.creatives[0]!.media).toEqual([]); expect(gallery.warnings).toHaveLength(1);
  });
  it.each([
    { ...creative, account: 'urn:li:sponsoredAccount:999' },
    { ...creative, campaign: 'urn:li:sponsoredCampaign:999' },
    { ...creative, id: 'urn:li:sponsoredCreative:999' },
  ])('rejects ignored account/campaign/ID filters', async value => {
    const { provider } = fixture(call => call.url.pathname.endsWith('/creatives') ? { elements: [value] } : undefined); await expect(provider.creatives.list({ account_id: A, campaign_ids: [C], creative_ids: [U], page_size: 20, include_media: false })).rejects.toThrow('mismatch');
  });
  it('creates a paused text ad with direct native fields, canonical URN receipt and readback', async () => {
    const { provider, calls } = fixture(), operation = op('linkedin_create_text_ad', create, 'create');
    const preview = await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]); expect(preview.coercions).toEqual(['intendedStatus coerced to PAUSED by policy (paused_creation)']);
    expect(await provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [U] });
    expect(body(writes(calls)[0]!)).toEqual({ campaign: `urn:li:sponsoredCampaign:${C}`, name: 'QA', intendedStatus: 'PAUSED', content: { textAd: { headline: 'New headline', description: 'New body', landingPage: 'https://example.com/new', image: I } } }); expect(writes(calls)[0]!.url.pathname).toBe(`/rest/adAccounts/${A}/creatives`);
  });
  it('preserves omitted destination, description and image on a copy edit and checks unchanged intended status', async () => {
    const { provider, calls } = fixture(); await provider.applyWrite(op('linkedin_update_text_ad', { creative_id: U, headline: 'Edited' }), guard);
    const call = writes(calls)[0]!; expect(call.url.pathname).toBe(`/rest/creatives/${encodeURIComponent(U)}`); expect(call.init.headers).toMatchObject({ 'X-RestLi-Method': 'PARTIAL_UPDATE' }); expect(body(call)).toEqual({ patch: { $set: { content: { textAd: { ...creative.content.textAd, headline: 'Edited' } } } } });
  });
  it('refuses unknown source fields rather than dropping them during a replacement', async () => {
    const { provider, calls } = fixture(call => decodeURIComponent(call.url.pathname).endsWith(`/creatives/${U}`) ? { ...creative, content: { textAd: { ...creative.content.textAd, futureField: 'keep' } } } : undefined);
    await expect(provider.previewWrite(op('linkedin_update_text_ad', { creative_id: U, headline: 'Edited' }), guard)).rejects.toThrow('unsupported fields'); expect(writes(calls)).toEqual([]);
  });
  it.each(['foreign', 'not-ready', 'wrong-campaign'] as const)('rejects %s media/parent before creative creation', async reason => {
    const { provider, calls } = fixture(call => call.url.pathname.includes('/images/') ? { ...image, ...(reason === 'foreign' ? { owner: 'urn:li:organization:999' } : { status: 'PROCESSING' }) } : reason === 'wrong-campaign' && call.url.pathname.includes('/adCampaigns/') ? { ...campaign, type: 'SPONSORED_UPDATES' } : undefined);
    await expect(provider.previewWrite(op('linkedin_create_text_ad', create, 'create'), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
  });
  it('never infers advertiser confirmation on creative activation', async () => {
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('linkedin_set_creative_status', { creative_id: U, status: 'ACTIVE' }), guard)).rejects.toThrow('explicit advertiser'); expect(writes(calls)).toEqual([]);
    await provider.applyWrite(op('linkedin_set_creative_status', { creative_id: U, status: 'ACTIVE', non_political_consent: true }), guard); expect(body(writes(calls)[0]!)).toEqual({ patch: { $set: { intendedStatus: 'ACTIVE' } } });
  });
  it('retains IDs and rejects a create receipt whose readback violates paused creation', async () => {
    const { provider, calls } = fixture(call => decodeURIComponent(call.url.pathname).endsWith(`/creatives/${U}`) && call.init.method === 'GET' ? { ...creative, intendedStatus: 'ACTIVE' } : undefined);
    await expect(provider.applyWrite(op('linkedin_create_text_ad', create, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [U] } }); expect(writes(calls)).toHaveLength(1);
  });
  it('requests native pending deletion for a non-draft and uses DELETE only for a verified draft', async () => {
    const existing = fixture(); const result = await existing.provider.applyWrite(op('linkedin_delete_creative', { creative_id: U }, 'remove'), guard); expect(result.details).toEqual({ deletion: 'PENDING_DELETION' }); expect(body(writes(existing.calls)[0]!)).toEqual({ patch: { $set: { intendedStatus: 'PENDING_DELETION' } } });
    const draft = fixture(call => decodeURIComponent(call.url.pathname).endsWith(`/creatives/${U}`) && call.init.method === 'GET' ? { ...creative, intendedStatus: 'DRAFT' } : undefined); expect((await draft.provider.applyWrite(op('linkedin_delete_creative', { creative_id: U }, 'remove'), guard)).details).toEqual({ deletion: 'DELETED' }); expect(writes(draft.calls)[0]!.init.method).toBe('DELETE'); expect(writes(draft.calls)[0]!.init.headers).toMatchObject({ 'X-RestLi-Method': 'DELETE' });
  });
  it('checks the shared exact-argument gate and protected accounts for copy edits', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'linkedin-creative-')); dirs.push(directory); const { provider, calls } = fixture(), audit = new AuditLog(path.join(directory, 'audit')), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(directory, 'pending')), audit), runtime = await createContext({ engine, providerModules: [{ provider, tools: linkedinTools(provider) }] });
    const args = { account_id: A, creative_id: U, headline: 'Edited' }, pending = await runtime.registry.call('linkedin_update_text_ad', args, runtime.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]);
    await expect(runtime.registry.call('linkedin_update_text_ad', { ...args, headline: 'Different', pending_operation_id: pending.pending_operation_id }, runtime.ctx)).rejects.toThrow('differs'); await runtime.registry.call('linkedin_update_text_ad', { ...args, pending_operation_id: pending.pending_operation_id }, runtime.ctx); expect(writes(calls)).toHaveLength(1);
    const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(directory, 'protected')), audit); await expect(protectedEngine.validate(provider, op('linkedin_update_text_ad', { creative_id: U, headline: 'Edited' }))).rejects.toThrow('protected');
  });
});

describe('LinkedIn checksum-bound image transfer', () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), sha256 = createHash('sha256').update(bytes).digest('hex'), input = { name: 'QA image', media_id: '00000000-0000-4000-8000-000000000001', expected_sha256: sha256 };
  const media: MediaResolver = { read: async (source, options) => verifyMedia(bytes, 'qa.png', source.expected_sha256, options) };
  it('initializes only on apply, binds the account library, transfers exact bytes and leaves readiness for a later read', async () => {
    const { provider, calls } = fixture(undefined, media), operation = op('linkedin_upload_image', input, 'create'); const preview = await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]); expect(preview.changes[0]).toContain('named "QA image"');
    expect(await provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [I], details: { status: 'UPLOAD_ACCEPTED', next_tool: 'linkedin_get_library_image' } }); const [init, transfer] = writes(calls); expect(init!.url.searchParams.get('action')).toBe('initializeUpload'); expect(body(init!)).toEqual({ initializeUploadRequest: { owner: AU, mediaLibraryMetadata: { associatedAccount: AU, assetName: 'QA image' } } }); expect(transfer!.init.body).toEqual(bytes); expect(transfer!.init.redirect).toBe('error'); expect(transfer!.init.headers).toMatchObject({ authorization: 'Bearer private-access', 'content-type': 'application/octet-stream' });
  });
  it.each(['https://evil.example/dms-uploads/file', 'https://www.linkedin.com/not-an-upload', 'https://www.linkedin.com/dms-uploads/file#fragment'])('rejects unsafe upload destination %s without sending bytes or a bearer token', async uploadUrl => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { value: { image: I, uploadUrl, uploadUrlExpiresAt: Date.now() + 60_000 } } : undefined, media); await expect(provider.applyWrite(op('linkedin_upload_image', input, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [I] } }); expect(calls.filter(call => call.init.method === 'PUT')).toEqual([]);
  });
  it('rejects a changed file checksum before native initialization and never replays a failed transfer', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PUT' ? new Response(null, { status: 401 }) : undefined, media); await expect(provider.previewWrite(op('linkedin_upload_image', { ...input, expected_sha256: 'b'.repeat(64) }, 'create'), guard)).rejects.toThrow('SHA-256 mismatch'); expect(calls).toEqual([]);
    await expect(provider.applyWrite(op('linkedin_upload_image', input, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [I] } }); expect(calls.filter(call => call.init.method === 'PUT')).toHaveLength(1);
  });
});

describe('LinkedIn native image library', () => {
  const libraryImage = { ...image, owner: 'urn:li:organization:5583111', mediaLibraryMetadata: { associatedAccount: AU, assetName: 'Native library image', mediaLibraryStatus: 'ACTIVE' } };
  it('uses the associatedAccount finder and renders native processing/ownership/name', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/rest/images' ? { elements: [libraryImage], paging: { start: 0, count: 1, links: [{ rel: 'next', href: 'https://api.linkedin.com/rest/images?ignored=true' }] } } : undefined);
    const result = await provider.creatives.images({ account_id: A, library_status: 'ACTIVE', start: 0, count: 1 }); expect(creativesOutput.safeParse(result).success).toBe(true); expect(result.next_start).toBe(1); expect(result.creatives[0]).toMatchObject({ name: 'Native library image', type: 'IMAGE_ASSET', status: 'AVAILABLE', media: [{ type: 'image', url: image.downloadUrl }] }); expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toMatchObject({ q: 'associatedAccount', associatedAccount: AU, mediaLibraryStatus: '(value:ACTIVE)', start: '0', count: '1' });
  });
  it('updates nested library metadata with an account-bound native partial patch and readback', async () => {
    let current = structuredClone(libraryImage);
    const { provider, calls } = fixture(call => {
      if (call.url.pathname === '/rest/images' && call.init.method === 'GET') return { elements: [current] };
      if (call.url.pathname.startsWith('/rest/images/')) {
        if (call.init.method === 'POST') { current = { ...current, mediaLibraryMetadata: { ...current.mediaLibraryMetadata, ...body(call).patch.mediaLibraryMetadata.$set } }; return new Response(null, { status: 204 }); }
        return new Response(null, { status: 403 });
      }
    });
    const operation = op('linkedin_update_image', { image_id: I, asset_name: 'Renamed', library_status: 'ARCHIVED' }); const preview = await provider.previewWrite(operation, guard); expect(preview.changes[0]).toContain('existing ad delivery remain unchanged'); expect(writes(calls)).toEqual([]);
    expect(await provider.applyWrite(operation, guard)).toMatchObject({ applied: true, resourceIds: [I] }); const request = writes(calls)[0]!; expect(request.url.pathname).toBe(`/rest/images/${encodeURIComponent(I)}`); expect(request.url.searchParams.get('associatedAccount')).toBe(AU); expect(request.init.headers).toMatchObject({ 'X-RestLi-Method': 'PARTIAL_UPDATE' }); expect(body(request)).toEqual({ patch: { mediaLibraryMetadata: { $set: { assetName: 'Renamed', mediaLibraryStatus: 'ARCHIVED' } } } }); expect(writes(calls)).toHaveLength(1);
    expect(calls.some(call => call.init.method === 'GET' && call.url.pathname.startsWith('/rest/images/'))).toBe(false);
  });
  it('rejects foreign library membership and does not treat an unregistered owned image as editable metadata', async () => {
    const foreign = fixture(call => call.url.pathname === '/rest/images' ? { elements: [{ ...libraryImage, mediaLibraryMetadata: { ...libraryImage.mediaLibraryMetadata, associatedAccount: 'urn:li:sponsoredAccount:999' } }] } : undefined); await expect(foreign.provider.creatives.images({ account_id: A, library_status: 'ACTIVE', start: 0, count: 20 })).rejects.toThrow('account/status/paging mismatch');
    const { provider, calls } = fixture(); await expect(provider.previewWrite(op('linkedin_update_image', { image_id: I, asset_name: 'No library entry' }), guard)).rejects.toThrow('no selected-account library metadata'); expect(writes(calls)).toEqual([]);
  });
  it('retains the native image ID when an accepted library edit does not match readback', async () => {
    const { provider } = fixture(call => call.url.pathname === '/rest/images' ? { elements: [libraryImage] } : call.url.pathname.startsWith('/rest/images/') && call.init.method === 'POST' ? new Response(null, { status: 204 }) : undefined); await expect(provider.applyWrite(op('linkedin_update_image', { image_id: I, asset_name: 'Changed' }), guard)).rejects.toMatchObject({ details: { resource_ids: [I] } });
  });

  it('finds an exact archived library image on a later native offset page without requesting its global endpoint', async () => {
    const other = { ...libraryImage, id: 'urn:li:image:another' };
    const { provider, calls } = fixture(call => call.url.pathname === '/rest/images'
      ? call.url.searchParams.get('start') === '0' ? { elements: [other], paging: { start: 0, count: 100, links: [{ rel: 'next' }] } } : { elements: [{ ...libraryImage, mediaLibraryMetadata: { ...libraryImage.mediaLibraryMetadata, mediaLibraryStatus: 'ARCHIVED' } }], paging: { start: 1, count: 100 } }
      : undefined);
    expect(await provider.creatives.libraryImage(A, I)).toMatchObject({ id: I, mediaLibraryMetadata: { associatedAccount: AU, mediaLibraryStatus: 'ARCHIVED' } });
    const pages = calls.filter(call => call.url.pathname === '/rest/images');
    expect(pages.map(call => call.url.searchParams.get('start'))).toEqual(['0', '1']);
    expect(pages.every(call => call.url.searchParams.get('associatedAccount') === AU && !call.url.searchParams.has('mediaLibraryStatus'))).toBe(true);
    expect(calls.some(call => call.url.pathname.startsWith('/rest/images/'))).toBe(false);
  });

  it('rejects cyclic library pages and incomplete membership at the lookup ceiling', async () => {
    const cyclic = fixture(call => call.url.pathname === '/rest/images' ? { elements: [{ ...libraryImage, id: 'urn:li:image:another' }], paging: { start: Number(call.url.searchParams.get('start')), count: 100, links: [{ rel: 'next' }] } } : undefined);
    await expect(cyclic.provider.creatives.libraryImage(A, I)).rejects.toThrow('repeated an image');
    const capped = fixture(call => call.url.pathname === '/rest/images' ? { elements: Array.from({ length: 100 }, (_, index) => ({ ...libraryImage, id: `urn:li:image:page${call.url.searchParams.get('start')}_${index}` })), paging: { start: Number(call.url.searchParams.get('start')), count: 100, links: [{ rel: 'next' }] } } : undefined);
    await expect(capped.provider.creatives.libraryImage(A, I)).rejects.toThrow('5,000-image limit');
    expect(capped.calls.filter(call => call.url.pathname === '/rest/images')).toHaveLength(50);
    expect(writes(capped.calls)).toEqual([]);
  });
});
