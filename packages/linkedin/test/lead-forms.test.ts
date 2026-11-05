import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { LinkedInAdsClient, LINKEDIN_API_VERSION } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';

// Synthetic fixtures checked against official Marketing202608 leadForms and
// lead-sync-schema, plus Rest.li partial-update wire contracts, 2026-11-05.
const A = '551000001', FORM = '6755260984438374401', NEW = '6755260984438374402', urn = `urn:li:sponsoredAccount:${A}`;
const localized = (value: string) => ({ localized: { en_US: value } });
const content = () => ({ headline: localized('Synthetic QA headline'), description: localized('Not for publication'), questions: [{ name: 'firstName', question: localized('First name'), predefinedField: 'FIRST_NAME', questionDetails: { textQuestionDetails: {} } }], legalInfo: { privacyPolicyUrl: 'https://example.invalid/privacy', legalDisclaimer: localized('Synthetic QA only'), consents: [] }, postSubmissionInfo: { message: localized('Synthetic thank you'), callToAction: { callToActionLabel: 'VISIT_COMPANY_WEBSITE', callToActionTarget: { landingPageUrl: 'https://example.invalid' } } } });
const native = () => ({ id: FORM, owner: { sponsoredAccount: urn }, creationLocale: { country: 'US', language: 'en' }, name: 'Synthetic QA form', state: 'DRAFT', content: content(), hiddenFields: [], versionId: 1, versionTag: '1', created: 1700000000000, lastModified: 1700000000000, vendorField: 'preserve' });
type Call = { url: URL; init: RequestInit };
const data = (call: Call) => JSON.parse(String(call.init.body), (_key, value: unknown, context?: { source?: string }) => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context!.source! : value);
const response = (value: unknown) => new Response(JSON.stringify(value).replace(/"(id|questionId|legalInfoId)":"(\d{16,19})"/g, '"$1":$2'), { headers: { 'content-type': 'application/json' } });
function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '$set') Object.assign(target, value);
    else if (key === '$delete') for (const field of value as string[]) delete target[field];
    else throw new Error('leadForms rejects nested partial updates (native HTTP400, 2026-11-05)');
  }
}
function fixture(custom?: (call: Call) => Response | undefined) {
  const calls: Call[] = [], state = { forms: [native()] as Array<Record<string, unknown>> };
  const client = new LinkedInAdsClient({ accessToken: 'synthetic-only' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const result = custom?.(call); if (result) return result;
    const resource = call.url.pathname;
    if (resource === `/rest/adAccounts/${A}`) return response({ id: Number(A), name: 'QA account', currency: 'USD', status: 'DRAFT' });
    if (resource === '/rest/leadForms' && init.method === 'GET') { const start = Number(call.url.searchParams.get('start')), count = Number(call.url.searchParams.get('count')); return response({ elements: state.forms.slice(start, start + count), paging: { start, count, total: state.forms.length, links: [] } }); }
    if (resource === '/rest/leadForms' && init.method === 'POST') {
      const value = { ...data(call), id: NEW, versionId: 1, created: 1700000000001, lastModified: 1700000000001 };
      value.content.questions = value.content.questions.map((question: Record<string, unknown>) => ({ ...question, questionId: '6755260984438374491', responseEditable: true, responseRequired: true }));
      state.forms.push(value); return new Response(null, { status: 201, headers: { 'x-restli-id': NEW } });
    }
    if (resource.startsWith('/rest/leadForms/')) {
      const value = state.forms.find(form => form.id === resource.split('/').at(-1));
      if (!value) return response({ status: 404 });
      if (init.method === 'GET') return response(value);
      if (init.method === 'POST') { applyPatch(value, data(call).patch); return new Response(null, { status: 204 }); }
    }
    throw new Error(`Unexpected ${init.method} ${resource}`);
  });
  return { provider: new LinkedInAdsProvider(client), client, calls, state };
}
const mutations = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET');
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'linkedin', accountId: A, tool, kind, payload });
const guard = { forcePausedCreation: true }, dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function reference(provider: LinkedInAdsProvider) { return { form_id: FORM, expected_snapshot_hash: (await provider.leadForms.get(A, FORM)).form.snapshot_hash }; }
async function creation(provider: LinkedInAdsProvider) { return { expected_account_hash: (await provider.leadForms.list({ account_id: A })).account_snapshot_hash, name: 'New synthetic form', creation_locale: { country: 'US', language: 'en' }, content: content() }; }

describe('LinkedIn lead form configuration', () => {
  it('defines the shared lazy tools once with truthful hints and no submitted-lead endpoint', () => {
    const tools = linkedinTools(new Proxy({} as LinkedInAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    for (const name of ['linkedin_lead_forms', 'linkedin_get_lead_form', 'linkedin_create_lead_form_draft', 'linkedin_update_lead_form', 'linkedin_archive_lead_form']) expect(tools.filter(tool => tool.name === name)).toHaveLength(1);
    expect(tools.find(tool => tool.name === 'linkedin_create_lead_form_draft')).toMatchObject({ catalog: { category: 'creatives' }, annotations: { readOnly: false, destructive: false } });
    expect(tools.find(tool => tool.name === 'linkedin_update_lead_form')).toMatchObject({ annotations: { readOnly: false, destructive: true } });
    expect(tools.some(tool => /lead_form_responses|lead_notifications/.test(tool.name))).toBe(false);
  });
  it('uses the native owner union finder, exact headers and 64-bit integer wire ID', async () => {
    const f = fixture(), value = await f.provider.leadForms.list({ account_id: A, count: 10 });
    expect(f.calls.at(-1)!.url.search).toBe(`?q=owner&owner=(sponsoredAccount:urn%3Ali%3AsponsoredAccount%3A${A})&start=0&count=10`);
    expect(f.calls.at(-1)!.init.headers).toMatchObject({ 'Linkedin-Version': LINKEDIN_API_VERSION, 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'FINDER' });
    expect(value).toMatchObject({ elements: [{ id: FORM }], records: [{ id: FORM, status: 'DRAFT', questions: 1 }], complete: true, truncated: false });
    expect(value.elements[0]!.id).not.toBe(String(Number(FORM))); expect(mutations(f.calls)).toEqual([]);
  });
  it('preserves large numeric nested IDs and numeric-looking strings without modifying safe integers', async () => {
    const f = fixture(); const c = f.state.forms[0]!.content as Record<string, unknown>;
    c.questions = [{ questionId: '6755260984438374491', question: localized('6755260984438374401'), questionDetails: { textQuestionDetails: { maxResponseLength: 300 } } }];
    const value = await f.provider.leadForms.get(A, FORM);
    expect(value.form.content.questions).toMatchObject([{ questionId: '6755260984438374491', question: localized(FORM), questionDetails: { textQuestionDetails: { maxResponseLength: 300 } } }]);
    expect(f.calls.at(-1)!.url.pathname).toBe(`/rest/leadForms/${FORM}`);
  });
  it.each([{ owner: { sponsoredAccount: 'urn:li:sponsoredAccount:551000002' } }, { owner: { organization: 'urn:li:organization:123' } }, { id: '6755260984438374403' }])('rejects foreign or mismatched form metadata %#', async change => {
    const f = fixture(call => call.url.pathname === `/rest/leadForms/${FORM}` ? response({ ...native(), ...change }) : undefined);
    await expect(f.provider.leadForms.get(A, FORM)).rejects.toThrow('owner or ID'); expect(mutations(f.calls)).toEqual([]);
  });
  it('uses native paging without following a foreign next URL', async () => {
    const f = fixture(call => call.url.pathname === '/rest/leadForms' ? response({ elements: [native()], paging: { start: 0, count: 10, total: -1, links: [{ rel: 'next', href: 'https://foreign.invalid/?start=9' }] } }) : undefined);
    expect(await f.provider.leadForms.list({ account_id: A, count: 10 })).toMatchObject({ next_start: 1, complete: false, truncated: true, paging: { total: -1 } });
    expect(f.calls.every(call => call.url.hostname === 'api.linkedin.com')).toBe(true);
  });
  it('rejects duplicate identities and contradictory empty pages', async () => {
    for (const page of [{ elements: [native(), native()], paging: { start: 0, count: 25 } }, { elements: [], paging: { start: 0, count: 25, total: 1 } }]) {
      const f = fixture(call => call.url.pathname === '/rest/leadForms' ? response(page) : undefined);
      await expect(f.provider.leadForms.list({ account_id: A })).rejects.toThrow(); expect(mutations(f.calls)).toEqual([]);
    }
  });
  it('binds question ordering and unknown fields in the snapshot, independently of unchanged modification times', async () => {
    const f = fixture(), first = await reference(f.provider); f.state.forms[0]!.name = 'Changed without timestamp';
    expect((await reference(f.provider)).expected_snapshot_hash).not.toBe(first.expected_snapshot_hash);
    await expect(f.provider.previewWrite(op('linkedin_update_lead_form', { ...first, name: 'Stale write' }), guard)).rejects.toThrow('snapshot'); expect(mutations(f.calls)).toEqual([]);
    const c = f.state.forms[0]!.content as Record<string, unknown>; c.questions = [...content().questions, { ...content().questions[0]!, name: 'other' }];
    const ordered = await reference(f.provider); (c.questions as unknown[]).reverse();
    expect((await reference(f.provider)).expected_snapshot_hash).not.toBe(ordered.expected_snapshot_hash);
    const beforeUnknown = await reference(f.provider); f.state.forms[0]!.vendorField = 'changed';
    expect((await reference(f.provider)).expected_snapshot_hash).not.toBe(beforeUnknown.expected_snapshot_hash);
  });
  it('creates only a DRAFT with native request shape and independently checks its exact returned ID', async () => {
    const f = fixture(), input = await creation(f.provider), operation = op('linkedin_create_lead_form_draft', input, 'create');
    const preview = await f.provider.previewWrite(operation, guard); expect(preview.review?.fields).toContainEqual({ label: 'State', after: 'DRAFT' }); expect(mutations(f.calls)).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [NEW] });
    expect(data(mutations(f.calls)[0]!)).toEqual({ owner: { sponsoredAccount: urn }, name: input.name, creationLocale: input.creation_locale, content: input.content, hiddenFields: [], state: 'DRAFT' });
    expect(f.calls.at(-1)!.url.pathname).toBe(`/rest/leadForms/${NEW}`);
    expect(f.calls.some(call => /leadFormResponses|leadNotifications|creatives/.test(call.url.pathname))).toBe(false);
  });
  it('renames via a single top-level partial update and shows the observed old name', async () => {
    const f = fixture(), operation = op('linkedin_update_lead_form', { ...await reference(f.provider), name: 'Renamed QA' });
    expect((await f.provider.previewWrite(operation, guard)).review?.fields).toEqual([{ label: 'Name', before: 'Synthetic QA form', after: 'Renamed QA' }]);
    expect(mutations(f.calls)).toEqual([]); await f.provider.applyWrite(operation, guard);
    expect(data(mutations(f.calls)[0]!)).toEqual({ patch: { $set: { name: 'Renamed QA' } } });
    expect(mutations(f.calls)[0]!.init.headers).toMatchObject({ 'X-RestLi-Method': 'PARTIAL_UPDATE' }); expect(f.state.forms[0]).toMatchObject({ name: 'Renamed QA', state: 'DRAFT', vendorField: 'preserve', content: content() });
  });
  it('uses a top-level content set preserving questions, exact native IDs and unknown fields', async () => {
    const f = fixture(), c = f.state.forms[0]!.content as Record<string, unknown>; c.vendorContent = 'preserve'; (c.legalInfo as Record<string, unknown>).legalInfoId = '6755260984438374491';
    await f.provider.applyWrite(op('linkedin_update_lead_form', { ...await reference(f.provider), content: { headline: localized('New headline'), legalInfo: { privacyPolicyUrl: 'https://example.invalid/new' } } }), guard);
    expect(data(mutations(f.calls)[0]!)).toEqual({ patch: { $set: { content: { ...content(), vendorContent: 'preserve', headline: localized('New headline'), legalInfo: { ...content().legalInfo, legalInfoId: '6755260984438374491', privacyPolicyUrl: 'https://example.invalid/new' } } } } });
    expect(String(mutations(f.calls)[0]!.init.body)).toContain('"legalInfoId":6755260984438374491');
    expect(f.state.forms[0]!.content).toMatchObject({ vendorContent: 'preserve', questions: content().questions, legalInfo: { legalInfoId: '6755260984438374491', consents: [], legalDisclaimer: localized('Synthetic QA only') } });
  });
  it('clears only the requested optional field in the merged content', async () => {
    const f = fixture(); await f.provider.applyWrite(op('linkedin_update_lead_form', { ...await reference(f.provider), clear_fields: ['legal_disclaimer'] }), guard);
    expect(data(mutations(f.calls)[0]!)).toEqual({ patch: { $set: { content: { ...content(), legalInfo: { privacyPolicyUrl: 'https://example.invalid/privacy', consents: [] } } } } });
    expect((f.state.forms[0]!.content as Record<string, unknown>).legalInfo).toEqual({ privacyPolicyUrl: 'https://example.invalid/privacy', consents: [] });
  });
  it('creates a previously absent thank-you record with a complete set instead of patching a missing record', async () => {
    const f = fixture(); delete (f.state.forms[0]!.content as Record<string, unknown>).postSubmissionInfo;
    await f.provider.applyWrite(op('linkedin_update_lead_form', { ...await reference(f.provider), content: { postSubmissionInfo: content().postSubmissionInfo } }), guard);
    expect(data(mutations(f.calls)[0]!)).toEqual({ patch: { $set: { content: content() } } });
  });
  it('marks readback unconfirmed if an omitted question or native ID changes, without retry', async () => {
    const f = fixture(call => {
      if (call.url.pathname === `/rest/leadForms/${FORM}` && call.init.method === 'POST') {
        applyPatch(f.state.forms[0]!, data(call).patch);
        (f.state.forms[0]!.content as ReturnType<typeof content>).questions = [];
        return new Response(null, { status: 204 });
      }
    });
    await expect(f.provider.applyWrite(op('linkedin_update_lead_form', { ...await reference(f.provider), content: { headline: localized('New headline') } }), guard)).rejects.toMatchObject({ details: { resource_ids: [FORM] } });
    expect(mutations(f.calls)).toHaveLength(1);
  });
  it.each([{ name: 'New name' }, { creation_locale: { country: 'DE', language: 'de' } }, { hidden_fields: [] }, { content: { questions: content().questions } }, { content: { legalInfo: { consents: [] } } }])('rejects published schema edits without assuming pre-publication eligibility %#', async change => {
    const f = fixture(); f.state.forms[0]!.state = 'PUBLISHED';
    await expect(f.provider.previewWrite(op('linkedin_update_lead_form', { ...await reference(f.provider), ...change }), guard)).rejects.toThrow('require DRAFT'); expect(mutations(f.calls)).toEqual([]);
  });
  it('allows published copy edits while leaving native eligibility enforcement to the provider', async () => {
    const f = fixture(); f.state.forms[0]!.state = 'PUBLISHED';
    await f.provider.applyWrite(op('linkedin_update_lead_form', { ...await reference(f.provider), content: { headline: localized('New copy') } }), guard);
    expect(f.state.forms[0]).toMatchObject({ state: 'PUBLISHED', content: { headline: localized('New copy') } });
  });
  it('uses only the documented PUBLISHED-to-ARCHIVED transition, never delete or publish', async () => {
    const f = fixture(); await expect(f.provider.previewWrite(op('linkedin_archive_lead_form', await reference(f.provider)), guard)).rejects.toThrow('PUBLISHED');
    f.state.forms[0]!.state = 'PUBLISHED'; const operation = op('linkedin_archive_lead_form', await reference(f.provider));
    expect((await f.provider.previewWrite(operation, guard)).review?.notices.join(' ')).toContain('linked creatives');
    await f.provider.applyWrite(operation, guard); expect(data(mutations(f.calls)[0]!)).toEqual({ patch: { $set: { state: 'ARCHIVED' } } });
    expect(f.calls.some(call => call.init.method === 'DELETE')).toBe(false);
  });
  it('refuses stale accounts, missing preferred strings, no-op and conflicting clears before mutation', async () => {
    const f = fixture(), input = await creation(f.provider);
    for (const operation of [op('linkedin_create_lead_form_draft', { ...input, expected_account_hash: 'a'.repeat(64) }, 'create'), op('linkedin_create_lead_form_draft', { ...input, creation_locale: { country: 'DE', language: 'de' } }, 'create'), op('linkedin_update_lead_form', { ...await reference(f.provider), name: 'Synthetic QA form' }), op('linkedin_update_lead_form', { ...await reference(f.provider), content: { description: localized('New description') }, clear_fields: ['description'] })]) await expect(f.provider.previewWrite(operation, guard)).rejects.toThrow();
    expect(mutations(f.calls)).toEqual([]);
  });
  it('returns the created ID on unconfirmed readback and never retries a failed native write', async () => {
    const f = fixture(call => call.url.pathname === `/rest/leadForms/${NEW}` ? new Response('{}', { status: 403 }) : undefined);
    await expect(f.provider.applyWrite(op('linkedin_create_lead_form_draft', await creation(f.provider), 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: [NEW] } }); expect(mutations(f.calls)).toHaveLength(1);
    const denied = fixture(call => call.url.pathname === '/rest/leadForms' && call.init.method === 'POST' ? new Response('{}', { status: 503 }) : undefined);
    await expect(denied.provider.applyWrite(op('linkedin_create_lead_form_draft', await creation(denied.provider), 'create'), guard)).rejects.toThrow('503'); expect(mutations(denied.calls)).toHaveLength(1);
  });
  it('enforces the actual two-step registry gate, identical payload and single token consumption', async () => {
    const f = fixture(), dir = await mkdtemp(path.join(tmpdir(), 'adport-form-gate-')); dirs.push(dir);
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: linkedinTools(f.provider) }] });
    const args = { account_id: A, ...await reference(f.provider), name: 'Guarded rename' };
    const preview = await runtime.registry.call('linkedin_update_lead_form', args, runtime.ctx) as { pending_operation_id: string }; expect(mutations(f.calls)).toEqual([]);
    await expect(runtime.registry.call('linkedin_update_lead_form', { ...args, name: 'Different', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(await runtime.registry.call('linkedin_update_lead_form', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toMatchObject({ status: 'applied', applied: true });
    await expect(runtime.registry.call('linkedin_update_lead_form', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow(); expect(mutations(f.calls)).toHaveLength(1);
  });
});
