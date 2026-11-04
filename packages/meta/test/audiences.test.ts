import { createContext, PolicyEngine, DEFAULT_POLICY, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it, vi } from 'vitest';
import { MetaGraphClient } from '../src/client.js';
import { MetaAdsProvider } from '../src/provider.js';
import { metaTools } from '../src/tools.js';

// Official wire contracts checked at facebook/facebook-python-business-sdk@efd8423a2e59:
// customaudience.py api_get/api_update/api_delete/get_ad_accounts, adaccount.py audience/adset/saved-audience edges;
// examples/AdAccountCustomAudiencesPost{CreateCustomAudience,PlatformWebsiteCustomAudience,ValueBasedLookalikeCustomAudience}.py.
const account = '1234', audienceId = '701', guard = { forcePausedCreation: true };
const audience = { id: audienceId, account_id: account, name: 'Customers', description: 'Original', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', permission_for_actions: { can_edit: true, subtype_supports_lookalike: true }, lookalike_audience_ids: [] };
const body = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));
const operation = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'meta', accountId: account, kind, payload });
function setup(respond?: (url: URL, init: RequestInit) => unknown) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    const result = respond?.(url, init);
    return result instanceof Response ? result : Response.json(result ?? (url.pathname === `/v25.0/${audienceId}` ? audience : { data: [] }));
  });
  return { provider: new MetaAdsProvider(new MetaGraphClient({ accessToken: 'test' }, 'v25.0', fetcher as typeof fetch)), calls };
}

describe('Meta audience workflows', () => {
  it('preserves existing create/list tool names exactly once and validates shared output schemas', async () => {
    const { provider } = setup(() => ({ data: [audience] })), definitions = metaTools(provider);
    expect(new Set(definitions.map(tool => tool.name)).size).toBe(definitions.length);
    expect(definitions.find(tool => tool.name === 'meta_create_custom_audience')!.annotations).toMatchObject({ readOnly: false, destructive: false });
    const tool = definitions.find(tool => tool.name === 'meta_list_custom_audiences')!;
    expect(tool.input.parse({ account_id: account })).toEqual({ account_id: account, limit: 50 });
    expect(tool.output!.parse(await provider.audiences.list({ account_id: account, limit: 50 }))).toMatchObject({ rows: [audience], truncated: false });
  });
  it('returns only native cursors, follows the fixed account edge and never repeats tokens or filters from next URLs', async () => {
    const { provider, calls } = setup(url => ({ data: [audience], ...(url.searchParams.has('after') ? {} : { paging: { next: 'https://graph.facebook.com/v25.0/act_1234/customaudiences?after=cursor-one&access_token=never-replay&fields=other', cursors: { after: 'cursor-one' } } }) }));
    const first = await provider.audiences.list({ account_id: account, limit: 1 });
    expect(first).toMatchObject({ truncated: true, next_cursor: 'cursor-one' });
    await provider.audiences.list({ account_id: account, limit: 1, cursor: first.next_cursor });
    expect(calls[1]!.url.pathname).toBe('/v25.0/act_1234/customaudiences');
    expect(calls[1]!.url.searchParams.get('after')).toBe('cursor-one');
    expect(calls[1]!.url.searchParams.has('access_token')).toBe(false);
    expect(calls[1]!.url.searchParams.get('fields')).toContain('permission_for_actions');
  });
  it.each([
    'https://untrusted.example/v25.0/act_1234/customaudiences?after=a',
    'https://graph.facebook.com/v25.0/act_999/customaudiences?after=a',
    'https://graph.facebook.com/v24.0/act_1234/customaudiences?after=a',
    'https://graph.facebook.com/v25.0/act_1234/customaudiences?after=wrong',
  ])('rejects an unsafe or conflicting native continuation %s before any second request', async next => {
    const { provider, calls } = setup(() => ({ data: [audience], paging: { next, cursors: { after: 'a' } } }));
    await expect(provider.audiences.list({ account_id: account, limit: 1 })).rejects.toThrow('pagination');
    expect(calls).toHaveLength(1);
  });
  it('rejects foreign audience IDs and excludes volatile readiness/counts from snapshots', async () => {
    let value: Record<string, unknown> = { ...audience, delivery_status: { code: 200 }, approximate_count_lower_bound: 100 };
    const { provider } = setup(() => value), first = await provider.audiences.get(account, audienceId);
    value = { ...value, delivery_status: { code: 400 }, approximate_count_lower_bound: 1000 };
    expect((await provider.audiences.get(account, audienceId)).snapshot_hash).toBe(first.snapshot_hash);
    value = { ...value, name: 'Renamed elsewhere' };
    expect((await provider.audiences.get(account, audienceId)).snapshot_hash).not.toBe(first.snapshot_hash);
    value = { ...value, account_id: '999' };
    await expect(provider.audiences.get(account, audienceId)).rejects.toThrow('selected ad account');
  });
  it('previews an empty customer audience locally and sends the documented form fields only at apply', async () => {
    const { provider, calls } = setup(() => ({ id: '702' })), op = operation('meta_create_custom_audience', { name: 'Empty QA', description: 'No records', customer_file_source: 'USER_PROVIDED_ONLY' }, 'create');
    expect(await provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false, budgetDeltas: [] });
    expect(calls).toHaveLength(0);
    expect(await provider.applyWrite(op, guard)).toMatchObject({ resourceIds: ['702'] });
    expect(calls[0]!.url.pathname).toBe('/v25.0/act_1234/customaudiences');
    expect(body(calls[0]!.init)).toEqual({ name: 'Empty QA', description: 'No records', customer_file_source: 'USER_PROVIDED_ONLY', subtype: 'CUSTOM' });
  });
  it('preserves the native customer-audience terms denial without retrying or pretending to create a resource', async () => {
    // Real connected-account response observed 2026-11-04; no customer records were sent.
    const { provider, calls } = setup(() => Response.json({ error: { message: 'Permissions error', type: 'OAuthException', code: 200, error_subcode: 1870090, is_transient: false, error_user_title: 'Custom audience terms not accepted', error_user_msg: 'Custom audience terms not accepted.', fbtrace_id: 'test-trace' } }, { status: 400 }));
    const op = operation('meta_create_custom_audience', { name: 'Empty QA', customer_file_source: 'USER_PROVIDED_ONLY' }, 'create');
    await expect(provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('terms not accepted'), details: { error: { code: 200, error_subcode: 1870090, is_transient: false } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/v25.0/act_1234/customaudiences');
  });
  it('edits supplied metadata only, supports an explicit description clear and rechecks snapshots at apply', async () => {
    let current = { ...audience };
    const { provider, calls } = setup((_url, init) => init.method === 'GET' ? current : { success: true });
    const state = await provider.audiences.get(account, audienceId), op = operation('meta_update_custom_audience', { audience_id: audienceId, expected_snapshot_hash: state.snapshot_hash, description: '' });
    expect(await provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false, fieldChanges: [{ field: 'description', before: 'Original', after: '' }] });
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
    await provider.applyWrite(op, guard);
    expect(body(calls.at(-1)!.init)).toEqual({ description: '' });
    current = { ...current, name: 'Changed since approval' };
    await expect(provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
  });
  it('rejects missing edit permission and unsafe source/ratio requests before mutation', async () => {
    const { provider, calls } = setup(() => ({ ...audience, permission_for_actions: { can_edit: false, subtype_supports_lookalike: false } }));
    const state = await provider.audiences.get(account, audienceId);
    await expect(provider.previewWrite(operation('meta_update_custom_audience', { audience_id: audienceId, expected_snapshot_hash: state.snapshot_hash, name: 'Denied' }), guard)).rejects.toThrow('edit permission');
    await expect(provider.previewWrite(operation('meta_create_lookalike_audience', { name: 'No', origin_audience_id: audienceId, expected_source_hash: state.snapshot_hash, country: 'US', ratio: 0.01 }, 'create'), guard)).rejects.toThrow('source');
    const tool = metaTools(provider).find(tool => tool.name === 'meta_create_lookalike_audience')!;
    expect(tool.input.safeParse({ account_id: account, name: 'No', origin_audience_id: audienceId, expected_source_hash: state.snapshot_hash, country: 'US', ratio: 0.01, starting_ratio: 0.02 }).success).toBe(false);
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('discovers targeting exclusions, saved audiences, derived sources and shared accounts on fixed owned edges', async () => {
    const { provider, calls } = setup(url => {
      if (url.pathname.endsWith('/adsets')) return { data: [{ id: '801', account_id: account, name: 'Paused exclusion', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED', targeting: { flexible_spec: [{ excluded_custom_audiences: [{ id: audienceId }] }] } }] };
      if (url.pathname.endsWith('/savedaudiences')) return { data: [{ id: '802', account: { id: 'act_1234' }, name: 'Saved', targeting: { custom_audiences: [{ id: audienceId }] } }] };
      if (url.pathname.endsWith('/customaudiences')) return { data: [{ id: '803', account_id: account, subtype: 'LOOKALIKE', lookalike_spec: { origin: [{ id: audienceId }] } }] };
      if (url.pathname.endsWith('/adaccounts')) return { data: [{ id: 'act_1234', account_id: account }, { id: 'act_5555', account_id: '5555' }] };
    });
    const result = await provider.audiences.usage(account, audienceId);
    expect(result).toMatchObject({ scan_complete: true, shared_accounts: ['5555'], references: [{ kind: 'ad_set', id: '801' }, { kind: 'audience', id: '803' }, { kind: 'saved_audience', id: '802' }] });
    expect(metaTools(provider).find(tool => tool.name === 'meta_custom_audience_usage')!.output!.safeParse(result).success).toBe(true);
    expect(JSON.parse(calls.find(call => call.url.pathname.endsWith('/adsets'))!.url.searchParams.get('effective_status')!)).toEqual(expect.arrayContaining(['PAUSED', 'ARCHIVED', 'DELETED', 'CAMPAIGN_PAUSED']));
    await expect(provider.previewWrite(operation('meta_delete_custom_audience', { audience_id: audienceId, expected_context_hash: result.context_hash }, 'remove'), guard)).rejects.toThrow('references, sharing');
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('rechecks absence of references at apply and deletes only the owned audience with a native success acknowledgement', async () => {
    let used = false;
    const { provider, calls } = setup((url, init) => {
      if (init.method === 'DELETE') return { success: true };
      if (used && url.pathname.endsWith('/adsets')) return { data: [{ id: '801', account_id: account, targeting: { custom_audiences: [{ id: audienceId }] } }] };
    });
    const state = await provider.audiences.usage(account, audienceId), op = operation('meta_delete_custom_audience', { audience_id: audienceId, expected_context_hash: state.context_hash }, 'remove');
    expect(await provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false });
    used = true;
    await expect(provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(calls.some(call => call.init.method === 'DELETE')).toBe(false);
    used = false;
    await expect(provider.applyWrite(op, guard)).resolves.toMatchObject({ resourceIds: [audienceId] });
    expect(calls.at(-1)!.url.pathname).toBe(`/v25.0/${audienceId}`);
    expect(calls.at(-1)!.init.method).toBe('DELETE');
    expect(calls.at(-1)!.init.body).toBeUndefined();
  });
  it('blocks deletion on incomplete, looping, malformed or privacy-limited inventory evidence', async () => {
    const { provider } = setup(url => url.pathname.endsWith('/adsets') ? { data: [], paging: { next: 'https://graph.facebook.com/v25.0/act_1234/adsets?after=repeat' } } : undefined);
    await expect(provider.audiences.usage(account, audienceId)).rejects.toThrow('repeated an inventory cursor');
    const incomplete = setup(url => url.pathname.endsWith('/adsets') ? { data: [], paging: { next: `https://graph.facebook.com/v25.0/act_1234/adsets?after=${Number(url.searchParams.get('after') ?? 0) + 1}` } } : undefined).provider;
    const context = await incomplete.audiences.usage(account, audienceId);
    expect(context.scan_complete).toBe(false);
    await expect(incomplete.previewWrite(operation('meta_delete_custom_audience', { audience_id: audienceId, expected_context_hash: context.context_hash }, 'remove'), guard)).rejects.toThrow('incomplete usage');
    const denied = setup(url => url.pathname.endsWith('/adaccounts') ? Response.json({ error: { code: 200, message: 'Permission denied' } }, { status: 403 }) : undefined);
    await expect(denied.provider.audiences.usage(account, audienceId)).rejects.toThrow('Permission denied');
    expect(denied.calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it.each([
    { lookalike_audience_ids: ['999'] },
    { sharing_status: { sharing_relationship_id: '42', status: 'SHARED' } },
    { permission_for_actions: { can_edit: false } },
  ])('refuses a shared/derived/uneditable audience even when visible account references are empty: %j', async extra => {
    const { provider, calls } = setup(url => url.pathname === `/v25.0/${audienceId}` ? { ...audience, ...extra } : undefined);
    const context = await provider.audiences.usage(account, audienceId);
    await expect(provider.previewWrite(operation('meta_delete_custom_audience', { audience_id: audienceId, expected_context_hash: context.context_hash }, 'remove'), guard)).rejects.toBeInstanceOf(Error);
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('preserves uncertainty after a malformed native mutation acknowledgement and never retries automatically', async () => {
    const { provider, calls } = setup((_url, init) => init.method === 'POST' || init.method === 'DELETE' ? {} : undefined);
    await expect(provider.applyWrite(operation('meta_create_custom_audience', { name: 'Unknown', customer_file_source: 'USER_PROVIDED_ONLY' }, 'create'), guard)).rejects.toThrow('inventory before retrying');
    const context = await provider.audiences.usage(account, audienceId);
    await expect(provider.applyWrite(operation('meta_delete_custom_audience', { audience_id: audienceId, expected_context_hash: context.context_hash }, 'remove'), guard)).rejects.toThrow('did not confirm audience deletion');
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
    expect(calls.filter(call => call.init.method === 'DELETE')).toHaveLength(1);
  });
  it('uses the official website URL rule and explicit prefill, validating pixel membership without sending events', async () => {
    const { provider, calls } = setup((url, init) => url.pathname.endsWith('/adspixels') ? { data: [{ id: '901' }] } : init.method === 'POST' ? { id: '702' } : undefined);
    const op = operation('meta_create_website_audience', { name: 'Website QA', pixel_id: '901', url_contains: '/shoes', retention_seconds: 8400, prefill: false }, 'create');
    expect(await provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false });
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
    await provider.applyWrite(op, guard);
    const sent = body(calls.at(-1)!.init);
    expect(sent.prefill).toBe('false');
    expect(JSON.parse(sent.rule!)).toEqual({ inclusions: { operator: 'or', rules: [{ event_sources: [{ id: '901', type: 'pixel' }], retention_seconds: 8400, filter: { operator: 'and', filters: [{ field: 'url', operator: 'i_contains', value: '/shoes' }] } }] } });
    expect(Object.keys(sent).sort()).toEqual(['name', 'prefill', 'rule']);
    expect(calls.some(call => call.url.pathname.includes('/events'))).toBe(false);
    await expect(provider.previewWrite(operation(op.tool, { ...op.payload as object, pixel_id: '902' }, 'create'), guard)).rejects.toThrow('not verified');
  });
  it('binds full website rule replacement to metadata and usage and includes affected delivery in its review', async () => {
    const websiteAudience = { ...audience, subtype: 'WEBSITE', rule: '{"old":"entire rule"}' };
    let use = false;
    const { provider, calls } = setup((url, init) => {
      if (url.pathname === `/v25.0/${audienceId}` && init.method === 'GET') return websiteAudience;
      if (url.pathname.endsWith('/adspixels')) return { data: [{ id: '901' }] };
      if (url.pathname.endsWith('/adsets')) return { data: use ? [{ id: '801', account_id: account, status: 'ACTIVE', targeting: { custom_audiences: [{ id: audienceId }] } }] : [] };
      if (init.method === 'POST') return { success: true };
    });
    const current = await provider.audiences.usage(account, audienceId), op = operation('meta_update_website_audience', { audience_id: audienceId, expected_snapshot_hash: current.snapshot_hash, expected_context_hash: current.context_hash, pixel_id: '901', url_contains: '/new', retention_seconds: 86400 });
    expect(await provider.previewWrite(op, guard)).toMatchObject({ fieldChanges: [{ field: 'rule', before: websiteAudience.rule }], notes: expect.arrayContaining([expect.stringContaining('entire website membership rule')]) });
    use = true;
    await expect(provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(calls.some(call => call.init.method === 'POST')).toBe(false);
    use = false;
    await provider.applyWrite(op, guard);
    expect(Object.keys(body(calls.at(-1)!.init))).toEqual(['rule']);
  });
  it('sends the official custom-ratio lookalike shape with exact source ID and no unverified eligibility claim', async () => {
    const { provider, calls } = setup((_url, init) => init.method === 'POST' ? { id: '703' } : undefined);
    const source = await provider.audiences.get(account, audienceId), op = operation('meta_create_lookalike_audience', { name: 'Lookalike QA', origin_audience_id: audienceId, expected_source_hash: source.snapshot_hash, country: 'US', ratio: 0.03, starting_ratio: 0.01 }, 'create');
    expect(await provider.previewWrite(op, guard)).toMatchObject({ serverValidated: false, notes: expect.arrayContaining([expect.stringContaining('eligibility')]) });
    await provider.applyWrite(op, guard);
    expect(body(calls.at(-1)!.init)).toEqual({ name: 'Lookalike QA', subtype: 'LOOKALIKE', origin_audience_id: audienceId, lookalike_spec: '{"type":"custom_ratio","country":"US","ratio":0.03,"starting_ratio":0.01}' });
  });
  it('uses the real shared policy gate for preview, argument mismatch rejection and apply', async () => {
    const { provider, calls } = setup(() => ({ id: '702' })), pending = new Map<string, PendingOperation>();
    const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(id) { return pending.get(id); }, async delete(id) { pending.delete(id); }, async consume(id: string, expectedHash: string) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } }, { async append() {} });
    const runtime = await createContext({ engine, providerModules: [{ provider, tools: metaTools(provider) }] });
    const input = { account_id: account, name: 'Empty QA', customer_file_source: 'USER_PROVIDED_ONLY' };
    const preview = await runtime.registry.call('meta_create_custom_audience', input, runtime.ctx) as { pending_operation_id: string; applied: boolean };
    expect(preview.applied).toBe(false); expect(calls).toHaveLength(0);
    await expect(runtime.registry.call('meta_create_custom_audience', { ...input, name: 'Different', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await expect(runtime.registry.call('meta_create_custom_audience', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).resolves.toMatchObject({ applied: true, result: { resourceIds: ['702'] } });
  });
});
