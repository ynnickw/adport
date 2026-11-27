import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';
import { createTenantRuntime } from '@/lib/cloud/runtime';

const mocks = vi.hoisted(() => ({ credentials: vi.fn(), request: vi.fn() }));
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), fetch: mocks.request }));
vi.mock('@/lib/cloud/repository', () => ({
  getOrganizationPolicy: async () => DEFAULT_POLICY,
  loadProviderCredentials: mocks.credentials,
  listOrganizationAdAccounts: async () => [{ provider: 'matomo', accountId: '1', name: 'Selected site', enabled: true }],
  loadEnabledAccountIds: async () => ({ matomo: new Set(['1']) }),
  PostgresAuditStore: class {}, PostgresPendingStore: class {}, PostgresFindingsStore: class {},
}));
const principal = { organizationId: 'project', scopes: ['tools:read'] };
afterEach(() => vi.clearAllMocks());

it('discovers unavailable Matomo reads and points owners to the analytics site picker', async () => {
  mocks.credentials.mockResolvedValue({});
  const runtime = await createTenantRuntime(principal, { surface: 'mcp', catalog: { profile: 'reporting', providers: ['matomo'] } });
  const result = await runtime.registry.call('capabilities_list', { provider: 'matomo' }, runtime.ctx);
  expect(result).toMatchObject({ total_matches: 8, tools: expect.arrayContaining([expect.objectContaining({
    read_only: true, enabled: false, blockers: ['not_connected'], next_steps: [expect.stringContaining('Analytics & tracking')],
  })]) });
  expect(mocks.request).not.toHaveBeenCalled();
});

it('authorizes only enabled sites for every native tool and excludes other platforms from selection', async () => {
  mocks.credentials.mockResolvedValue({ matomo: { url: 'https://example.matomo.cloud', tokenAuth: 'local-test' } });
  const runtime = await createTenantRuntime(principal, { surface: 'mcp', catalog: { profile: 'reporting', providers: ['matomo'] } });
  expect(await runtime.ctx.providers.get('matomo').listAccounts()).toMatchObject([{ id: '1' }]);
  const tools = runtime.registry.list().filter(tool => tool.namespace === 'matomo');
  expect(tools).toHaveLength(8);
  for (const tool of tools) expect(() => runtime.ctx.authorizeToolCall!(tool, { account_id: '2' })).toThrow(/not active/);
  expect(runtime.registry.list().some(tool => tool.namespace === 'openai')).toBe(false);
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.request.mockResolvedValue(Response.json([{ visits: 4 }]));
  await expect(runtime.registry.call('matomo_realtime_report', { account_id: '1' }, runtime.ctx)).resolves.toMatchObject({ rows: [{ metrics: { visits: 4 } }] });
});
