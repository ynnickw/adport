import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, GTM_SCOPES, PolicyEngine, policySchema } from '@adport/core';
import { GtmClient, GtmProvider, gtmTools } from '../src/index.js';

// Wire contracts verified 2026-11-06 against Google's official GTM API v2 REST
// reference and https://tagmanager.googleapis.com/$discovery/rest?version=v2.
let home: string;
let responses: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
let provider: GtmProvider;
const base = 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2';
const input = { account_id: '1', container_id: '2', workspace_id: '3' };
const tag = { name: 'Purchase', type: 'awct', firingTriggerId: ['4'], parameter: [{ type: 'template', key: 'conversionId', value: '123' }] };

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'adport-gtm-')); vi.stubEnv('ADPORT_HOME', home);
  responses = { [`${base}/workspaces/3`]: { name: 'Draft', fingerprint: 'workspace-fp' } };
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access-test', expires_in: 3600 });
    if (init.method !== 'GET') return Response.json({ path: 'accounts/1/containers/2/workspaces/3/tags/7', ...(responses[url] ?? {}) });
    if (!(url in responses)) throw new Error(`Unexpected GTM read ${url}`);
    return Response.json(responses[url]);
  });
  provider = new GtmProvider(new GtmClient({ clientId: 'client-test', clientSecret: 'secret-test', refreshToken: 'refresh-test' }, fetchMock as typeof fetch));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
async function runtime(overrides = {}) {
  return createContext({ providerModules: [{ provider, tools: gtmTools(provider) }], engine: new PolicyEngine(policySchema.parse(overrides)) });
}
const writes = () => fetchMock.mock.calls.filter(([url, init]) => url !== 'https://oauth2.googleapis.com/token' && init.method !== 'GET');

describe('GTM configuration integration', () => {
  it('retrieves the official installation snippet without a website mutation', async () => {
    responses[`${base}:snippet`] = { snippet: '<!-- Google Tag Manager -->' };
    const rt = await runtime();
    expect(await rt.registry.call('gtm_get_installation_snippet', input, rt.ctx)).toMatchObject({ snippet: '<!-- Google Tag Manager -->' });
    expect(writes()).toHaveLength(0);
  });
  it('refreshes with form encoding, caches tokens, and reads every account page', async () => {
    responses['https://tagmanager.googleapis.com/tagmanager/v2/accounts'] = { account: [{ accountId: '1', name: 'Shop' }], nextPageToken: 'next' };
    responses['https://tagmanager.googleapis.com/tagmanager/v2/accounts?pageToken=next'] = { account: [{ accountId: '5', name: 'Other' }] };
    expect(await provider.listAccounts()).toEqual([{ provider: 'gtm', id: '1', name: 'Shop' }, { provider: 'gtm', id: '5', name: 'Other' }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(new URLSearchParams(init.body as string).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(init.body as string).get('refresh_token')).toBe('refresh-test');
    expect(fetchMock.mock.calls.filter(([u]) => u === url)).toHaveLength(1);
    expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({ authorization: 'Bearer access-test' });
  });

  it.each([
    ['gtm_list_tags', '/workspaces/3/tags'], ['gtm_list_triggers', '/workspaces/3/triggers'],
    ['gtm_list_variables', '/workspaces/3/variables'], ['gtm_list_versions', '/version_headers'],
  ])('preserves pagination on %s', async (name, suffix) => {
    responses[`${base}${suffix}?pageToken=a%2Fb`] = { nextPageToken: 'continue', tag: [] };
    const rt = await runtime();
    expect(await rt.registry.call(name, { ...input, page_token: 'a/b' }, rt.ctx)).toMatchObject({ nextPageToken: 'continue' });
    expect(writes()).toHaveLength(0);
  });

  it('previews without upstream mutation, binds identical args, applies once and audits', async () => {
    const rt = await runtime();
    const preview = await rt.registry.call('gtm_create_tag', { ...input, tag }, rt.ctx) as { pending_operation_id: string; preview: { serverValidated: boolean } };
    expect(preview.preview.serverValidated).toBe(false); expect(writes()).toHaveLength(0);
    await expect(rt.registry.call('gtm_create_tag', { ...input, tag: { ...tag, name: 'Changed' }, pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const args = { ...input, tag, pending_operation_id: preview.pending_operation_id };
    expect(await rt.registry.call('gtm_create_tag', args, rt.ctx)).toMatchObject({ applied: true });
    const [url, init] = writes()[0]!;
    expect(url).toBe(`${base}/workspaces/3/tags`); expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(tag);
    await expect(rt.registry.call('gtm_create_tag', args, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
    expect(writes()).toHaveLength(1);
    expect((await new AuditLog().read()).map(e => e.event)).toEqual(['validated', 'applied']);
  });

  it('enforces protected accounts before any request', async () => {
    const rt = await runtime({ protected_accounts: ['1'] });
    await expect(rt.registry.call('gtm_create_tag', { ...input, tag }, rt.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates with native PUT/fingerprint and preserves omitted consent/sequencing fields', async () => {
    const url = `${base}/workspaces/3/tags/7`;
    responses[url] = { ...tag, fingerprint: 'fp1', consentSettings: { consentStatus: 'needed' }, setupTag: [{ tagName: 'Base' }] };
    const rt = await runtime();
    const args = { ...input, tag_id: '7', expected_fingerprint: 'fp1', tag: { name: 'New name', type: 'awct' } };
    const preview = await rt.registry.call('gtm_update_tag', args, rt.ctx) as { pending_operation_id: string };
    await rt.registry.call('gtm_update_tag', { ...args, pending_operation_id: preview.pending_operation_id }, rt.ctx);
    expect(writes()[0]![0]).toBe(`${url}?fingerprint=fp1`);
    expect(writes()[0]![1].method).toBe('PUT');
    expect(JSON.parse(String(writes()[0]![1].body))).toMatchObject({ name: 'New name', firingTriggerId: ['4'], consentSettings: { consentStatus: 'needed' }, setupTag: [{ tagName: 'Base' }] });
  });

  it('rejects an update if its resource changed after approval', async () => {
    const url = `${base}/workspaces/3/tags/7`; responses[url] = { ...tag, fingerprint: 'fp1' };
    const rt = await runtime(); const args = { ...input, tag_id: '7', expected_fingerprint: 'fp1', tag };
    const p = await rt.registry.call('gtm_update_tag', args, rt.ctx) as { pending_operation_id: string };
    responses[url] = { ...tag, fingerprint: 'fp2' };
    await expect(rt.registry.call('gtm_update_tag', { ...args, pending_operation_id: p.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(writes()).toHaveLength(0);
  });

  it('binds all workspace changes before version creation and never implicitly publishes', async () => {
    responses[`${base}/workspaces/3/status`] = { workspaceChange: [{ type: 'added', tag }], mergeConflict: [] };
    const rt = await runtime();
    const snapshot = await rt.registry.call('gtm_workspace_status', input, rt.ctx) as { workspace_hash: string };
    const args = { ...input, name: 'Purchases', expected_workspace_hash: snapshot.workspace_hash };
    const p = await rt.registry.call('gtm_create_version', args, rt.ctx) as { pending_operation_id: string };
    expect(writes()).toHaveLength(0);
    await rt.registry.call('gtm_create_version', { ...args, pending_operation_id: p.pending_operation_id }, rt.ctx);
    expect(writes()).toHaveLength(1); expect(writes()[0]![0]).toBe(`${base}/workspaces/3:create_version`);
    expect(JSON.parse(String(writes()[0]![1].body))).toEqual({ name: 'Purchases' });
  });

  it('rejects changed workspace contents even when its metadata fingerprint stays the same', async () => {
    responses[`${base}/workspaces/3/status`] = { workspaceChange: [] };
    const snapshot = await provider.workspaceStatus('1', '2', '3');
    const rt = await runtime(); const args = { ...input, name: 'Release', expected_workspace_hash: snapshot.workspace_hash };
    const p = await rt.registry.call('gtm_create_version', args, rt.ctx) as { pending_operation_id: string };
    responses[`${base}/workspaces/3/status`] = { workspaceChange: [{ type: 'updated', tag }] };
    await expect(rt.registry.call('gtm_create_version', { ...args, pending_operation_id: p.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(writes()).toHaveLength(0);
  });

  it('publishes only a separately approved fingerprint-bound version with an empty POST body', async () => {
    responses[`${base}/versions/8`] = { fingerprint: 'version-fp', containerVersionId: '8', tag: [tag] };
    responses[`${base}/versions:live`] = { containerVersionId: '6' };
    const rt = await runtime(); const args = { account_id: '1', container_id: '2', version_id: '8', expected_fingerprint: 'version-fp', expected_live_version_id: '6' };
    const p = await rt.registry.call('gtm_publish_version', args, rt.ctx) as { pending_operation_id: string; preview: { changes: string[] } };
    expect(p.preview.changes.join(' ')).toContain('Purchase'); expect(writes()).toHaveLength(0);
    await rt.registry.call('gtm_publish_version', { ...args, pending_operation_id: p.pending_operation_id }, rt.ctx);
    expect(writes()[0]![0]).toBe(`${base}/versions/8:publish?fingerprint=version-fp`);
    expect(writes()[0]![1].body).toBeUndefined();
  });

  it('rejects publishing over a changed live version', async () => {
    responses[`${base}/versions/8`] = { fingerprint: 'fp', containerVersionId: '8' };
    responses[`${base}/versions:live`] = { containerVersionId: '7' };
    const rt = await runtime();
    await expect(rt.registry.call('gtm_publish_version', { account_id: '1', container_id: '2', version_id: '8', expected_fingerprint: 'fp', expected_live_version_id: '6' }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(writes()).toHaveLength(0);
  });

  it('keeps GTM out of cross-platform reports and performance audits', async () => {
    const rt = await runtime();
    expect(await rt.registry.call('report', {}, rt.ctx)).toMatchObject({ rows: [], errors: [] });
    expect(await rt.registry.call('audit_preview', {}, rt.ctx)).toMatchObject({ findings: [], evaluatedAccounts: 0 });
    await expect(rt.registry.call('report', { provider: 'gtm' }, rt.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['https://evil.test', '../2', '1/containers/2', '1?x=y'])('rejects account path injection %s', async account_id => {
    const rt = await runtime();
    await expect(rt.registry.call('gtm_list_containers', { account_id }, rt.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests only the scopes used by configuration, version creation and publishing', () => {
    expect(GTM_SCOPES).toEqual(['edit.containers', 'edit.containerversions', 'publish'].map(s => `https://www.googleapis.com/auth/tagmanager.${s}`));
  });
});
