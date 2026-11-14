import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { resetEnvForTests } from '@/lib/env';

vi.mock('@/lib/cloud/repository', () => ({
  getOrganizationPolicy: async () => DEFAULT_POLICY,
  loadEnabledAccountIds: async () => ({ ga4: new Set(['123']), gsc: new Set(['sc-domain:example.com']) }),
  listOrganizationAdAccounts: async () => [{ provider: 'ga4', accountId: '123', name: 'Selected website' }, { provider: 'gsc', accountId: 'sc-domain:example.com', name: 'Selected site' }],
  loadProviderCredentials: async () => ({ ga4: { refreshToken: 'ga4-grant', connectionId: 'ga4-connection' }, gsc: { refreshToken: 'gsc-grant', connectionId: 'gsc-connection' } }),
  PostgresAuditStore: class {}, PostgresPendingStore: class {}, PostgresFindingsStore: class {},
}));
beforeEach(() => {
  vi.stubEnv('ANALYTICS_TEST_ORGANIZATION_IDS', 'internal');
  vi.stubEnv('GA4_OAUTH_ENABLED', 'false'); vi.stubEnv('GSC_OAUTH_ENABLED', 'false');
  vi.stubEnv('GOOGLE_ANALYTICS_CLIENT_ID', 'analytics-client.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_ANALYTICS_CLIENT_SECRET', 'analytics-secret'); resetEnvForTests();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected provider request'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvForTests(); });
describe('selected analytics properties', () => {
  it('lists enabled inventory without requesting other Google properties', async () => {
    const runtime = await createTenantRuntime({ organizationId: 'internal', scopes: ['tools:read'] });
    expect(await runtime.ctx.providers.get('ga4').listAccounts()).toMatchObject([{ id: '123', name: 'Selected website' }]);
    expect(await runtime.ctx.providers.get('gsc').listAccounts()).toMatchObject([{ id: 'sc-domain:example.com' }]);
    for (const provider of ['ga4', 'gsc']) {
      const tools = runtime.registry.list().filter(tool => tool.namespace === provider);
      expect(tools).toHaveLength(4); expect(tools.every(tool => tool.annotations.readOnly)).toBe(true);
      expect(runtime.ctx.providers.get(provider).capabilities().reporting).toBe(false);
      for (const tool of tools) expect(() => runtime.ctx.authorizeToolCall!(tool, { account_id: '999' })).toThrow(/not active/);
    }
    await expect(runtime.registry.call('ga4_get_property', { account_id: '999' }, runtime.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(runtime.registry.call('gsc_get_site', { account_id: 'sc-domain:other.test' }, runtime.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not expose unreleased analytics to an unrelated customer project', async () => {
    const runtime = await createTenantRuntime({ organizationId: 'customer', scopes: ['tools:read'] }, { surface: 'mcp' });
    expect(runtime.registry.list().filter(tool => ['ga4', 'gsc'].includes(tool.namespace))).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
