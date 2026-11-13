import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createContext, selectRuntimeCatalog } from '../src/context.js';
import { MockProvider } from '../src/testing/mock-provider.js';
import { defineTool } from '../src/tools/registry.js';
import { withProjectRouting } from '../src/tools/projects.js';

async function fixture(canWrite = true) {
  const execute = vi.fn();
  const provider = new MockProvider();
  Object.defineProperty(provider, 'id', { value: 'meta' });
  const runtime = await createContext({ providerModules: [{ provider, tools: [
    ...['meta_create_lookalike_audience', 'meta_create_campaign', 'google_create_experiment', 'meta_api_create'].map(name => defineTool({
      name, namespace: name.split('_')[0]!, description: name.replaceAll('_', ' '), input: z.object({}), handler: execute,
    })),
    defineTool({ name: 'meta_get_custom_audience', namespace: 'meta', description: 'Inspect a custom audience', input: z.object({}), annotations: { readOnly: true }, handler: execute }),
  ] }] });
  return { execute, runtime: selectRuntimeCatalog(runtime, { profile: 'standard', providers: ['meta'] }, false,
    { canWrite, manageAccessUrl: 'https://app.adport.test/dashboard/agents?connection=fixture' }) };
}

describe('capability discovery without expanding access', () => {
  it('finds a hidden workflow with enablement steps, but cannot execute it', async () => {
    const { runtime, execute } = await fixture();
    const result = await runtime.registry.call('capabilities_list', { provider: 'meta', query: 'lookalike' }, runtime.ctx);
    expect(result).toMatchObject({ profile: 'standard', tools: [{ name: 'meta_create_lookalike_audience', enabled: false, blockers: ['profile_disabled'], next_steps: [expect.stringContaining('Full')] }], manage_access_url: expect.stringContaining('/dashboard/agents') });
    expect(runtime.registry.get('capabilities_list').output!.safeParse(result).success).toBe(true);
    await expect(runtime.registry.call('meta_create_lookalike_audience', {}, runtime.ctx)).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('distinguishes an excluded, disconnected platform and read-only access from a profile restriction', async () => {
    const { runtime } = await fixture(false);
    expect(await runtime.registry.call('capabilities_list', { provider: 'google', query: 'experiment' }, runtime.ctx)).toMatchObject({
      tools: [{ name: 'google_create_experiment', blockers: ['platform_disabled', 'not_connected', 'profile_disabled', 'write_permission_required'] }],
    });
    expect(await runtime.registry.call('capabilities_list', { provider: 'meta', query: 'create campaign' }, runtime.ctx)).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: 'meta_create_campaign', blockers: ['write_permission_required'] })]),
    });
  });
  it('never advertises raw tools and bounds search results', async () => {
    const { runtime } = await fixture();
    const result = await runtime.registry.call('capabilities_list', { limit: 1 }, runtime.ctx) as { tools: Array<{ name: string }>; truncated: boolean };
    expect(result.tools).toHaveLength(1); expect(result.truncated).toBe(true);
    expect(await runtime.registry.call('capabilities_list', { query: 'meta_api_create' }, runtime.ctx)).not.toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: 'meta_api_create' })]) });
  });
  it('retains the original catalog and selection when the MCP adapter filters a second time', async () => {
    const { runtime } = await fixture();
    const twice = selectRuntimeCatalog(runtime, { profile: 'full', providers: null });
    expect(await twice.registry.call('capabilities_list', { query: 'lookalike' }, twice.ctx)).toMatchObject({ profile: 'standard', tools: [{ enabled: false, blockers: ['profile_disabled'] }] });
  });
  it('uses only the authorized selected project’s metadata and permissions', async () => {
    const { runtime: one } = await fixture(true);
    const { runtime: two } = await fixture(false);
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const routed = withProjectRouting(one, { list: async () => ids.map(id => ({ id, name: id, organization_name: 'Fixture', role: 'owner', providers: ['meta'] })), resolve: async id => {
      if (id === ids[0]) return one;
      if (id === ids[1]) return two;
      throw new Error('Unauthorized project');
    } });
    await expect(routed.registry.call('capabilities_list', {}, routed.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await routed.registry.call('capabilities_list', { project_id: ids[1], query: 'lookalike' }, routed.ctx)).toMatchObject({ tools: [{ blockers: ['profile_disabled', 'write_permission_required'] }] });
  });
});
