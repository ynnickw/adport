import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, syntheticSeed } from '@adport/core';
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
  mocks.query.mockReset().mockResolvedValue([{ campaigns: syntheticSeed() }]);
  mocks.credentials.mockReset().mockResolvedValue({});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network allowed'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvForTests(); });

it('isolates even unscoped discovery from all real credentials and blocks provider OAuth', async () => {
  const runtime = await createTenantRuntime({ organizationId: 'reviewer-org', scopes: [] }, { enforceAccountScope: false });
  expect(runtime.dataSource).toBe('synthetic');
  expect(runtime.ctx.providers.list().map(p => p.id)).toEqual(['demo']);
  expect(mocks.credentials).not.toHaveBeenCalled();
  for (const id of ['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'] as const) expect(providerAllowedForOrganization(id, 'reviewer-org')).toBe(false);
  await expect(runtime.registry.call('report', { account_ids: ['real-account'] }, runtime.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  await expect(runtime.registry.call('accounts_list', { provider: 'google' }, runtime.ctx)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  expect(fetch).not.toHaveBeenCalled();
});
it('fails closed when provisioned state is absent instead of loading real providers', async () => {
  mocks.query.mockResolvedValue([]);
  await expect(createTenantRuntime({ organizationId: 'reviewer-org', scopes: [] })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  expect(mocks.credentials).not.toHaveBeenCalled();
});
it('cannot be enabled by a normal organization or a matching substring', async () => {
  const runtime = await createTenantRuntime({ organizationId: 'reviewer', scopes: [] });
  expect(runtime.dataSource).toBeUndefined();
  expect(runtime.registry.list().some(t => t.namespace === 'demo')).toBe(false);
  expect(mocks.credentials).toHaveBeenCalledWith('reviewer', false);
  expect(mocks.query).not.toHaveBeenCalled();
});
