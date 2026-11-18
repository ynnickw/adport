import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';
import { createTenantRuntime } from '@/lib/cloud/runtime';
vi.mock('@/lib/cloud/repository', () => ({
  getOrganizationPolicy: async () => DEFAULT_POLICY,
  listOrganizationAdAccounts: async () => [{ provider: 'openai', accountId: 'adacct_123', name: 'Selected advertiser', enabled: true }],
  loadEnabledAccountIds: async () => ({ openai: new Set(['adacct_123']) }),
  loadProviderCredentials: async () => ({ openai: { connectionId: 'connection', apiKey: 'test-key' } }),
  PostgresAuditStore: class {}, PostgresPendingStore: class {}, PostgresFindingsStore: class {},
}));
afterEach(() => vi.unstubAllGlobals());
describe('OpenAI hosted runtime account scope', () => {
  it('registers the shared tools and rejects every native tool for an unselected account before requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'adacct_123', name: 'Selected advertiser', currency_code: 'USD', timezone: 'UTC' })));
    const runtime = await createTenantRuntime({ organizationId: 'org', scopes: ['tools:read', 'tools:write'] });
    expect(await runtime.ctx.providers.get('openai').listAccounts()).toMatchObject([{ id: 'adacct_123' }]);
    vi.mocked(fetch).mockClear();
    const tools = runtime.registry.list().filter(tool => tool.namespace === 'openai');
    expect(tools).toHaveLength(12);
    for (const tool of tools) expect(() => runtime.ctx.authorizeToolCall!(tool, { account_id: 'adacct_blocked' })).toThrow(/not active/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
