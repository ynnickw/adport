import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { LinkedInAdsClient, LINKEDIN_API_VERSION } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';

// Native wire fixtures checked against LinkedIn-owned Creatives, Lead Forms,
// campaign objectives and Document Ads 202608 contracts on 2026-11-05.
const A = '7', C = '8', C2 = '18', F = '6755260984438374401', F2 = '6755260984438374402', U = 'urn:li:sponsoredCreative:9', NEW = 'urn:li:sponsoredCreative:29';
const AU = `urn:li:sponsoredAccount:${A}`, O = 'urn:li:organization:11', P = 'urn:li:ugcPost:10', NP = 'urn:li:share:20', I = 'urn:li:image:fixture', D = 'urn:li:document:fixture', V = 'urn:li:video:fixture';
type Row = Record<string, any>;
type Call = { url: URL; init: RequestInit; body?: Row };
const guard = { forcePausedCreation: true }, dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture() {
  const campaign = { id: Number(C), account: AU, status: 'PAUSED', name: 'QA', type: 'SPONSORED_UPDATES', objectiveType: 'LEAD_GENERATION', associatedEntity: O, format: 'LEAD_GENERATION_FORM_SPONSORED_CONTENT' };
  const form = { id: F, owner: { sponsoredAccount: AU }, name: 'QA form', state: 'DRAFT', creationLocale: { language: 'en', country: 'US' }, content: { headline: { localized: { en_US: 'QA only' } }, questions: [], legalInfo: {} }, versionId: 1 };
  const state = { campaign: { ...campaign } as Row, target: { ...campaign, id: Number(C2) } as Row, form: { ...form } as Row, secondForm: { ...form, id: F2, name: 'Second QA form' } as Row,
    creative: { id: U, account: AU, campaign: `urn:li:sponsoredCampaign:${C}`, name: 'QA creative', intendedStatus: 'DRAFT', content: { reference: P }, leadgenCallToAction: { destination: `urn:li:adForm:${F}`, label: 'LEARN_MORE' } } as Row,
    created: undefined as Row | undefined, post: { id: P, author: O, commentary: 'Source post', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', distribution: { feedDistribution: 'NONE', thirdPartyDistributionChannels: [] }, isReshareDisabledByAuthor: true, adContext: { dscAdAccount: AU, dscStatus: 'ACTIVE' }, content: { media: { id: I, title: 'QA image' } } } as Row,
    newPost: undefined as Row | undefined, scan: [] as Row[] };
  const calls: Call[] = []; let override: ((c: Call) => unknown | Response) | undefined;
  const client = new LinkedInAdsClient({ accessToken: 'synthetic-token' }, async (url, init = {}) => {
    const call: Call = { url: new URL(String(url)), init, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) }; calls.push(call);
    const special = override?.(call); if (special !== undefined) return special instanceof Response ? special : Response.json(special);
    const target = decodeURIComponent(call.url.pathname).replace('/rest/', '');
    if (init.method === 'GET') {
      if (target === `adAccounts/${A}`) return Response.json({ id: Number(A), name: 'QA account', currency: 'USD', status: 'DRAFT' });
      if (target === `adAccounts/${A}/adCampaigns/${C}`) return Response.json(state.campaign);
      if (target === `adAccounts/${A}/adCampaigns/${C2}`) return Response.json(state.target);
      if (target === `leadForms/${F}`) return Response.json(state.form);
      if (target === `leadForms/${F2}`) return Response.json(state.secondForm);
      if (target === `adAccounts/${A}/creatives/${U}`) return Response.json(state.creative);
      if (target === `adAccounts/${A}/creatives/${NEW}`) return Response.json(state.created);
      if (target === `adAccounts/${A}/creatives`) return Response.json({ elements: state.scan });
      if (target === `posts/${P}`) return Response.json(state.post);
      if (target === `posts/${NP}`) return Response.json(state.newPost);
      if (target === 'images') return Response.json({ elements: [{ id: I, owner: AU, status: 'AVAILABLE', mediaLibraryMetadata: { associatedAccount: AU, mediaLibraryStatus: 'ACTIVE', assetName: 'QA' } }] });
      if (target === 'videos') return Response.json({ elements: [{ id: V, owner: O, status: 'AVAILABLE', mediaLibraryMetadata: { associatedAccount: AU, assetName: 'QA video', mediaLibraryStatus: 'ACTIVE' } }] });
      if (target === `documents/${D}`) return Response.json({ id: D, owner: AU, status: 'AVAILABLE' });
    }
    if (init.method === 'POST' && target === `adAccounts/${A}/creatives/${U}`) { state.creative = { ...state.creative, ...call.body!.patch.$set }; return new Response(null, { status: 204 }); }
    if (init.method === 'POST' && target === 'posts') { state.newPost = { id: NP, ...call.body! }; return new Response(null, { status: 201, headers: { 'x-restli-id': encodeURIComponent(NP) } }); }
    if (init.method === 'POST' && target === `adAccounts/${A}/creatives`) { const fields = call.body!.creative ?? call.body!; if (fields.inlineContent?.post) state.newPost = { id: NP, ...fields.inlineContent.post }; const { inlineContent: _inline, ...rest } = fields; state.created = { id: NEW, account: AU, ...rest, ...(fields.inlineContent ? { content: state.target.format === 'SPONSORED_UPDATE_NATIVE_DOCUMENT' ? { documentAd: { reference: NP } } : { reference: NP } } : {}) }; return new Response(null, { status: 201, headers: { 'x-restli-id': encodeURIComponent(NEW) } }); }
    throw new Error(`Unexpected ${init.method} ${target}`);
  });
  return { provider: new LinkedInAdsProvider(client), state, calls, override: (fn: typeof override) => { override = fn; } };
}
const writes = (calls: Call[]) => calls.filter(c => ['POST', 'PUT', 'DELETE'].includes(c.init.method ?? 'GET'));
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'linkedin', accountId: A, payload, kind });
async function update(f: ReturnType<typeof fixture>, form = F2) { const current = await f.provider.leadCreatives.get(A, U), candidate = await f.provider.leadForms.get(A, form); return { creative_id: U, expected_creative_hash: current.creative_snapshot_hash, expected_campaign_hash: current.campaign_snapshot_hash, form_id: form, expected_form_hash: candidate.form.snapshot_hash, label: 'DOWNLOAD' }; }
async function create(f: ReturnType<typeof fixture>, content: Row = { type: 'IMAGE', image_id: I, title: 'QA image' }) {
  const ctx = await f.provider.leadCreatives.context({ account_id: A, campaign_id: C2, form_id: F, source_creative_id: U });
  return { campaign_id: C2, name: 'New QA', status: 'DRAFT', non_political_consent: true, author_organization: O, commentary: 'Synthetic QA only', content,
    lead_form: { form_id: F, expected_form_hash: ctx.form.snapshot_hash, expected_campaign_hash: ctx.campaign_snapshot_hash, label: 'LEARN_MORE', confirm_public_post: true } };
}

describe('LinkedIn lead creative association', () => {
  it('defines shared lazy tools and exposes the create workflow on existing named tools', () => {
    const tools = linkedinTools(new Proxy({} as LinkedInAdsProvider, { get() { throw new Error('Eager provider'); } }));
    expect(new Set(tools.map(t => t.name)).size).toBe(tools.length);
    expect(tools.find(t => t.name === 'linkedin_set_creative_lead_form')?.annotations).toMatchObject({ readOnly: false });
    expect(tools.find(t => t.name === 'linkedin_creative_lead_form')?.presentation).toBe('creatives');
    expect(tools.find(t => t.name === 'linkedin_create_sponsored_ad')?.input.shape.lead_form).toBeDefined();
    const context = tools.find(t => t.name === 'linkedin_lead_ad_context')!;
    for (const form_id of ['not-an-id', '1e12', '9223372036854775808']) expect(context.input.safeParse({ account_id: A, form_id }).success).toBe(false);
  });
  it('returns exact form IDs and a compact view-only card without exposing submitted leads', async () => {
    const f = fixture(), result = await f.provider.leadCreatives.get(A, U);
    expect(result).toMatchObject({ form: { id: F }, creatives: [{ status: 'DRAFT', actions: [] }] });
    expect(result.creatives[0]!.descriptions).toContain('Lead form: QA form'); expect(f.calls.some(c => /leadFormResponses/.test(c.url.pathname))).toBe(false); expect(writes(f.calls)).toEqual([]);
  });
  it('hydrates native creative copy and a verified CDN preview while keeping the gallery view-only', async () => {
    const f = fixture(); f.override(c => {
      if (c.init.method === 'HEAD') return new Response(null, { headers: { 'content-type': 'image/png' } });
      if (c.url.searchParams.has('fields')) return { ...f.state.creative, metadata: { adHeadline: 'Native headline', adIntroductionText: 'Native copy', assetURL: 'https://media.licdn.com/qa.png' } };
    });
    const result = await f.provider.leadCreatives.get(A, U, true);
    expect(result.creatives[0]).toMatchObject({ headlines: ['Native headline'], media: [{ type: 'image', url: 'https://media.licdn.com/qa.png' }], actions: [] });
    expect(result.creatives[0]!.descriptions).toContain('Lead form: QA form'); expect(f.calls.find(c => c.init.method === 'HEAD')!.init.headers).toBeUndefined(); expect(writes(f.calls)).toEqual([]);
  });
  it('permits a form-only context before a campaign exists and binds campaign/source when selected', async () => {
    const f = fixture(); expect(await f.provider.leadCreatives.context({ account_id: A, form_id: F })).toMatchObject({ form: { id: F } });
    const ctx = await f.provider.leadCreatives.context({ account_id: A, campaign_id: C2, form_id: F, source_creative_id: U });
    expect(ctx.campaign_snapshot_hash).toMatch(/^[a-f0-9]{64}$/); expect(ctx.source_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('replaces a DRAFT destination using the documented top-level partial update, preserving content and status', async () => {
    const f = fixture(), input = await update(f), before = structuredClone(f.state.creative);
    const preview = await f.provider.previewWrite(op('linkedin_set_creative_lead_form', input), guard);
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], review: { fields: [{ label: 'Lead form', before: `urn:li:adForm:${F}`, after: `urn:li:adForm:${F2}` }, { label: 'Call to action', before: 'LEARN_MORE', after: 'DOWNLOAD' }] } }); expect(writes(f.calls)).toEqual([]);
    expect(await f.provider.applyWrite(op('linkedin_set_creative_lead_form', input), guard)).toMatchObject({ applied: true, resourceIds: [U] });
    const wire = writes(f.calls)[0]!; expect(wire.url.pathname).toBe(`/rest/adAccounts/${A}/creatives/${encodeURIComponent(U)}`);
    expect(wire.body).toEqual({ patch: { $set: { leadgenCallToAction: { destination: `urn:li:adForm:${F2}`, label: 'DOWNLOAD' } } } });
    expect(wire.init.headers).toMatchObject({ 'Linkedin-Version': LINKEDIN_API_VERSION, 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'PARTIAL_UPDATE' });
    expect(f.state.creative).toEqual({ ...before, leadgenCallToAction: { destination: `urn:li:adForm:${F2}`, label: 'DOWNLOAD' } });
  });
  it.each(['ACTIVE', 'PAUSED'])('allows an existing-form label edit but rejects a destination change for %s', async status => {
    const f = fixture(); f.state.creative.intendedStatus = status;
    await expect(f.provider.previewWrite(op('linkedin_set_creative_lead_form', await update(f)), guard)).rejects.toThrow('DRAFT');
    await f.provider.applyWrite(op('linkedin_set_creative_lead_form', await update(f, F)), guard);
    expect(f.state.creative.intendedStatus).toBe(status); expect(f.state.creative.leadgenCallToAction.destination).toBe(`urn:li:adForm:${F}`); expect(writes(f.calls)).toHaveLength(1);
  });
  it.each(['creative', 'campaign', 'form'] as const)('rejects stale %s configuration before any write', async changed => {
    const f = fixture(), input = await update(f);
    if (changed === 'creative') f.state.creative.name = 'Changed';
    if (changed === 'campaign') f.state.campaign.status = 'ACTIVE';
    if (changed === 'form') f.state.secondForm.name = 'Changed';
    await expect(f.provider.previewWrite(op('linkedin_set_creative_lead_form', input), guard)).rejects.toThrow('changed'); expect(writes(f.calls)).toEqual([]);
  });
  it.each(['foreign-creative', 'foreign-form', 'archived-form', 'archived-creative', 'non-lead-campaign'] as const)('rejects ineligible context: %s', async changed => {
    const f = fixture(), input = await update(f);
    if (changed === 'foreign-creative') f.state.creative.account = 'urn:li:sponsoredAccount:999';
    if (changed === 'foreign-form') f.state.secondForm.owner = { sponsoredAccount: 'urn:li:sponsoredAccount:999' };
    if (changed === 'archived-form') f.state.secondForm.state = 'ARCHIVED';
    if (changed === 'archived-creative') f.state.creative.intendedStatus = 'ARCHIVED';
    if (changed === 'non-lead-campaign') f.state.campaign.objectiveType = 'WEBSITE_VISITS';
    await expect(f.provider.previewWrite(op('linkedin_set_creative_lead_form', input), guard)).rejects.toThrow(); expect(writes(f.calls)).toEqual([]);
  });
  it('can repair a DRAFT creative pointing to an archived form', async () => {
    const f = fixture(); f.state.form.state = 'ARCHIVED';
    await f.provider.applyWrite(op('linkedin_set_creative_lead_form', await update(f)), guard); expect(f.state.creative.leadgenCallToAction.destination).toBe(`urn:li:adForm:${F2}`);
  });
  it('retains identity after unconfirmed readback and never replays a mutation', async () => {
    const f = fixture(), input = await update(f);
    f.override(c => c.init.method === 'POST' ? new Response(null, { status: 204 }) : undefined);
    await expect(f.provider.applyWrite(op('linkedin_set_creative_lead_form', input), guard)).rejects.toMatchObject({ details: { resource_ids: [U] } }); expect(writes(f.calls)).toHaveLength(1);
  });
  it('routes a label change through a single-use policy token and audit', async () => {
    const f = fixture(), dir = await mkdtemp(path.join(tmpdir(), 'adport-lead-creative-')); dirs.push(dir);
    const runtime = await createContext({ providerModules: [{ provider: f.provider, tools: linkedinTools(f.provider) }], engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))) });
    const args = { account_id: A, ...await update(f) }, preview = await runtime.registry.call('linkedin_set_creative_lead_form', args, runtime.ctx) as { pending_operation_id: string };
    expect(writes(f.calls)).toEqual([]); await runtime.registry.call('linkedin_set_creative_lead_form', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    await expect(runtime.registry.call('linkedin_set_creative_lead_form', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow(); expect(writes(f.calls)).toHaveLength(1);
    const audit = (await Promise.all((await readdir(path.join(dir, 'audit'))).map(file => readFile(path.join(dir, 'audit', file), 'utf8')))).join(''); expect(audit).toContain('applied');
  });
});

describe('LinkedIn lead-ad creation', () => {
  it('creates an ordinary DRAFT lead ad through the existing inline API, retaining both IDs', async () => {
    const f = fixture(), input = await create(f);
    await f.provider.previewWrite(op('linkedin_create_sponsored_ad', input, 'create'), guard); expect(writes(f.calls)).toEqual([]);
    const value = await f.provider.applyWrite(op('linkedin_create_sponsored_ad', input, 'create'), guard);
    expect(value).toMatchObject({ resourceIds: [NEW, NP], details: { intended_status: 'DRAFT', post_id: NP, post_readback_verified: true } });
    const wire = writes(f.calls); expect(wire.map(c => decodeURIComponent(c.url.pathname))).toEqual([`/rest/adAccounts/${A}/creatives`]); expect(wire[0]!.url.search).toBe('?action=createInline');
    expect(wire[0]!.body!.creative.inlineContent.post).toMatchObject({ visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', distribution: { feedDistribution: 'NONE' }, isReshareDisabledByAuthor: true });
    expect(wire[0]!.body!.creative).toMatchObject({ campaign: `urn:li:sponsoredCampaign:${C2}`, name: input.name, intendedStatus: 'DRAFT', leadgenCallToAction: { destination: `urn:li:adForm:${F}`, label: 'LEARN_MORE' } });
  });
  it.each(['VIDEO', 'CAROUSEL'] as const)('uses the native lead campaign/content mapping for %s', async kind => {
    const f = fixture(); f.state.target.format = kind === 'VIDEO' ? 'VIDEO_LEAD_GENERATION_FORM_SPONSORED_CONTENT' : 'LEAD_GENERATION_FORM_CAROUSEL_SPONSORED_CONTENT';
    const content = kind === 'VIDEO' ? { type: kind, video_id: V, title: 'QA video' } : { type: kind, cards: [1, 2].map(index => ({ image_id: I, title: `QA card ${index}`, landing_page: 'https://example.invalid/qa' })) };
    await f.provider.applyWrite(op('linkedin_create_sponsored_ad', await create(f, content), 'create'), guard);
    const requests = writes(f.calls); expect(requests).toHaveLength(1); expect(requests[0]!.body!.creative.leadgenCallToAction).toEqual({ destination: `urn:li:adForm:${F}`, label: 'LEARN_MORE' });
    if (kind === 'VIDEO') expect(requests[0]!.body!.creative.inlineContent.post.content.media.id).toBe(V);
    else expect(requests[0]!.body!.creative.inlineContent.post.content.carousel.cards).toHaveLength(2);
  });
  it('never submits a gated document creative after an unconfirmed post receipt', async () => {
    const f = fixture(); f.state.target.format = 'SPONSORED_UPDATE_NATIVE_DOCUMENT'; const input = await create(f, { type: 'DOCUMENT', document_id: D, title: 'QA document' }); input.lead_form = { ...input.lead_form, gated_preview_page_count: 2 } as typeof input.lead_form;
    f.override(c => c.init.method === 'POST' && c.url.pathname === '/rest/posts' ? new Response(null, { status: 201, headers: { 'x-restli-id': 'unconfirmed' } }) : undefined);
    await expect(f.provider.applyWrite(op('linkedin_create_sponsored_ad', input, 'create'), guard)).rejects.toThrow('post create'); expect(writes(f.calls)).toHaveLength(1);
  });
  it('coerces requested ACTIVE to PAUSED and reports the adjustment', async () => {
    const f = fixture(), input = { ...await create(f), status: 'ACTIVE' };
    const preview = await f.provider.previewWrite(op('linkedin_create_sponsored_ad', input, 'create'), guard); expect(preview.coercions).toContain('intendedStatus coerced to PAUSED by policy (paused_creation)');
    await f.provider.applyWrite(op('linkedin_create_sponsored_ad', input, 'create'), guard); expect(f.state.created!.intendedStatus).toBe('PAUSED');
  });
  it('requires publication acknowledgment and exact campaign/form hashes before creating a public dark post', async () => {
    const f = fixture(), input = await create(f);
    for (const lead_form of [{ ...input.lead_form, confirm_public_post: undefined }, { ...input.lead_form, expected_form_hash: '0'.repeat(64) }, { ...input.lead_form, expected_campaign_hash: '0'.repeat(64) }]) await expect(f.provider.previewWrite(op('linkedin_create_sponsored_ad', { ...input, lead_form }, 'create'), guard)).rejects.toThrow();
    expect(writes(f.calls)).toEqual([]);
  });
  it('preserves the created post ID if the gated creative POST fails, with no replay', async () => {
    const f = fixture(); f.state.target.format = 'SPONSORED_UPDATE_NATIVE_DOCUMENT'; const input = await create(f, { type: 'DOCUMENT', document_id: D, title: 'QA document' }); input.lead_form = { ...input.lead_form, gated_preview_page_count: 2 } as typeof input.lead_form;
    f.override(c => c.init.method === 'POST' && c.url.pathname.endsWith('/creatives') ? Response.json({ message: 'Rejected' }, { status: 400 }) : undefined);
    await expect(f.provider.applyWrite(op('linkedin_create_sponsored_ad', input, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [NP] } }); expect(writes(f.calls)).toHaveLength(2);
  });
  it('reuses an existing owned image post without another publication, with a source hash', async () => {
    const f = fixture(); f.state.campaign.format = 'STANDARD_UPDATE'; f.state.campaign.objectiveType = 'BRAND_AWARENESS';
    const input = await create(f), { author_organization: _author, commentary: _copy, content: _content, ...rest } = input;
    const ctx = await f.provider.leadCreatives.context({ account_id: A, form_id: F, campaign_id: C2, source_creative_id: U });
    await f.provider.applyWrite(op('linkedin_create_reference_ad', { ...rest, source_creative_id: U, lead_form: { ...rest.lead_form, expected_source_hash: ctx.source_snapshot_hash } }, 'create'), guard);
    expect(writes(f.calls)).toHaveLength(1); expect(writes(f.calls)[0]!.body!.content).toEqual({ reference: P });
  });
  it.each([0, 2])('requires an unused document and retains gated preview pages=%s without reference reuse', async pages => {
    const f = fixture(); f.state.campaign.format = 'SPONSORED_UPDATE_NATIVE_DOCUMENT'; f.state.target.format = 'SPONSORED_UPDATE_NATIVE_DOCUMENT';
    const input = await create(f, { type: 'DOCUMENT', document_id: D, title: 'QA document' }); input.lead_form = { ...input.lead_form, gated_preview_page_count: pages } as typeof input.lead_form;
    await f.provider.applyWrite(op('linkedin_create_sponsored_ad', input, 'create'), guard);
    expect(writes(f.calls)[1]!.body!.content).toEqual({ documentAd: { reference: NP, gatedLeadgenPreviewPageCount: pages } });
    const ctx = await f.provider.leadCreatives.context({ account_id: A, form_id: F, campaign_id: C2, source_creative_id: U });
    await expect(f.provider.previewWrite(op('linkedin_create_reference_ad', { campaign_id: C2, source_creative_id: U, name: 'Reuse', non_political_consent: true, lead_form: { ...input.lead_form, expected_source_hash: ctx.source_snapshot_hash } }, 'create'), guard)).rejects.toThrow('fresh document');
  });
  it('rejects previously referenced document bytes even when the old creative is canceled', async () => {
    const f = fixture(); f.state.target.format = 'SPONSORED_UPDATE_NATIVE_DOCUMENT'; f.state.scan = [{ ...f.state.creative, intendedStatus: 'CANCELED', content: { documentAd: { reference: P } } }]; f.state.post.content = { media: { id: D } };
    await expect(f.provider.previewWrite(op('linkedin_create_sponsored_ad', await create(f, { type: 'DOCUMENT', document_id: D, title: 'QA' }), 'create'), guard)).rejects.toThrow('already referenced'); expect(writes(f.calls)).toEqual([]);
  });
  it.each(['empty-next', 'repeated-id', 'foreign', 'post-read-denied'])('stops unconfirmed document-use scans before any upload/publication: %s', async reason => {
    const f = fixture(); f.state.target.format = 'SPONSORED_UPDATE_NATIVE_DOCUMENT';
    f.override(c => {
      if (c.url.pathname.endsWith('/creatives') && c.init.method === 'GET') return reason === 'empty-next' ? { elements: [], metadata: { nextPageToken: 'next' } } : { elements: reason === 'repeated-id' ? [f.state.creative, f.state.creative] : [{ ...f.state.creative, ...(reason === 'foreign' ? { account: 'urn:li:sponsoredAccount:99' } : {}) }] };
      if (reason === 'post-read-denied' && c.url.pathname.includes('/posts/')) return Response.json({}, { status: 403 });
    });
    await expect(f.provider.previewWrite(op('linkedin_create_sponsored_ad', await create(f, { type: 'DOCUMENT', document_id: D, title: 'QA' }), 'create'), guard)).rejects.toThrow(); expect(writes(f.calls)).toEqual([]);
  });
});
