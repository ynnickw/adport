import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GravityMcpTransport } from '@/lib/cloud/gravity-mcp';

const f = vi.hoisted(() => ({ discover: vi.fn(), call: vi.fn(), transport: vi.fn(), close: vi.fn() }));
vi.mock('@modelcontextprotocol/client', () => ({
  Client: class { connect = vi.fn(); listTools = f.discover; callTool = f.call; close = f.close; },
  StreamableHTTPClientTransport: class { constructor(url: URL, options: unknown) { f.transport(url, options); } },
}));
afterEach(() => vi.resetAllMocks());
const schema = z.object({ campaign_id: z.string(), status: z.string() });
const descriptor = { name: 'dashboard_update_campaign', inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' }, body: { type: 'object' } }, required: ['campaign_id','body'] } };
const entity = { campaign_id: 'c', status: 'paused' };
function client() { f.close.mockResolvedValue(undefined); return new GravityMcpTransport(async () => 'access'); }

it('discovers the scoped tool across pages and returns a validated receipt', async () => {
  f.discover.mockResolvedValueOnce({ tools: [], nextCursor: 'page2' }).mockResolvedValueOnce({ tools: [descriptor] });
  f.call.mockResolvedValue({ content: [], structuredContent: entity });
  await expect(client().patch('campaigns/c', schema, { status: 'paused' })).resolves.toEqual(entity);
  expect(f.call).toHaveBeenCalledWith({ name: descriptor.name, arguments: { campaign_id: 'c', body: { status: 'paused' } } });
  expect(f.transport.mock.calls[0]![0].href).toBe('https://platform.trygravity.ai/mcp');
  expect(f.transport.mock.calls[0]![1].requestInit).toEqual({ headers: { authorization: 'Bearer access' }, redirect: 'error' });
});

it('never dispatches an unknown or incompatible operation and never treats an approval plan as a receipt', async () => {
  f.discover.mockResolvedValueOnce({ tools: [{ ...descriptor, inputSchema: { properties: { campaign_id: {} } } }] });
  await expect(client().patch('campaigns/c', schema, { status: 'paused' })).rejects.toThrow(/compatible/);
  expect(f.call).not.toHaveBeenCalled();
  f.discover.mockResolvedValueOnce({ tools: [descriptor] });
  f.call.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ ...entity, plan_id: 'p' }) }] });
  await expect(client().patch('campaigns/c', schema, { status: 'paused' })).rejects.toThrow(/approval/);
  f.discover.mockResolvedValueOnce({ tools: [descriptor] });
  f.call.mockResolvedValueOnce({ content: [], structuredContent: { result: { ...entity, requires_approval: true } } });
  await expect(client().patch('campaigns/c', schema, { status: 'paused' })).rejects.toThrow(/approval/);
  expect(f.call).toHaveBeenCalledTimes(2);
  await expect(client().get('https://untrusted.example', schema)).rejects.toThrow(/Unsupported/);
});
