import { beforeEach, expect, it, vi } from 'vitest';
import { AdportError, ToolRegistry, defineTool, type AdportRuntime } from '@adport/core';
import { z } from 'zod';
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/cloud/product-analytics', () => ({ captureProductEvent: capture }));
import { instrumentCloudTools } from '@/lib/cloud/analytics-tools';

const principal = { userId: 'user', organizationId: 'project', scopes: ['tools:read'] };
function runtime(handler: () => Promise<unknown>, readOnly = true, name = 'report') {
  const registry = new ToolRegistry();
  registry.register(defineTool({ name, namespace: 'core', description: 'test', input: z.object({ pending_operation_id: z.string().optional() }), annotations: { readOnly }, handler }));
  return instrumentCloudTools({ registry, ctx: {} } as AdportRuntime, principal, 'mcp');
}
beforeEach(() => capture.mockClear());
it('preserves results and distinguishes previews from actual applied changes', async () => {
  const result = { status: 'pending_validation', pending_operation_id: 'secret' };
  const tool = runtime(async () => result, false, 'test_write');
  expect(await tool.registry.call('test_write', {}, tool.ctx)).toBe(result);
  expect(capture).toHaveBeenLastCalledWith(principal, { event: 'tool_completed', category: 'write_preview', surface: 'mcp' });
  await tool.registry.call('test_write', { pending_operation_id: 'secret' }, tool.ctx);
  expect(capture).toHaveBeenLastCalledWith(principal, { event: 'tool_completed', category: 'write_preview', surface: 'mcp' });
  const applied = runtime(async () => ({ status: 'applied', applied: true }), false, 'test_write');
  await applied.registry.call('test_write', { pending_operation_id: 'secret' }, applied.ctx);
  expect(capture).toHaveBeenLastCalledWith(principal, { event: 'tool_completed', category: 'write_apply', surface: 'mcp' });
  expect(JSON.stringify(capture.mock.calls)).not.toContain('secret');
});
it('preserves policy rejections and marks partial provider failure as failure', async () => {
  const error = new AdportError('POLICY_VIOLATION', 'private account detail');
  const tool = runtime(async () => { throw error; }, false, 'test_write');
  await expect(tool.registry.call('test_write', {}, tool.ctx)).rejects.toBe(error);
  expect(capture).toHaveBeenLastCalledWith(principal, { event: 'tool_failed', category: 'write_preview', surface: 'mcp', reason: 'policy' });
  const partial = runtime(async () => ({ rows: [], errors: [{ message: 'private provider detail' }] }));
  await partial.registry.call('report', {}, partial.ctx);
  expect(capture).toHaveBeenLastCalledWith(principal, { event: 'tool_failed', category: 'report', surface: 'mcp', reason: 'provider' });
});
it('does not double count tools called by another tool', async () => {
  const tool = runtime(async () => ({ rows: [] }));
  tool.registry.register(defineTool({ name: 'outer', namespace: 'core', description: 'test', input: z.object({}), annotations: { readOnly: true }, handler: async () => tool.registry.call('report', {}, tool.ctx) }));
  await tool.registry.call('outer', {}, tool.ctx);
  expect(capture).toHaveBeenCalledTimes(1);
});
