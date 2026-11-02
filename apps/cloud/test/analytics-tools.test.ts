import { beforeEach, expect, it, vi } from 'vitest';
import { AdportError, ToolRegistry, defineTool, type AdportRuntime } from '@adport/core';
import { z } from 'zod';
const { capture, verify } = vi.hoisted(() => ({ capture: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/cloud/assistant-connection', () => ({ recordAssistantRead: verify }));
vi.mock('@/lib/cloud/product-analytics', () => ({ captureProductEvent: capture }));
import { instrumentCloudTools } from '@/lib/cloud/analytics-tools';

const principal = { userId: 'user', organizationId: 'project', scopes: ['tools:read'] };
function runtime(handler: () => Promise<unknown>, readOnly = true, name = 'report') {
  const registry = new ToolRegistry();
  registry.register(defineTool({ name, namespace: 'core', description: 'test', input: z.object({ pending_operation_id: z.string().optional() }), annotations: { readOnly }, handler }));
  return instrumentCloudTools({ registry, ctx: {} } as AdportRuntime, principal, 'mcp');
}
beforeEach(() => { capture.mockClear(); verify.mockReset(); });
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

it.each([
  ['accounts_list', { accounts: [{ id: 'enabled-account' }], errors: [] }, true],
  ['report', { rows: [{ spend: 0 }], errors: [] }, true],
  ['accounts_list', { accounts: [], errors: [] }, false],
  ['report', { rows: [], errors: [] }, false],
  ['report', { rows: [{ spend: 2 }], errors: [{ provider: 'google' }] }, false],
  ['accounts_list', { accounts: [{ id: 'demo' }], data_source: 'synthetic' }, false],
  ['health', { ok: true }, false],
] as const)('verifies only a successful data read: %s %j', async (name, result, qualifies) => {
  const tool = runtime(async () => result, true, name);
  expect(await tool.registry.call(name, {}, tool.ctx)).toBe(result);
  expect(verify).toHaveBeenCalledTimes(qualifies ? 1 : 0);
});

it('does not verify dashboard reads or let verification storage break an answer', async () => {
  const tool = runtime(async () => ({ accounts: [{ id: 'a' }] }), true, 'accounts_list');
  verify.mockRejectedValue(new Error('database unavailable'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(tool.registry.call('accounts_list', {}, tool.ctx)).resolves.toEqual({ accounts: [{ id: 'a' }] });
  error.mockRestore(); verify.mockClear();
  const dashboard = instrumentCloudTools({ registry: new ToolRegistry(), ctx: {} } as AdportRuntime, principal, 'dashboard');
  dashboard.registry.register(defineTool({ name: 'report', namespace: 'core', description: 'test', input: z.object({}), annotations: { readOnly: true }, handler: async () => ({ rows: [{ spend: 1 }] }) }));
  await dashboard.registry.call('report', {}, dashboard.ctx);
  expect(verify).not.toHaveBeenCalled();
});
