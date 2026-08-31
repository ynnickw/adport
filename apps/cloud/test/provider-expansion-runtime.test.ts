import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { resetEnvForTests } from '@/lib/env';
import { rotateProviderTokens } from '@/lib/cloud/credential-rotation';

const ids = ['snapchat', 'spotify', 'pinterest', 'linkedin', 'x'];
vi.mock('@/lib/cloud/credential-rotation', () => ({ rotateProviderTokens: vi.fn(async () => {}) }));
vi.mock('@/lib/cloud/repository', () => ({
  getOrganizationPolicy: async () => DEFAULT_POLICY,
  listOrganizationAdAccounts: async () => ['snapchat', 'spotify', 'pinterest', 'linkedin', 'x'].map(provider => ({ provider, accountId: 'allowed', name: 'Selected', enabled: true })),
  loadEnabledAccountIds: async () => Object.fromEntries(['snapchat', 'spotify', 'pinterest', 'linkedin', 'x'].map(id => [id, new Set(['allowed'])])),
  loadProviderCredentials: async () => Object.fromEntries(['snapchat', 'spotify', 'pinterest', 'linkedin', 'x'].map(provider => [provider, {
    connectionId: `${provider}-connection`,
    ...(provider === 'x' ? { accessToken: 'access', accessTokenSecret: 'secret' }
      : provider === 'linkedin' ? { accessToken: 'access' } : { refreshToken: 'refresh' }),
  }])),
  PostgresAuditStore: class {}, PostgresPendingStore: class {}, PostgresFindingsStore: class {},
}));

beforeEach(() => {
  for (const name of ['SNAPCHAT', 'SPOTIFY', 'PINTEREST', 'LINKEDIN']) {
    vi.stubEnv(`${name}_CLIENT_ID`, 'test-client'); vi.stubEnv(`${name}_CLIENT_SECRET`, 'test-secret');
  }
  vi.stubEnv('X_CONSUMER_KEY', 'test-key'); vi.stubEnv('X_CONSUMER_SECRET', 'test-secret');
  resetEnvForTests(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected provider request'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvForTests(); });

describe('expanded cloud runtime on production account controls', () => {
  it('registers all five real modules without network calls or mock tools', async () => {
    const runtime = await createTenantRuntime({ organizationId: 'org', scopes: [] });
    expect(runtime.ctx.providers.list().map(provider => provider.id).sort()).toEqual([...ids].sort());
    expect(runtime.registry.list().some(tool => tool.name.startsWith('mock_'))).toBe(false);
    for (const id of ids) {
      expect(runtime.registry.list().some(tool => tool.namespace === id && tool.annotations.readOnly)).toBe(true);
      expect(runtime.registry.list().some(tool => tool.namespace === id && !tool.annotations.readOnly)).toBe(true);
    }
    expect(runtime.ctx.findings).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves active-account authorization for every new provider and native tool', async () => {
    const runtime = await createTenantRuntime({ organizationId: 'org', scopes: [] });
    for (const provider of runtime.ctx.providers.list()) {
      await expect(provider.listAccounts()).resolves.toEqual([{ provider: provider.id, id: 'allowed', name: 'Selected', currency: undefined, status: undefined }]);
      await expect(provider.report({ accountIds: ['blocked'], level: 'campaign', metrics: ['spend'], dateRange: 'last_7_days' })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
      const operation = { provider: provider.id, accountId: 'blocked', tool: 'test', kind: 'update' as const, payload: {} };
      await expect(provider.previewWrite(operation, { forcePausedCreation: true })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
      await expect(provider.applyWrite(operation, { forcePausedCreation: true })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
      for (const tool of runtime.registry.list().filter(tool => tool.namespace === provider.id)) {
        expect(() => runtime.ctx.authorizeToolCall!(tool, { account_id: 'blocked' })).toThrow(/not active/);
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not expose the new provider modules outside the test organization', async () => {
    vi.stubEnv('ADPORT_PROVIDER_TEST_ORGANIZATION_IDS', 'owner-org'); resetEnvForTests();
    const runtime = await createTenantRuntime({ organizationId: 'other-org', scopes: [] });
    expect(runtime.ctx.providers.list()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists a rotated refresh token during unscoped account discovery', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'access', refresh_token: 'rotated', expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ businesses: [] })));
    const runtime = await createTenantRuntime({ organizationId: 'org', scopes: [] }, { enforceAccountScope: false });
    await expect(runtime.ctx.providers.get('spotify').listAccounts()).resolves.toEqual([]);
    expect(rotateProviderTokens).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org', provider: 'spotify', connectionId: 'spotify-connection', tokens: { refreshToken: 'rotated' } }));
  });
});
