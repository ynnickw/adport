import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { providerAllowedForOrganization } from '@/lib/cloud/provider-rollout';
import { resetEnvForTests } from '@/lib/env';

const mocks = vi.hoisted(() => ({ query: vi.fn(), credentials: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: () => mocks.query }));
vi.mock('@/lib/cloud/repository', () => ({
  getOrganizationPolicy: async () => DEFAULT_POLICY,
  loadProviderCredentials: mocks.credentials,
  loadEnabledAccountIds: async () => ({}), listOrganizationAdAccounts: async () => [],
  PostgresPendingStore: class {}, PostgresAuditStore: class {}, PostgresFindingsStore: class {},
}));
beforeEach(() => {
  vi.stubEnv('ADPORT_SYNTHETIC_REVIEWER_ORGANIZATION_IDS', 'reviewer-org'); resetEnvForTests();
  mocks.query.mockReset();
  mocks.credentials.mockReset().mockResolvedValue({});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network allowed'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvForTests(); });

it('retires reviewer runtime even for unscoped discovery without exposing demo or real tools', async () => {
  await expect(createTenantRuntime({ organizationId: 'reviewer-org', scopes: [] }, { enforceAccountScope: false }))
    .rejects.toMatchObject({ status: 403, message: expect.stringContaining('retired') });
  expect(mocks.credentials).not.toHaveBeenCalled();
  for (const id of ['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'] as const) expect(providerAllowedForOrganization(id, 'reviewer-org')).toBe(false);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects legacy reviewer sessions before loading credentials or synthetic state', async () => {
  await expect(createTenantRuntime({ organizationId: 'reviewer-org', scopes: [] })).rejects.toMatchObject({ status: 403 });
  expect(mocks.credentials).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});
it('cannot be enabled by a normal organization or a matching substring', async () => {
  const runtime = await createTenantRuntime({ organizationId: 'reviewer', scopes: [] });
  expect(runtime.dataSource).toBeUndefined();
  expect(runtime.registry.list().some(t => t.namespace === 'demo')).toBe(false);
  expect(mocks.credentials).toHaveBeenCalledWith('reviewer', false);
  expect(mocks.query).not.toHaveBeenCalled();
});

it('never enables demo tools from local demo environment flags in cloud', async () => {
  vi.stubEnv('ADPORT_DEMO', 'true');
  const runtime = await createTenantRuntime({ organizationId: 'real-org', scopes: [] });
  expect(runtime.ctx.providers.list()).toEqual([]);
  expect(runtime.registry.list().some(tool => /^(demo|mock|synthetic)_/.test(tool.name))).toBe(false);
  await expect(runtime.registry.call('demo_set_budget', {}, runtime.ctx)).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
  expect(fetch).not.toHaveBeenCalled();
});
