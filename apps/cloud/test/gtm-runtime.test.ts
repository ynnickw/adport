import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { resetEnvForTests } from '@/lib/env';

vi.mock('@/lib/cloud/repository', () => ({
  getOrganizationPolicy: async () => DEFAULT_POLICY,
  loadEnabledAccountIds: async () => ({ gtm: new Set(['1']) }),
  listOrganizationAdAccounts: async () => [{ provider: 'gtm', accountId: '1', name: 'Selected GTM' }],
  loadProviderCredentials: async () => ({ gtm: { refreshToken: 'tenant-grant', connectionId: 'gtm-connection' } }),
  PostgresAuditStore: class {}, PostgresPendingStore: class {}, PostgresFindingsStore: class {},
}));
beforeEach(() => {
  vi.stubEnv('GTM_OAUTH_ENABLED', 'true');
  vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'test-client.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'test-secret'); resetEnvForTests();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected provider request'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvForTests(); });

describe('tenant-scoped GTM runtime', () => {
  it('registers the shared tools and retains selected accounts without discovery requests', async () => {
    const runtime = await createTenantRuntime({ organizationId: 'org', scopes: [] });
    const provider = runtime.ctx.providers.get('gtm');
    expect(await provider.listAccounts()).toMatchObject([{ id: '1', name: 'Selected GTM' }]);
    expect(runtime.registry.list().filter(tool => tool.namespace === 'gtm')).toHaveLength(24);
    expect(provider.capabilities().reporting).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('denies every GTM read and write for an account outside this project before network access', async () => {
    const runtime = await createTenantRuntime({ organizationId: 'org', scopes: [] });
    for (const tool of runtime.registry.list().filter(tool => tool.namespace === 'gtm')) {
      expect(() => runtime.ctx.authorizeToolCall!(tool, { account_id: '999' })).toThrow(/not active/);
    }
    await expect(runtime.registry.call('gtm_list_containers', { account_id: '999' }, runtime.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    const op = { provider: 'gtm', accountId: '999', tool: 'gtm_create_workspace', kind: 'create' as const, payload: { container_id: '2', name: 'Draft' } };
    await expect(runtime.ctx.providers.get('gtm').previewWrite(op, { forcePausedCreation: true })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(runtime.ctx.providers.get('gtm').applyWrite(op, { forcePausedCreation: true })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
