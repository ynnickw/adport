import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, resourceSecretKey, type ResourceSecretScope, type ResourceSecretStore, type WriteOperation } from '@adport/core';
import { SpotifyAdsClient } from '../src/client.js';
import { SpotifyAdsProvider } from '../src/provider.js';
import { spotifyTools } from '../src/tools.js';

// Official v3 API yaml SHA256 1ea6ac0383f0662debfc8dd544b78b1e23ff4b1a79ead9a84e339f049c5c76ff,
// refreshed 2026-11-05: POST has no body, GET returns active token values, DELETE is 204.
const A = '10000000-0000-4000-8000-000000000001', B = '10000000-0000-4000-8000-000000000002';
const D = '10000000-0000-4000-8000-000000000003', C = '10000000-0000-4000-8000-000000000004';
const T = '10000000-0000-4000-8000-000000000005', O = '10000000-0000-4000-8000-000000000006';
const secret = 'CAPI_SECRET_MUST_NEVER_LEAVE_SERVICE';
const guard = { forcePausedCreation: true };
const native = (id = T) => ({ capi_auth_token_id: id, capi_auth_token: secret + id, created_at: '2026-11-05T00:00:00Z' });
const key = (id = T): ResourceSecretScope => ({ provider: 'spotify', accountId: A, businessId: B, resourceId: C, credentialId: id });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

function fixture() {
  const stored = new Map<string, string>();
  const vault: ResourceSecretStore = {
    has: vi.fn(async scope => stored.has(resourceSecretKey(scope))), get: vi.fn(async scope => stored.get(resourceSecretKey(scope))),
    putIfAbsent: vi.fn(async (scope, value) => { const k = resourceSecretKey(scope);if (stored.has(k)) return false;stored.set(k, value);return true; }),
    delete: vi.fn(async scope => stored.delete(resourceSecretKey(scope))),
  };
  let tokens: ReturnType<typeof native>[] = [], shares = [A], capiDataset: string | null = D;
  let createStatus = 201, readStatusAfterCreate = 200, readStatusAfterDelete = 200, tokenReadsFail = false;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), route = url.pathname.replace('/ads/v3/', '');
    if (url.hostname === 'accounts.spotify.com') return Response.json({ access_token: 'ads-oauth-token', expires_in: 3600 });
    if (route === `ad_accounts/${A}`) return Response.json({ id: A, business_id: B });
    if (route === `businesses/${B}/datasets/${D}`) return Response.json({ id: D, capi_integration: { capi_connection_id: C, dataset_id: D }, shared_ad_accounts: shares.map(id => ({ id })) });
    if (route === `businesses/${B}/capi/${C}`) return Response.json({ capi_connection_id: C, dataset_id: capiDataset });
    if (route === `businesses/${B}/capi/${C}/tokens` && init?.method === 'POST') {
      if (createStatus !== 201) return Response.json({ messages: [secret] }, { status: createStatus });
      tokens.push(native());tokenReadsFail = readStatusAfterCreate !== 200;return Response.json({ data: native() }, { status: 201 });
    }
    if (route === `businesses/${B}/capi/${C}/tokens` && init?.method === 'GET') return tokenReadsFail ? Response.json({ messages: [secret] }, { status: readStatusAfterCreate }) : Response.json({ data: tokens });
    if (route === `businesses/${B}/capi/${C}/tokens/${T}` && init?.method === 'DELETE') { tokens = tokens.filter(t => t.capi_auth_token_id !== T);readStatusAfterCreate = readStatusAfterDelete;tokenReadsFail = readStatusAfterDelete !== 200;return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected native route ${init?.method} ${route}`);
  });
  const client = new SpotifyAdsClient({ clientId: 'client', clientSecret: 'oauth-secret', refreshToken: 'refresh' }, fetch);
  const provider = new SpotifyAdsProvider(client, undefined, { resourceSecrets: vault });
  return { provider, client, fetch, stored, vault, tokens: (value: ReturnType<typeof native>[]) => { tokens = value; }, shares: (value: string[]) => { shares = value; }, capiDataset: (value: string | null) => { capiDataset = value; }, createStatus: (value: number) => { createStatus = value; }, readStatus: (value: number) => { readStatusAfterCreate = value; }, deleteReadStatus: (value: number) => { readStatusAfterDelete = value; }, recoverReads: () => { tokenReadsFail = false; } };
}
async function input(f: ReturnType<typeof fixture>) {
  const current = await f.provider.measurement.credentials.list({ account_id: A, dataset_id: D });
  return { dataset_id: D, expected_configuration_hash: current.configuration_hash, expected_dataset_configuration_hash: current.dataset_configuration_hash, expected_token_inventory_hash: current.credential_inventory_hash, acknowledge_credential_access: true };
}
function operation(payload: Record<string, unknown>, tool = 'spotify_create_capi_credential'): WriteOperation { return { provider: 'spotify', accountId: A, tool, kind: tool.includes('revoke') ? 'remove' : 'create', payload }; }
const mutations = (f: ReturnType<typeof fixture>) => f.fetch.mock.calls.filter(([url, init]) => String(url).includes('/tokens') && init?.method !== 'GET');

describe('private Spotify CAPI credential lifecycle', () => {
  it('lists only safe metadata after owned parent and integration checks', async () => {
    const f = fixture();f.tokens([native()]);
    const result = await f.provider.measurement.credentials.list({ account_id: A, dataset_id: D });
    expect(result.credentials).toEqual([{ capi_auth_token_id: T, created_at: '2026-11-05T00:00:00Z', stored_in_adport: false }]);
    expect(JSON.stringify(result)).not.toContain(secret);expect(result.credential_inventory_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname).slice(1)).toEqual([`/ads/v3/ad_accounts/${A}`, `/ads/v3/businesses/${B}/datasets/${D}`, `/ads/v3/businesses/${B}/capi/${C}`, `/ads/v3/businesses/${B}/capi/${C}/tokens`]);
  });
  it('rejects a malformed metadata field without echoing a secret-bearing response', async () => {
    const f = fixture();f.tokens([{ ...native(), created_at: secret }]);
    const error = await f.provider.measurement.credentials.list({ account_id: A, dataset_id: D }).catch(error => error);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR' });expect(String(error.stack)).not.toContain(secret);expect(JSON.stringify(error)).not.toContain(secret);
  });
  it('uses the policy gate, sends exactly one bodyless create and never persists a secret in approvals or audit', async () => {
    const f = fixture(), values = await input(f), dir = await mkdtemp(path.join(tmpdir(), 'adport-capi-policy-'));directories.push(dir);
    const pending = new PendingStore(path.join(dir, 'pending')), audit = new AuditLog(path.join(dir, 'audit'));
    const runtime = await createContext({ providerModules: [{ provider: f.provider, tools: spotifyTools(f.provider) }], engine: new PolicyEngine(DEFAULT_POLICY, pending, audit) });
    const request = { ...values, account_id: A };
    const preview = await runtime.registry.call('spotify_create_capi_credential', request, runtime.ctx) as any;
    expect(preview).toMatchObject({ applied: false, preview: { serverValidated: false, budgetDeltas: [] } });expect(mutations(f)).toHaveLength(0);
    const result = await runtime.registry.call('spotify_create_capi_credential', { ...request, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    expect(result).toMatchObject({ applied: true, result: { details: { capi_auth_token_id: T, stored_in_adport: true } } });
    expect(mutations(f)).toHaveLength(1);expect(mutations(f)[0]![1]?.body).toBeUndefined();
    expect(f.stored.get(resourceSecretKey(key()))).toBe(secret + T);
    expect(JSON.stringify([preview, result, await audit.read()])).not.toContain(secret);
    for (const file of await readdir(path.join(dir, 'pending'))) expect(await readFile(path.join(dir, 'pending', file), 'utf8')).not.toContain(secret);
    await expect(runtime.registry.call('spotify_create_capi_credential', { ...request, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(mutations(f)).toHaveLength(1);
  });
  it('rejects changed inventory at apply before issuing a credential', async () => {
    const f = fixture(), values = await input(f);await f.provider.previewWrite(operation(values), guard);f.tokens([native(O)]);
    await expect(f.provider.applyWrite(operation(values), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(mutations(f)).toHaveLength(0);
  });
  it.each(['shared', 'binding'] as const)('refuses %s scope drift before reading secret values', async type => {
    const f = fixture();if (type === 'shared') f.shares([A, O]);else f.capiDataset(O);
    await expect(f.provider.measurement.credentials.list({ account_id: A, dataset_id: D })).rejects.toThrow();
    expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith('/tokens'))).toBe(false);
  });
  it('accepts an omitted child pointer only with the independently verified exact parent', async () => {
    const f = fixture();f.capiDataset(null);expect((await f.provider.measurement.credentials.list({ account_id: A, dataset_id: D })).capi_connection_id).toBe(C);
  });
  it('stores an explicitly selected existing token without native creation', async () => {
    const f = fixture();f.tokens([native(), native(O)]);const values = { ...await input(f), capi_auth_token_id: T };
    const result = await f.provider.applyWrite(operation(values, 'spotify_store_capi_credential'), guard);
    expect(result.details).toMatchObject({ stored_in_adport: true, native_credential_created: false });expect(mutations(f)).toHaveLength(0);expect(f.stored.size).toBe(1);expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('confirms native revocation before removing only its private copy', async () => {
    const f = fixture();f.tokens([native(), native(O)]);f.stored.set(resourceSecretKey(key()), secret + T);f.stored.set(resourceSecretKey(key(O)), secret + O);
    const values = { ...await input(f), capi_auth_token_id: T, acknowledge_ingestion_effects: true };delete (values as any).acknowledge_credential_access;
    const result = await f.provider.applyWrite(operation(values, 'spotify_revoke_capi_credential'), guard);
    expect(result.details).toMatchObject({ native_active: false, stored_in_adport: false });expect(mutations(f)).toHaveLength(1);expect(mutations(f)[0]![1]?.method).toBe('DELETE');expect(f.stored.size).toBe(1);expect(f.stored.has(resourceSecretKey(key(O)))).toBe(true);
  });
  it('reconciles an already revoked token using only local cleanup, without repeating DELETE', async () => {
    const f = fixture();f.stored.set(resourceSecretKey(key()), secret + T);
    const values = { ...await input(f), capi_auth_token_id: T, acknowledge_ingestion_effects: true };delete (values as any).acknowledge_credential_access;
    await f.provider.applyWrite(operation(values, 'spotify_revoke_capi_credential'), guard);expect(mutations(f)).toHaveLength(0);expect(f.stored.size).toBe(0);
  });
  it('reports creation/storage uncertainty with the known ID and never rolls back or retries a native write', async () => {
    const f = fixture(), values = await input(f);vi.mocked(f.vault.putIfAbsent).mockRejectedValue(new Error(secret));
    const error = await f.provider.applyWrite(operation(values), guard).catch(error => error);
    expect(error.details).toMatchObject({ capi_auth_token_id: T });expect(JSON.stringify(error)).not.toContain(secret);expect(error.message).toContain('unconfirmed');expect(mutations(f)).toHaveLength(1);
  });
  it('treats a readback 403 after acknowledged creation as uncertainty, preserving the ID and stored secret', async () => {
    const f = fixture(), values = await input(f);f.readStatus(403);
    const error = await f.provider.applyWrite(operation(values), guard).catch(error => error);
    expect(error.message).toContain('unconfirmed');expect(error.details.capi_auth_token_id).toBe(T);expect(f.stored.size).toBe(1);expect(mutations(f)).toHaveLength(1);
  });
  it('sanitizes secret-bearing native errors and refuses automatic retries', async () => {
    const f = fixture(), values = await input(f);f.createStatus(400);
    const error = await f.provider.applyWrite(operation(values), guard).catch(error => error);
    expect(error.details).toEqual({ http_status: 400 });expect(JSON.stringify(error)).not.toContain(secret);expect(error.message).not.toContain(secret);expect(mutations(f)).toHaveLength(1);
  });
  it('reports a native 500 as uncertain rather than replaying token creation', async () => {
    const f = fixture(), values = await input(f);f.createStatus(500);
    const error = await f.provider.applyWrite(operation(values), guard).catch(error => error);
    expect(error.message).toContain('unconfirmed');expect(error.details.previous_credential_ids).toEqual([]);expect(JSON.stringify(error)).not.toContain(secret);expect(mutations(f)).toHaveLength(1);
  });
  it('retains a secret after revocation readback fails, then reconciles cleanup without another DELETE', async () => {
    const f = fixture();f.tokens([native()]);f.stored.set(resourceSecretKey(key()), secret + T);f.deleteReadStatus(403);
    const values = { ...await input(f), capi_auth_token_id: T, acknowledge_ingestion_effects: true };delete (values as any).acknowledge_credential_access;
    const error = await f.provider.applyWrite(operation(values, 'spotify_revoke_capi_credential'), guard).catch(error => error);
    expect(error.message).toContain('unconfirmed');expect(error.details.capi_auth_token_id).toBe(T);expect(f.stored.size).toBe(1);expect(mutations(f)).toHaveLength(1);
    f.recoverReads();const fresh = { ...await input(f), capi_auth_token_id: T, acknowledge_ingestion_effects: true };delete (fresh as any).acknowledge_credential_access;
    await f.provider.applyWrite(operation(fresh, 'spotify_revoke_capi_credential'), guard);
    expect(f.stored.size).toBe(0);expect(mutations(f)).toHaveLength(1);
  });
  it('fails closed without a private vault and distinguishes writes from destructive revocation', async () => {
    const f = fixture(), provider = new SpotifyAdsProvider(f.client), tools = spotifyTools(provider), values = await input(f);
    await expect(provider.previewWrite(operation(values), guard)).rejects.toThrow(/store must be configured/);
    expect(tools.find(t => t.name === 'spotify_create_capi_credential')!.input.safeParse({ account_id: A, ...values, acknowledge_credential_access: false }).success).toBe(false);
    expect(tools.find(t => t.name === 'spotify_create_capi_credential')!.annotations.destructive).toBe(false);
    expect(tools.find(t => t.name === 'spotify_revoke_capi_credential')!.annotations.destructive).toBe(true);
    expect(mutations(f)).toHaveLength(0);
  });
});
