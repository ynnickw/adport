import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore } from '@adport/core';
import { catalogGrant } from '@adport/provider-tiktok';
const mocks = vi.hoisted(() => ({ policy: vi.fn(), inventory: vi.fn(), enabled: vi.fn(), credentials: vi.fn(), native: vi.fn(), storeGet: vi.fn(), storeList: vi.fn(), storeSet: vi.fn(), pending: undefined as unknown, audit: undefined as unknown }));
vi.mock('@/lib/cloud/repository', () => ({ getOrganizationPolicy: mocks.policy, listOrganizationAdAccounts: mocks.inventory, loadEnabledAccountIds: mocks.enabled, loadProviderCredentials: mocks.credentials,
  PostgresPendingStore: class { constructor() { return mocks.pending as object; } }, PostgresAuditStore: class { constructor() { return mocks.audit as object; } } }));
vi.mock('@/lib/cloud/tiktok-catalog-access', () => ({ PostgresTikTokCatalogAccessStore: class { canManage = true;canWrite = false;get = mocks.storeGet;list = mocks.storeList;compareAndSet = mocks.storeSet;authorize = mocks.storeGet; } }));
vi.mock('@/lib/cloud/provider-oauth', () => ({ hydrateTikTok: () => ({ accessToken: 'inert' }) }));
vi.mock('@adport/provider-tiktok', async load => {
  const actual = await load<typeof import('@adport/provider-tiktok')>();return { ...actual, TikTokClient: class { get = mocks.native; } };
});
import { createCatalogAccessRuntime } from '@/lib/cloud/catalog-access-runtime';

const scope = { accountId: '123', businessId: '456', resourceId: '789', kind: 'catalog' as const }, principal = { organizationId: '203c14b1-c908-4632-9aa7-1be5de4ae9b0', userId: 'owner', role: 'owner' as const, scopes: ['tools:read', 'connections:manage'] };
const directories: string[] = [];let current = catalogGrant(scope, 'write', 1);
beforeEach(async () => {
  vi.clearAllMocks();current = catalogGrant(scope, 'write', 1);const dir = await mkdtemp(join(tmpdir(), 'catalog-control-runtime-'));directories.push(dir);mocks.pending = new PendingStore(join(dir, 'pending'));mocks.audit = new AuditLog(join(dir, 'audit'));
  mocks.policy.mockResolvedValue(DEFAULT_POLICY);mocks.inventory.mockResolvedValue([{ provider: 'tiktok', accountId: '123', enabled: false }]);mocks.enabled.mockResolvedValue({});mocks.credentials.mockResolvedValue({});mocks.storeGet.mockImplementation(async () => current);mocks.storeList.mockImplementation(async () => current.mode === 'none' ? [] : [current]);mocks.storeSet.mockImplementation(async (_scope, hash, mode) => { if (current.hash !== hash) throw new Error('stale');current = catalogGrant(scope, mode, current.revision + 1);return current; });
});
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('owner permission runtime stays separate from native operation runtimes', () => {
  it('lists and revokes on a disconnected advertiser without loading native credentials or calling TikTok', async () => {
    const runtime = await createCatalogAccessRuntime(principal, '123');expect(await runtime.registry.call('tiktok_catalog_access', { account_id: '123' }, runtime.ctx)).toHaveProperty('grants.0.mode', 'write');
    const args = { account_id: '123', bc_id: '456', catalog_id: '789', mode: 'none', expected_access_hash: current.hash }, preview = await runtime.registry.call('tiktok_set_catalog_access', args, runtime.ctx) as { pending_operation_id: string };expect(current.mode).toBe('write');expect(await runtime.registry.call('tiktok_set_catalog_access', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toHaveProperty('result.applied', true);expect(current.mode).toBe('none');expect(mocks.credentials).not.toHaveBeenCalled();expect(mocks.native).not.toHaveBeenCalled();expect(mocks.enabled).not.toHaveBeenCalled();
  });
  it('cannot register native mutation tools and refuses enabling an inactive advertiser before credential lookup', async () => {
    const runtime = await createCatalogAccessRuntime(principal, '123');for (const name of ['tiktok_update_catalog', 'tiktok_create_campaign', 'tiktok_api_read']) await expect(runtime.registry.call(name, {}, runtime.ctx)).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
    await expect(runtime.registry.call('tiktok_set_catalog_access', { account_id: '123', bc_id: '456', catalog_id: '789', mode: 'read', expected_access_hash: current.hash }, runtime.ctx)).rejects.toThrow('Enable the advertiser');expect(mocks.credentials).not.toHaveBeenCalled();expect(mocks.native).not.toHaveBeenCalled();expect(mocks.storeSet).not.toHaveBeenCalled();
    await expect(runtime.registry.call('tiktok_catalog_access', { account_id: '999' }, runtime.ctx)).rejects.toThrow('not active');
  });
  it.each([{ apiKeyId: 'owner-key' }, { clientId: 'owner-oauth' }, { role: 'member' as const }, { scopes: ['tools:read', 'tools:write'] }])('rejects non-session control authority %o before project reads', async patch => {
    await expect(createCatalogAccessRuntime({ ...principal, ...patch }, '123')).rejects.toThrow('signed-in project owner');expect(mocks.policy).not.toHaveBeenCalled();expect(mocks.inventory).not.toHaveBeenCalled();expect(mocks.credentials).not.toHaveBeenCalled();
  });
});
