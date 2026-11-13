import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, type WriteOperation } from '@adport/core';
import { LinkedInAdsClient, LINKEDIN_API_VERSION } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';

// Wire shapes checked against LinkedIn's saved-audience templates (Marketing202608)
// and official Rest.li pagination documentation2026-11-04. Synthetic fixtures only.
const A = '551000001', T = '12345678', F = '551000002', urn = `urn:li:sponsoredAccount:${A}`, guard = { forcePausedCreation: true };
const targeting = { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:101282230'] } }, { or: { 'urn:li:adTargetingFacet:interfaceLocales': ['urn:li:locale:en_US'] } }] } };
const saved = { id: Number(T), account: urn, name: 'QA saved audience', description: 'Private QA template', targetingCriteria: targeting, approximateMemberCount: 1000, lastModified: { time: 1700000000000, actor: 'urn:li:unknown:0' } };
type Call = { url: URL; init: RequestInit };
const body = (call: Call) => JSON.parse(String(call.init.body));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture(handler?: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const client = new LinkedInAdsClient({ accessToken: 'qa-access' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.url.pathname === `/rest/adAccounts/${A}`) return Response.json({ id: Number(A), name: 'QA advertiser', currency: 'EUR', status: 'DRAFT' });
    if (call.url.pathname === '/rest/adTargetTemplates' && init.method === 'GET') return Response.json({ elements: [saved], paging: { start: Number(call.url.searchParams.get('start')), count: 50, total: 1, links: [] } });
    if (call.url.pathname === `/rest/adTargetTemplates/${T}` && init.method === 'GET') return Response.json(saved);
    throw new Error(`Unexpected ${init.method} ${call.url.pathname}`);
  });
  return { provider: new LinkedInAdsProvider(client), calls };
}
const mutations = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET');
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ provider: 'linkedin', accountId: A, tool, payload, kind });
async function reference(provider: LinkedInAdsProvider) { return { template_id: T, expected_snapshot_hash: (await provider.audiences.get(A, T)).template.snapshot_hash }; }

describe('LinkedIn saved-audience native reads', () => {
  it('registers the shared lazy CRUD surface once and correctly marks additive/deleting tools', () => {
    const tools = linkedinTools(new Proxy({} as LinkedInAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
    expect(tools.find(tool => tool.name === 'linkedin_saved_audiences')).toMatchObject({ annotations: { readOnly: true } });
    expect(tools.find(tool => tool.name === 'linkedin_create_saved_audience')).toMatchObject({ annotations: { readOnly: false, destructive: false } });
    expect(tools.find(tool => tool.name === 'linkedin_delete_saved_audience')).toMatchObject({ annotations: { readOnly: false, destructive: true } });
  });
  it('uses the account finder, version, native URN encoding and sort/paging parameters', async () => {
    const { provider, calls } = fixture();
    const result = await provider.audiences.list({ account_id: A, sort_field: 'NAME', sort_order: 'DESCENDING' });
    const request = calls.at(-1)!;
    expect(request.url.pathname).toBe('/rest/adTargetTemplates');
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ q: 'account', account: urn, sortField: 'NAME', sortOrder: 'DESCENDING', start: '0', count: '50' });
    expect(request.url.href).toContain('account=urn%3Ali%3AsponsoredAccount%3A');
    expect(request.init.headers).toMatchObject({ authorization: 'Bearer qa-access', 'Linkedin-Version': LINKEDIN_API_VERSION, 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'FINDER' });
    expect(result).toMatchObject({ account_id: A, complete: true, truncated: false, elements: [{ id: T, approximateMemberCount: 1000 }] });
    expect(result.account_snapshot_hash).toMatch(/^[a-f0-9]{64}$/); expect(result.elements[0]!.snapshot_hash).toMatch(/^[a-f0-9]{64}$/); expect(mutations(calls)).toEqual([]);
  });
  it('normalizes a numeric/native string ID and verifies the selected advertiser and resource', async () => {
    const { provider } = fixture(call => call.url.pathname.endsWith(`/${T}`) ? { ...saved, id: T } : undefined);
    expect((await provider.audiences.get(A, T)).template).toMatchObject({ id: T, account: urn });
    for (const changed of [{ ...saved, account: `urn:li:sponsoredAccount:${F}` }, { ...saved, id: Number(F) }]) {
      const foreign = fixture(call => call.url.pathname.endsWith(`/${T}`) ? changed : undefined);
      await expect(foreign.provider.audiences.get(A, T)).rejects.toThrow('advertiser/ID');
    }
  });
  it.each([
    { elements: [{ ...saved, account: `urn:li:sponsoredAccount:${F}` }] },
    { elements: [saved, saved] },
    { elements: [saved], paging: { start: 1, count: 50 } },
    { elements: [saved], paging: { start: 0, count: 51 } },
    { elements: [saved], paging: { start: 0, count: 0 } },
    { elements: [saved], paging: { start: 0, count: 50, total: 0 } },
    { elements: [], paging: { start: 0, count: 50, total: 2 } },
  ])('rejects foreign records and contradictory collection receipts %#', async response => {
    const { provider } = fixture(call => call.url.pathname === '/rest/adTargetTemplates' ? response : undefined);
    await expect(provider.audiences.list({ account_id: A })).rejects.toThrow();
  });
  it('returns native offsets without following returned URLs or claiming a tail is the whole collection', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/rest/adTargetTemplates' ? { elements: [saved], paging: { start: 50, count: 50, total: 100, links: [{ rel: 'next', href: 'https://untrusted.test/?token=never-follow' }] } } : undefined);
    const result = await provider.audiences.list({ account_id: A, start: 50 });
    expect(result).toMatchObject({ next_start: 100, truncated: true, complete: false });
    expect(calls.every(call => call.url.hostname === 'api.linkedin.com')).toBe(true);
  });
  it('preserves unknown completeness when native paging is absent and refuses an unverified offset', async () => {
    const { provider } = fixture(call => call.url.pathname === '/rest/adTargetTemplates' ? { elements: [saved] } : undefined);
    const result = await provider.audiences.list({ account_id: A });
    expect(result.complete).toBeNull(); expect(result.next_start).toBeUndefined(); expect(result.notes.join(' ')).toContain('completeness is unknown');
    await expect(provider.audiences.list({ account_id: A, start: 50 })).rejects.toThrow('pagination');
  });
  it('keeps snapshots stable across native set ordering and volatile reach, while binding editable fields and modification time', async () => {
    let reverse = false, changed = false, modified = false;
    const { provider } = fixture(call => call.url.pathname.endsWith(`/${T}`) ? { ...saved, approximateMemberCount: reverse ? 2000 : 1000, name: changed ? 'Other name' : saved.name, lastModified: { ...saved.lastModified, time: modified ? 1700000001000 : saved.lastModified.time }, targetingCriteria: reverse ? { include: { and: [...targeting.include.and].reverse() } } : targeting } : undefined);
    const before = await reference(provider); reverse = true;
    expect((await reference(provider)).expected_snapshot_hash).toBe(before.expected_snapshot_hash);
    changed = true; expect((await reference(provider)).expected_snapshot_hash).not.toBe(before.expected_snapshot_hash);
    changed = false; modified = true; expect((await reference(provider)).expected_snapshot_hash).not.toBe(before.expected_snapshot_hash);
  });
});

describe('LinkedIn saved-audience guarded writes', () => {
  it('POSTs create once with native fields, no snapshot or campaign status, and confirms the returned ID through readback', async () => {
    let created = false;
    const { provider, calls } = fixture(call => {
      if (call.init.method === 'POST') { created = true; return new Response(null, { status: 201, headers: { 'x-restli-id': T } }); }
      if (created && call.url.pathname.endsWith(`/${T}`)) return { ...saved, name: 'New saved audience', description: '' };
    });
    const input = { name: 'New saved audience', description: '', targeting_criteria: targeting, expected_account_hash: (await provider.audiences.list({ account_id: A })).account_snapshot_hash };
    const preview = await provider.previewWrite(op('linkedin_create_saved_audience', input), guard);
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [] }); expect(mutations(calls)).toEqual([]);
    expect(await provider.applyWrite(op('linkedin_create_saved_audience', input), guard)).toEqual({ applied: true, resourceIds: [T] });
    expect(mutations(calls)).toHaveLength(1); expect(mutations(calls)[0]!.url.pathname).toBe('/rest/adTargetTemplates');
    expect(body(mutations(calls)[0]!)).toEqual({ account: urn, name: 'New saved audience', description: '', targetingCriteria: targeting });
    expect(calls.at(-1)!.url.pathname).toBe(`/rest/adTargetTemplates/${T}`);
  });
  it('uses native max lengths and rejects immutable/read-only fields, empty clauses and a no-field update', () => {
    const tools = linkedinTools({} as LinkedInAdsProvider), create = tools.find(tool => tool.name === 'linkedin_create_saved_audience')!, update = tools.find(tool => tool.name === 'linkedin_update_saved_audience')!;
    const valid = { account_id: A, name: 'a'.repeat(100), description: 'b'.repeat(500), targeting_criteria: targeting, expected_account_hash: 'a'.repeat(64) };
    expect(create.input.safeParse(valid).success).toBe(true);
    for (const value of [{ ...valid, name: 'a'.repeat(101) }, { ...valid, description: 'b'.repeat(501) }, { ...valid, account: urn }, { ...valid, id: T }, { ...valid, approximateMemberCount: 12 }, { ...valid, targeting_criteria: { include: { and: [{ or: {} }] } } }]) expect(create.input.safeParse(value).success).toBe(false);
    expect(update.input.safeParse({ account_id: A, template_id: T, expected_snapshot_hash: 'a'.repeat(64) }).success).toBe(false);
  });
  it('binds creation to current advertiser settings before sending a POST', async () => {
    const { provider, calls } = fixture();
    await expect(provider.previewWrite(op('linkedin_create_saved_audience', { name: 'New', targeting_criteria: targeting, expected_account_hash: '0'.repeat(64) }), guard)).rejects.toThrow('advertiser settings changed'); expect(mutations(calls)).toEqual([]);
  });
  it('patches only supplied metadata, preserves omitted targeting, and verifies the change', async () => {
    let updated = false;
    const { provider, calls } = fixture(call => {
      if (call.init.method === 'POST') { updated = true; return new Response(null, { status: 204 }); }
      if (updated && call.url.pathname.endsWith(`/${T}`)) return { ...saved, description: '' };
    });
    const input = { ...await reference(provider), description: '' };
    const preview = await provider.previewWrite(op('linkedin_update_saved_audience', input, 'update'), guard);
    expect(preview.review?.fields).toEqual([{ label: 'Description', before: saved.description, after: '' }]); expect(mutations(calls)).toEqual([]);
    await provider.applyWrite(op('linkedin_update_saved_audience', input, 'update'), guard);
    expect(body(mutations(calls)[0]!)).toEqual({ patch: { $set: { description: '' } } });
    expect(mutations(calls)[0]!.init.headers).toMatchObject({ 'X-RestLi-Method': 'PARTIAL_UPDATE', 'Linkedin-Version': LINKEDIN_API_VERSION });
  });
  it('supports adding an initially omitted description and replacing the entire supplied targeting definition', async () => {
    let updated = false;
    const replacement = { include: { and: [targeting.include.and[0]!] } };
    const { provider, calls } = fixture(call => {
      if (call.init.method === 'POST') { updated = true; return new Response(null, { status: 204 }); }
      if (call.url.pathname.endsWith(`/${T}`)) { const { description: _description, ...value } = saved; return updated ? { ...value, description: 'New description', targetingCriteria: replacement } : value; }
    });
    const input = { ...await reference(provider), description: 'New description', targeting_criteria: replacement };
    const preview = await provider.previewWrite(op('linkedin_update_saved_audience', input, 'update'), guard);
    expect(preview.review?.fields[0]).toEqual({ label: 'Description', after: 'New description' });
    await provider.applyWrite(op('linkedin_update_saved_audience', input, 'update'), guard);
    expect(body(mutations(calls)[0]!)).toEqual({ patch: { $set: { description: 'New description', targetingCriteria: replacement } } });
  });
  it('blocks stale snapshots, no-op updates, foreign records and wrong operation kinds without a write', async () => {
    const { provider, calls } = fixture();
    await expect(provider.previewWrite(op('linkedin_update_saved_audience', { template_id: T, expected_snapshot_hash: '0'.repeat(64), name: 'Changed' }, 'update'), guard)).rejects.toThrow('saved audience changed');
    await expect(provider.previewWrite(op('linkedin_update_saved_audience', { ...await reference(provider), name: saved.name }, 'update'), guard)).rejects.toThrow('already match');
    await expect(provider.previewWrite(op('linkedin_delete_saved_audience', await reference(provider), 'update'), guard)).rejects.toThrow('kind'); expect(mutations(calls)).toEqual([]);
  });
  it('deletes only the snapshot-bound template and accepts only native204', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined), input = await reference(provider);
    expect((await provider.previewWrite(op('linkedin_delete_saved_audience', input, 'remove'), guard)).summary).toContain('Permanently delete'); expect(mutations(calls)).toEqual([]);
    expect(await provider.applyWrite(op('linkedin_delete_saved_audience', input, 'remove'), guard)).toMatchObject({ resourceIds: [T], details: { deletion: 'DELETED' } });
    expect(mutations(calls)[0]!.url.pathname).toBe(`/rest/adTargetTemplates/${T}`); expect(mutations(calls)[0]!.init.body).toBeUndefined();
  });
  it.each([200, 202])('does not label a delete HTTP%s response as completed', async status => {
    const { provider, calls } = fixture(call => call.init.method === 'DELETE' ? new Response(null, { status }) : undefined);
    await expect(provider.applyWrite(op('linkedin_delete_saved_audience', await reference(provider), 'remove'), guard)).rejects.toThrow('204'); expect(mutations(calls)).toHaveLength(1);
  });
  it('retains the known resource ID when create/update readback does not confirm settings', async () => {
    const create = fixture(call => call.init.method === 'POST' ? new Response(null, { status: 201, headers: { 'x-restli-id': T } }) : undefined);
    await expect(create.provider.applyWrite(op('linkedin_create_saved_audience', { name: 'Changed', targeting_criteria: targeting, expected_account_hash: (await create.provider.audiences.list({ account_id: A })).account_snapshot_hash }), guard)).rejects.toMatchObject({ details: { resource_ids: [T] } }); expect(mutations(create.calls)).toHaveLength(1);
    const update = fixture(call => call.init.method === 'POST' ? new Response(null, { status: 204 }) : undefined);
    await expect(update.provider.applyWrite(op('linkedin_update_saved_audience', { ...await reference(update.provider), name: 'Changed' }, 'update'), guard)).rejects.toMatchObject({ details: { resource_ids: [T] } }); expect(mutations(update.calls)).toHaveLength(1);
  });
  it.each([401, 403, 422, 429, 500])('never replays failed native POST HTTP%s', async status => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? Response.json({ code: 'REJECTED', message: 'private token or user input' }, { status }) : undefined);
    const input = { name: 'New', targeting_criteria: targeting, expected_account_hash: (await provider.audiences.list({ account_id: A })).account_snapshot_hash };
    const error = await provider.applyWrite(op('linkedin_create_saved_audience', input), guard).catch(error => error);
    expect(error).toMatchObject({ details: { http_status: status } }); expect(JSON.stringify(error)).not.toContain('private token'); expect(mutations(calls)).toHaveLength(1);
  });
  it('uses real protected-account and one-use approval checks in the shared registry', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined), input = { account_id: A, ...await reference(provider) };
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-linkedin-audiences-')); dirs.push(dir);
    const runtime = await createContext({ providerModules: [{ provider, tools: linkedinTools(provider) }], engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))) });
    const preview = await runtime.registry.call('linkedin_delete_saved_audience', input, runtime.ctx) as { pending_operation_id: string }; expect(mutations(calls)).toEqual([]);
    await runtime.registry.call('linkedin_delete_saved_audience', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    await expect(runtime.registry.call('linkedin_delete_saved_audience', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow(); expect(mutations(calls)).toHaveLength(1);
    const protectedRuntime = await createContext({ providerModules: [{ provider, tools: linkedinTools(provider) }], engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(dir, 'blocked')), new AuditLog(path.join(dir, 'blocked-audit'))) });
    await expect(protectedRuntime.registry.call('linkedin_delete_saved_audience', input, protectedRuntime.ctx)).rejects.toThrow('protected'); expect(mutations(calls)).toHaveLength(1);
  });
});
