import { createContext, creativesOutput, DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LinkedInAdsClient, LINKEDIN_API_VERSION, LINKEDIN_CREATIVE_METADATA_VERSION } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';

// Wire contracts checked against LinkedIn-owned Creatives202608/createInline,
// Creatives202610 metadata, Posts, Document Ads and Carousel docs on2026-11-04.
const A = '7', C = '8', TARGET = '18', U = 'urn:li:sponsoredCreative:9', U2 = 'urn:li:sponsoredCreative:19', NEW = 'urn:li:sponsoredCreative:29';
const AU = `urn:li:sponsoredAccount:${A}`, O = 'urn:li:organization:11', P = 'urn:li:ugcPost:10', I = 'urn:li:image:fixture', V = 'urn:li:video:fixture', D = 'urn:li:document:fixture';
type Row = Record<string, any>;
type Call = { url: URL; init: RequestInit; body?: Row };
function fixture(format = 'STANDARD_UPDATE') {
  const campaign: Row = { id: Number(C), account: AU, name: 'Fixture campaign', status: 'PAUSED', type: 'SPONSORED_UPDATES', format, associatedEntity: O, objectiveType: 'BRAND_AWARENESS' };
  const source: Row = { id: U, account: AU, campaign: `urn:li:sponsoredCampaign:${C}`, intendedStatus: 'PAUSED', name: 'Fixture creative', content: format === 'SPONSORED_UPDATE_NATIVE_DOCUMENT' ? { documentAd: { reference: P } } : { reference: P } };
  const state = {
    account: { id: Number(A), name: 'Fixture account', currency: 'USD', status: 'DRAFT', reference: O },
    campaign, target: { ...campaign, id: Number(TARGET) } as Row, source, created: undefined as Row | undefined,
    post: { id: P, author: O, commentary: 'Original commentary', lifecycleState: 'PUBLISHED', distribution: { feedDistribution: 'NONE', thirdPartyDistributionChannels: [] }, visibility: 'PUBLIC', adContext: { dscAdAccount: AU, dscStatus: 'ACTIVE', dscName: 'Fixture post' }, content: { media: { id: I, title: 'Original title' } } } as Row,
    links: [source, { ...source, id: U2 }] as Row[],
    images: [{ id: I, owner: AU, status: 'AVAILABLE', downloadUrl: 'https://media.licdn.com/fixture.png', mediaLibraryMetadata: { associatedAccount: AU, assetName: 'Fixture', mediaLibraryStatus: 'ACTIVE' } }] as Row[],
    videos: [{ id: V, owner: O, status: 'AVAILABLE', downloadUrl: 'https://media.licdn.com/fixture.mp4', mediaLibraryMetadata: { associatedAccount: AU, assetName: 'Fixture', mediaLibraryStatus: 'ACTIVE' } }] as Row[],
    document: { id: D, owner: AU, status: 'AVAILABLE' } as Row,
    metadata: { adFormat: 'SPONSORED_VIDEO', adHeadline: 'Native title', adIntroductionText: 'Native introduction', assetURL: 'https://media.licdn.com/native.mp4', landingPage: 'https://example.test/destination' } as Row | undefined,
  };
  const calls: Call[] = []; let override: ((call: Call) => Response | Row | undefined) | undefined;
  const client = new LinkedInAdsClient({ accessToken: 'fixture-token' }, async (url, init = {}) => {
    const call: Call = { url: new URL(String(url)), init, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) }; calls.push(call);
    const special = override?.(call); if (special !== undefined) return special instanceof Response ? special : Response.json(special);
    const path = decodeURIComponent(call.url.pathname).replace('/rest/', '');
    if (init.method === 'HEAD' && call.url.hostname === 'media.licdn.com') return new Response(null, { headers: { 'content-type': 'video/mp4' } });
    if (init.method === 'GET') {
      if (path === `adAccounts/${A}`) return Response.json(state.account);
      if (path === `adAccounts/${A}/adCampaigns/${C}`) return Response.json(state.campaign);
      if (path === `adAccounts/${A}/adCampaigns/${TARGET}`) return Response.json(state.target);
      if (path === `adAccounts/${A}/creatives`) return Response.json({ elements: call.url.searchParams.has('contentReferences') ? state.links : [state.source] });
      if (path === `adAccounts/${A}/creatives/${U}` || path === `adAccounts/${A}/creatives/${NEW}`) return Response.json({ ...(path.endsWith(NEW) ? state.created : state.source), ...(call.url.searchParams.has('fields') && state.metadata ? { metadata: state.metadata } : {}) });
      if (path === `posts/${P}`) return Response.json(state.post);
      if (path === 'images') return Response.json({ elements: state.images });
      if (path === 'videos') return Response.json({ elements: state.videos });
      if (path === `documents/${D}`) return Response.json(state.document);
    }
    if (init.method === 'POST' && path === `adAccounts/${A}/creatives`) {
      const fields = call.body!.creative ?? call.body!;
      if (fields.inlineContent?.post) state.post = { id: P, ...structuredClone(fields.inlineContent.post) };
      state.created = { id: NEW, account: AU, ...fields, content: fields.content ?? (state.campaign.format === 'SPONSORED_UPDATE_NATIVE_DOCUMENT' ? { documentAd: { reference: P } } : { reference: P }) };
      return new Response(null, { status: 201, headers: { 'x-restli-id': encodeURIComponent(NEW) } });
    }
    if (init.method === 'POST' && path === `posts/${P}`) {
      Object.assign(state.post, call.body!.patch.$set ?? {});
      Object.assign(state.post.adContext, call.body!.patch.adContext?.$set ?? {});
      return new Response(null, { status: 204 });
    }
    if (init.method === 'DELETE' && path === `posts/${P}`) return new Response(null, { status: 204 });
    throw new Error(`Unexpected fixture request ${init.method} ${path}`);
  });
  const provider = new LinkedInAdsProvider(client);
  return { provider, state, calls, override: (handler: typeof override) => { override = handler; } };
}
const guard = { forcePausedCreation: true };
const mutation = (calls: Call[]) => calls.filter(call => !['GET','HEAD'].includes(String(call.init.method)));
const operation = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ provider: 'linkedin', accountId: A, tool, payload, kind });
const create = (content: Row) => ({ campaign_id: C, name: 'Synthetic QA', author_organization: O, commentary: 'Fixture commentary', content, status: 'ACTIVE', non_political_consent: true });
const context = (f: ReturnType<typeof fixture>) => f.provider.sponsored.postContext(A, { post_id: P, author_organization: O });
const target = (result: Awaited<ReturnType<typeof context>>) => ({ post_id: P, author_organization: O, expected_post_hash: result.post_snapshot_hash, expected_associations_hash: result.associations_snapshot_hash });

describe('LinkedIn sponsored content and native creative metadata', () => {
  it('declares all new tools once without touching credentials or requesting broader OAuth scopes', () => {
    const tools = linkedinTools(new Proxy({} as LinkedInAdsProvider, { get() { throw new Error('Eager provider read'); } }));
    expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
    for (const name of ['linkedin_creative_preview','linkedin_get_sponsored_post','linkedin_create_sponsored_ad','linkedin_create_reference_ad','linkedin_update_sponsored_post','linkedin_archive_sponsored_post','linkedin_delete_sponsored_post']) expect(tools.some(tool => tool.name === name)).toBe(true);
    for (const tool of tools) expect(() => z.toJSONSchema(tool.input)).not.toThrow();
  });

  it.each([
    ['TEXT', 'STANDARD_UPDATE', { type: 'TEXT' }],
    ['IMAGE', 'STANDARD_UPDATE', { type: 'IMAGE', image_id: I, title: 'Image title', alt_text: 'Image alternative' }],
    ['VIDEO', 'SINGLE_VIDEO', { type: 'VIDEO', video_id: V, title: 'Video title' }],
    ['DOCUMENT', 'SPONSORED_UPDATE_NATIVE_DOCUMENT', { type: 'DOCUMENT', document_id: D, title: 'Document title' }],
    ['ARTICLE', 'STANDARD_UPDATE', { type: 'ARTICLE', source: 'https://example.test/article', title: 'Article title', description: 'Authored description', thumbnail: I }],
    ['CAROUSEL', 'CAROUSEL', { type: 'CAROUSEL', cards: [{ image_id: I, title: 'First', landing_page: 'https://example.test/first' }, { image_id: I, title: 'Second', alt_text: 'Second alternative', landing_page: 'https://example.test/second' }] }],
  ] as const)('creates %s via exact inline wire format, a paused creative and a feed-disabled URL-accessible post', async (_type, format, content) => {
    const f = fixture(format), op = operation('linkedin_create_sponsored_ad', create(content));
    const preview = await f.provider.previewWrite(op, guard);
    expect(preview.serverValidated).toBe(false); expect(preview.budgetDeltas).toEqual([]); expect(mutation(f.calls)).toEqual([]);
    expect(preview.changes.join(' ')).toContain('anyone with a direct URL'); expect(preview.coercions).toEqual(['intendedStatus coerced to PAUSED by policy (paused_creation)']);
    const result = await f.provider.applyWrite(op, guard), written = mutation(f.calls);
    expect(written).toHaveLength(1); expect(written[0]!.url.searchParams.get('action')).toBe('createInline');
    expect(written[0]!.init.headers).toMatchObject({ 'Linkedin-Version': LINKEDIN_API_VERSION, 'X-Restli-Protocol-Version': '2.0.0' });
    const creative = written[0]!.body!.creative, post = creative.inlineContent.post;
    expect(creative).toMatchObject({ campaign: `urn:li:sponsoredCampaign:${C}`, intendedStatus: 'PAUSED', name: 'Synthetic QA' });
    expect(post).toMatchObject({ author: O, commentary: 'Fixture commentary', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', distribution: { feedDistribution: 'NONE', targetEntities: [], thirdPartyDistributionChannels: [] }, isReshareDisabledByAuthor: true, adContext: { dscAdAccount: AU, dscStatus: 'ACTIVE' } });
    if (content.type === 'CAROUSEL') expect(post.content.carousel.cards).toEqual([{ media: { id: I, title: 'First' }, landingPage: 'https://example.test/first' }, { media: { id: I, title: 'Second', altText: 'Second alternative' }, landingPage: 'https://example.test/second' }]);
    else if (content.type === 'ARTICLE') expect(post.content.article).toEqual({ source: content.source, title: content.title, description: content.description, thumbnail: I });
    else if (content.type === 'TEXT') expect(post).not.toHaveProperty('content');
    else expect(post.content.media).toMatchObject({ id: content.type === 'IMAGE' ? I : content.type === 'VIDEO' ? V : D, title: content.title });
    expect(result).toMatchObject({ resourceIds: [NEW], details: { post_id: P, intended_status: 'PAUSED' } });
  });

  it.each(['format','author','archived','leadgen','image-processing','video-owner','document-owner'] as const)('rejects incompatible or unowned input before initialization: %s', async reason => {
    const format = reason === 'video-owner' ? 'SINGLE_VIDEO' : reason === 'document-owner' ? 'SPONSORED_UPDATE_NATIVE_DOCUMENT' : 'STANDARD_UPDATE', f = fixture(format);
    let content: Row = { type: 'IMAGE', image_id: I, title: 'Title' };
    if (reason === 'format') f.state.campaign.format = 'CAROUSEL';
    if (reason === 'author') f.state.campaign.associatedEntity = 'urn:li:organization:999';
    if (reason === 'archived') f.state.campaign.status = 'ARCHIVED';
    if (reason === 'leadgen') f.state.campaign.objectiveType = 'LEAD_GENERATION';
    if (reason === 'image-processing') f.state.images[0]!.status = 'PROCESSING';
    if (reason === 'video-owner') { content = { type: 'VIDEO', video_id: V, title: 'Title' }; f.state.videos[0]!.owner = 'urn:li:organization:999'; }
    if (reason === 'document-owner') { content = { type: 'DOCUMENT', document_id: D, title: 'Title' }; f.state.document.owner = 'urn:li:sponsoredAccount:999'; }
    await expect(f.provider.previewWrite(operation('linkedin_create_sponsored_ad', create(content)), guard)).rejects.toThrow();
    expect(mutation(f.calls)).toEqual([]);
  });

  it('validates CTA/destination and uses native enum labels without changing campaign money', async () => {
    const f = fixture(); f.state.campaign.objectiveType = 'WEBSITE_VISITS'; const payload = create({ type: 'IMAGE', image_id: I, title: 'Title' });
    await expect(f.provider.previewWrite(operation('linkedin_create_sponsored_ad', payload), guard)).rejects.toThrow('landing page');
    await f.provider.applyWrite(operation('linkedin_create_sponsored_ad', { ...payload, landing_page: 'https://example.test/app', call_to_action: 'APPLY' }), guard);
    expect(mutation(f.calls)[0]!.body!.creative.inlineContent.post).toMatchObject({ contentCallToActionLabel: 'APPLY', contentLandingPage: 'https://example.test/app' });
    await expect(f.provider.previewWrite(operation('linkedin_create_sponsored_ad', { ...payload, call_to_action: 'APPLY_NOW' }), guard)).rejects.toThrow();
  });

  it('reuses an owned document post without publishing another post or changing the original creative', async () => {
    const f = fixture('SPONSORED_UPDATE_NATIVE_DOCUMENT'), op = operation('linkedin_create_reference_ad', { campaign_id: TARGET, source_creative_id: U, name: 'Reused', status: 'ACTIVE', non_political_consent: true });
    const original = structuredClone(f.state.source); await f.provider.applyWrite(op, guard);
    expect(mutation(f.calls)).toHaveLength(1); expect(mutation(f.calls)[0]!.url.search).toBe('');
    expect(mutation(f.calls)[0]!.body).toEqual({ campaign: `urn:li:sponsoredCampaign:${TARGET}`, name: 'Reused', intendedStatus: 'PAUSED', content: { documentAd: { reference: P } } });
    expect(f.state.source).toEqual(original);
    f.state.target.associatedEntity = 'urn:li:organization:999'; await expect(f.provider.previewWrite(op, guard)).rejects.toThrow('matching format and organization');
  });

  it('requests metadata only on the version202610 single-resource read and renders native primary video metadata', async () => {
    const f = fixture(), result = await f.provider.sponsored.preview(A, U);
    expect(creativesOutput.safeParse(result).success).toBe(true);
    expect(result.creatives[0]).toMatchObject({ id: U, headlines: ['Native title'], descriptions: ['Native introduction'], landing_urls: ['https://example.test/destination'], media: [{ type: 'video', url: 'https://media.licdn.com/native.mp4' }] });
    expect(f.calls[0]!.url.searchParams.get('fields')).toBe('id,account,campaign,name,intendedStatus,content,metadata');
    expect(f.calls[0]!.init.headers).toMatchObject({ 'Linkedin-Version': LINKEDIN_CREATIVE_METADATA_VERSION });
    expect(f.calls[1]!.init.headers).toMatchObject({ 'Linkedin-Version': LINKEDIN_API_VERSION });
    for (const action of result.creatives[0]!.actions) expect(action.arguments).toMatchObject({ account_id: A, creative_id: U });
    const gallery = await f.provider.creatives.list({ account_id: A, page_size: 10, include_media: true });
    expect(gallery.creatives[0]!.headlines).toEqual(['Native title']);
    expect(f.calls.filter(c => c.url.pathname.endsWith('/creatives')).every(c => !c.url.searchParams.has('fields'))).toBe(true);
  });

  it('leaves missing metadata empty, drops unsafe preview hosts, and rejects foreign native receipts', async () => {
    const f = fixture(); f.state.metadata = undefined;
    expect((await f.provider.sponsored.preview(A, U))).toMatchObject({ creatives: [{ headlines: [], media: [] }], warnings: [{ message: expect.stringContaining('not returned') }] });
    f.state.metadata = { adFormat: 'SPONSORED_VIDEO', assetURL: 'https://untrusted.example.test/private.mp4' };
    expect((await f.provider.sponsored.preview(A, U)).creatives[0]!.media).toEqual([]);
    f.state.source.account = 'urn:li:sponsoredAccount:999';
    await expect(f.provider.sponsored.preview(A, U)).rejects.toThrow('account/ID mismatch');
  });

  it('uses native MIME for video thumbnails and never sends advertising credentials to CDN probes', async () => {
    const f = fixture(); f.override(c => c.init.method === 'HEAD' ? new Response(null, { headers: { 'content-type': 'image/jpeg; charset=binary' } }) : undefined);
    expect((await f.provider.sponsored.preview(A, U)).creatives[0]!.media).toEqual([{ type: 'image', url: 'https://media.licdn.com/native.mp4' }]);
    const probe = f.calls.find(c => c.init.method === 'HEAD')!;
    expect(probe.init).toMatchObject({ redirect: 'error' }); expect(new Headers(probe.init.headers).has('authorization')).toBe(false);
    const denied = fixture(); denied.override(c => c.init.method === 'HEAD' ? new Response(null, { status: 403 }) : undefined);
    const result = await denied.provider.sponsored.preview(A, U);
    expect(result.creatives[0]!.media).toEqual([]); expect(result.creatives[0]!.headlines).toEqual(['Native title']); expect(result.warnings[0]!.message).toContain('No media type is inferred');
    expect(denied.calls.filter(c => c.init.method === 'HEAD')).toHaveLength(1);
  });

  it('renders carousel cards in order, including repeated images, and binds shared edit forms to exact content/associations', async () => {
    const f = fixture(); f.state.post.content = { carousel: { cards: [{ media: { id: I, title: 'First' }, landingPage: 'https://example.test/1' }, { media: { id: I, title: 'Second', altText: 'Second alt' }, landingPage: 'https://example.test/2' }] } };
    const result = await f.provider.sponsored.postContext(A, { creative_id: U });
    expect(creativesOutput.safeParse(result).success).toBe(true); expect(result.associations).toHaveLength(2);
    expect(result.creatives[0]).toMatchObject({ type: 'CAROUSEL_POST', descriptions: ['Original commentary','First','Second'], landing_urls: ['https://example.test/1','https://example.test/2'], media: [{ type: 'image', alt: 'First' }, { type: 'image', alt: 'Second alt' }] });
    expect(f.calls.filter(c => c.url.pathname === '/rest/images')).toHaveLength(1);
    const action = result.creatives[0]!.actions[0]!;
    expect(action.arguments).toMatchObject({ account_id: A, post_id: P, campaign_id: C, expected_post_hash: result.post_snapshot_hash, expected_associations_hash: result.associations_snapshot_hash });
    const finder = f.calls.find(c => c.url.searchParams.has('contentReferences'))!;
    expect(finder.url.href).toContain('contentReferences=List(urn%3Ali%3AugcPost%3A10)');
    expect(finder.init.headers).toMatchObject({ 'X-RestLi-Method': 'FINDER' });
  });

  it('merges only supplied post fields, performs nested DSC-name patches, and verifies shared creative delivery is preserved', async () => {
    const f = fixture(), before = await context(f), originalContent = structuredClone(f.state.post.content), originalLinks = structuredClone(f.state.links);
    const op = operation('linkedin_update_sponsored_post', { ...target(before), commentary: 'Edited', landing_page: 'https://example.test/new', call_to_action: 'LEARN_MORE', dsc_name: 'Renamed' }, 'update');
    const preview = await f.provider.previewWrite(op, guard); expect(preview.changes[0]).toContain(U2); expect(mutation(f.calls)).toEqual([]);
    expect(await f.provider.applyWrite(op, guard)).toMatchObject({ details: { shared_post_updated: true, affected_creative_ids: [U2,U].sort() } });
    expect(mutation(f.calls)[0]!.body).toEqual({ patch: { $set: { commentary: 'Edited', contentLandingPage: 'https://example.test/new', contentCallToActionLabel: 'LEARN_MORE' }, adContext: { $set: { dscName: 'Renamed' } } } });
    expect(mutation(f.calls)[0]!.init.headers).toMatchObject({ 'X-RestLi-Method': 'PARTIAL_UPDATE' });
    expect(f.state.post.content).toEqual(originalContent); expect(f.state.links).toEqual(originalLinks);
    await expect(f.provider.previewWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
  });

  it.each(['post','association','organization','organic','foreign'] as const)('rejects stale or unowned post mutation: %s', async reason => {
    const f = fixture(), before = await context(f), op = operation('linkedin_update_sponsored_post', { ...target(before), commentary: 'Edited' }, 'update');
    if (reason === 'post') f.state.post.commentary = 'Changed by another actor';
    if (reason === 'association') f.state.links[1]!.intendedStatus = 'ACTIVE';
    if (reason === 'organization') f.state.account.reference = 'urn:li:organization:999';
    if (reason === 'organic') f.state.post.distribution.feedDistribution = 'MAIN_FEED';
    if (reason === 'foreign') f.state.post.adContext.dscAdAccount = 'urn:li:sponsoredAccount:999';
    await expect(f.provider.previewWrite(op, guard)).rejects.toThrow(); expect(mutation(f.calls)).toEqual([]);
  });

  it('keeps organic post reads read-only and propagates missing social permission without trying another route', async () => {
    const f = fixture(); delete f.state.post.adContext; f.state.post.distribution.feedDistribution = 'MAIN_FEED';
    expect((await f.provider.sponsored.postContext(A, { creative_id: U })).creatives[0]!.actions).toEqual([]);
    const denied = fixture(); denied.override(c => c.url.pathname.startsWith('/rest/posts/') ? Response.json({}, { status: 403 }) : undefined);
    await expect(context(denied)).rejects.toThrow('r_organization_social');
    expect(denied.calls.filter(c => c.url.pathname.startsWith('/rest/posts/'))).toHaveLength(1); expect(mutation(denied.calls)).toEqual([]);
  });

  it('does not present a mutable post URL as an article destination replacement', async () => {
    const f = fixture(); f.state.post.content = { article: { source: 'https://example.test/immutable', title: 'Article title' } }; f.state.post.contentLandingPage = 'https://example.test/ignored';
    const before = await context(f);
    expect(before.creatives[0]!.actions[0]!.fields.some(field => field.key === 'landing_page')).toBe(false);
    await expect(f.provider.previewWrite(operation('linkedin_update_sponsored_post', { ...target(before), landing_page: 'https://example.test/replacement' }, 'update'), guard)).rejects.toThrow('immutable article source');
    expect(mutation(f.calls)).toEqual([]);
  });

  it('archives with the native irreversible DSC transition and blocks deletion until all references are terminal', async () => {
    const f = fixture(), before = await context(f), args = target(before);
    await expect(f.provider.previewWrite(operation('linkedin_delete_sponsored_post', args, 'remove'), guard)).rejects.toThrow('remove or cancel');
    const archive = operation('linkedin_archive_sponsored_post', args, 'update'), preview = await f.provider.previewWrite(archive, guard);
    expect(preview.changes.join(' ')).toContain('cannot be undone');
    expect(await f.provider.applyWrite(archive, guard)).toMatchObject({ details: { dsc_status: 'ARCHIVED', irreversible: true, linked_creative_cancellation: 'REQUESTED' } });
    expect(mutation(f.calls)[0]!.body).toEqual({ patch: { adContext: { $set: { dscStatus: 'ARCHIVED' } } } });
    f.state.links.forEach(value => { value.intendedStatus = 'CANCELED'; });
    const latest = await context(f); await f.provider.applyWrite(operation('linkedin_delete_sponsored_post', target(latest), 'remove'), guard);
    expect(mutation(f.calls)[1]!.init).toMatchObject({ method: 'DELETE', headers: { 'X-RestLi-Method': 'DELETE' } });
  });

  it('rejects incomplete/repeated/foreign association collections without allowing a write', async () => {
    const f = fixture(); f.override(c => c.url.searchParams.has('contentReferences') ? { elements: f.state.links, metadata: { nextPageToken: 'same' } } : undefined);
    await expect(context(f)).rejects.toThrow('page mismatch'); expect(mutation(f.calls)).toEqual([]);
    const foreign = fixture(); foreign.state.links[0]!.content = { reference: 'urn:li:share:999' };
    await expect(context(foreign)).rejects.toThrow('reference/page mismatch');
  });

  it('retains created IDs or changed post IDs after failed readback and never repeats unknown writes', async () => {
    const f = fixture(); f.override(c => c.init.method === 'GET' && c.url.pathname.includes(encodeURIComponent(NEW)) ? Response.json({}, { status: 403 }) : undefined);
    await expect(f.provider.applyWrite(operation('linkedin_create_sponsored_ad', create({ type: 'TEXT' })), guard)).rejects.toMatchObject({ details: { resource_ids: [NEW] } });
    expect(mutation(f.calls)).toHaveLength(1);
    const post = fixture(), before = await context(post); post.override(c => c.init.method === 'POST' ? new Response(null, { status: 204 }) : undefined);
    await expect(post.provider.applyWrite(operation('linkedin_update_sponsored_post', { ...target(before), commentary: 'Unconfirmed' }, 'update'), guard)).rejects.toMatchObject({ details: { resource_ids: [P] } });
    expect(mutation(post.calls)).toHaveLength(1);
  });

  it.each(['denied','distribution','identity'] as const)('retains both IDs if the newly created post cannot be verified: %s', async reason => {
    const f = fixture(); f.override(c => c.init.method === 'GET' && c.url.pathname.startsWith('/rest/posts/') ? reason === 'denied' ? Response.json({}, { status: 403 }) : reason === 'identity' ? { ...f.state.post, id: 'urn:li:ugcPost:999' } : { ...f.state.post, distribution: { feedDistribution: 'MAIN_FEED' } } : undefined);
    await expect(f.provider.applyWrite(operation('linkedin_create_sponsored_ad', create({ type: 'TEXT' })), guard)).rejects.toMatchObject({ details: { resource_ids: [NEW,P] } });
    expect(mutation(f.calls)).toHaveLength(1);
  });

  it('keeps exact arguments, protected accounts and single-use approvals on the shared tool path', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>();
    const stores = { async sweep() {}, async put(value: PendingOperation) { pending.set(value.id, value); }, async get(id: string) { return pending.get(id); }, async delete(id: string) { pending.delete(id); }, async consume(id: string, expectedHash: string) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } };
    const rt = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, stores, { async append() {} }), providerModules: [{ provider: f.provider, tools: linkedinTools(f.provider) }] });
    const input = { account_id: A, ...create({ type: 'TEXT' }) }, preview = await rt.registry.call('linkedin_create_sponsored_ad', input, rt.ctx) as { pending_operation_id: string };
    await expect(rt.registry.call('linkedin_create_sponsored_ad', { ...input, commentary: 'Changed', pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(mutation(f.calls)).toEqual([]);
    expect(await rt.registry.call('linkedin_create_sponsored_ad', { ...input, pending_operation_id: preview.pending_operation_id }, rt.ctx)).toMatchObject({ applied: true });
    await expect(rt.registry.call('linkedin_create_sponsored_ad', { ...input, pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
    const denied = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, stores, { async append() {} });
    await expect(denied.validate(f.provider, operation('linkedin_create_sponsored_ad', create({ type: 'TEXT' })))).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(mutation(f.calls)).toHaveLength(1);
  });
});
