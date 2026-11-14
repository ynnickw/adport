import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type AdportRuntime } from '@adport/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { TenantPrincipal } from '@/lib/cloud/types';
import { HttpError } from '@/lib/http';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  principal: vi.fn(), runtime: vi.fn(), oauthClient: vi.fn(),
  servers: [] as Array<{ close(): Promise<void>; closed: ReturnType<typeof vi.fn> }>,
  handlers: [] as Array<{ close(): Promise<void> }>,
}));
vi.mock('@/lib/cloud/auth', () => ({ apiPrincipal: mocks.principal }));
vi.mock('@/lib/cloud/runtime', () => ({ createTenantRuntime: mocks.runtime }));
vi.mock('@/lib/cloud/mcp-oauth-repository', () => ({ getMcpOAuthClient: mocks.oauthClient }));
vi.mock('@/lib/cloud/tool-catalog', () => ({ principalToolSelection: async () => ({ profile: 'full', providers: null }) }));
vi.mock('@/lib/cloud/write-plan-limit', () => ({ adWritePlanLimit: async () => undefined }));
vi.mock('@adport/mcp', async importOriginal => {
  const actual = await importOriginal<typeof import('@adport/mcp')>();
  const track = (server: ReturnType<typeof actual.createMcpUiServer>) => { const closed = vi.fn(), previous = server.server.onclose;server.server.onclose = () => { closed();previous?.(); };mocks.servers.push({ close: () => server.close(), closed });return server; };
  return { ...actual, createMcpUiServer: (...args: Parameters<typeof actual.createMcpUiServer>) => track(actual.createMcpUiServer(...args)), createMcpServer: (...args: Parameters<typeof actual.createMcpServer>) => track(actual.createMcpServer(...args)) };
});
vi.mock('@modelcontextprotocol/server', async importOriginal => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/server')>();
  return { ...actual, createMcpHandler: (...args: Parameters<typeof actual.createMcpHandler>) => { const handler = actual.createMcpHandler(...args);mocks.handlers.push(handler);return handler; } };
});

import { ADPORT_UI_RESOURCE_URIS } from '@adport/mcp';
import { DELETE, GET, POST } from '@/app/mcp/route';
import { serveMcpHttp } from '@/lib/mcp-http';

const url = 'https://app.adport.test/mcp', uri = ADPORT_UI_RESOURCE_URIS[0]!;
const principal: TenantPrincipal = { organizationId: 'fixture-org', userId: 'fixture-user', apiKeyId: 'fixture-key', role: 'owner', scopes: ['tools:read'] };
let home: string, runtime: AdportRuntime;
const nativeFetch = vi.fn(() => Promise.reject(new Error('No external/provider network in HTTP lifecycle tests')));
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'adport-http-lifecycle-'));vi.stubEnv('ADPORT_HOME', home);
  runtime = await createContext({ providerModules: [], includeMock: false, engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(home, 'pending')), new AuditLog(join(home, 'audit'))) });
});
beforeEach(() => {
  vi.clearAllMocks();vi.stubGlobal('fetch', nativeFetch);
  mocks.principal.mockImplementation(async (request: Request) => { if (request.headers.get('authorization') !== 'Bearer fixture-token') throw new HttpError('Unauthorized', 401);return principal; });
  mocks.runtime.mockResolvedValue(runtime);mocks.oauthClient.mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(mocks.handlers.splice(0).map(handler => handler.close()));
  await Promise.all(mocks.servers.splice(0).map(server => server.close()));
  expect(nativeFetch).not.toHaveBeenCalled();vi.unstubAllGlobals();
});
afterAll(async () => { vi.unstubAllEnvs();await rm(home, { recursive: true, force: true }); });
async function finite(response: Response) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([response.text(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Response did not reach EOF')), 1000); })]); }
  finally { clearTimeout(timer); }
}
function post(method: string, params: Record<string, unknown> = {}, modern = false, id: number | null = 1, version = '2026-07-28') {
  return new Request(url, { method: 'POST', headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(modern ? { 'mcp-protocol-version': version, 'mcp-method': method, ...(method === 'resources/read' ? { 'mcp-name': uri } : method === 'tools/call' && typeof params.name === 'string' ? { 'mcp-name': params.name } : {}) } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params: { ...params, ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name: 'http-lifecycle', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } : {}) } }) });
}
function clientFor(era: 'modern' | 'legacy', wire: Array<{ http: string; rpc?: string; status: number }>) {
  const client = new Client({ name: 'http-lifecycle-client', version: '1' }, { ...(era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } as const } : {}), listChanged: { tools: { onChanged() {} }, resources: { onChanged() {} } } });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'Bearer fixture-token' } }, fetch: async (raw, init) => {
    const request = new Request(raw, init), body = request.method === 'POST' ? await request.clone().json() as { method?: string } : undefined;
    const response = await (request.method === 'POST' ? POST(request) : request.method === 'DELETE' ? DELETE(request) : GET(request));wire.push({ http: request.method, rpc: body?.method, status: response.status });return response;
  } });
  return { client, transport };
}

describe('stateless hosted MCP HTTP lifecycle with the real SDK', () => {
  it.each([undefined, '2025-03-26', '2025-11-25', '2026-07-28'])('finishes authenticated GET instead of opening an unreachable SSE stream (%s)', async version => {
    const response = await GET(new Request(url, { headers: { authorization: 'Bearer fixture-token', accept: 'text/event-stream', ...(version ? { 'mcp-protocol-version': version } : {}) } }));
    if (response.headers.get('content-type')?.includes('text/event-stream')) await response.body?.cancel();
    expect(response.status).toBe(405);expect(response.headers.get('allow')).toBe('POST');expect(response.headers.get('cache-control')).toBe('no-store');await finite(response);
    expect(mocks.runtime).not.toHaveBeenCalled();expect(mocks.oauthClient).not.toHaveBeenCalled();expect(mocks.servers).toHaveLength(0);
  });
  it.each([undefined, '2025-11-25', '2026-07-28'])('finishes authenticated DELETE without a fictitious session (%s)', async version => {
    const response = await DELETE(new Request(url, { method: 'DELETE', headers: { authorization: 'Bearer fixture-token', ...(version ? { 'mcp-protocol-version': version } : {}) } }));
    expect(response.status).toBe(405);expect(response.headers.get('allow')).toBe('POST');await finite(response);expect(mocks.runtime).not.toHaveBeenCalled();expect(mocks.servers).toHaveLength(0);
  });
  it.each(['GET', 'DELETE', 'POST'])('retains bearer authentication before %s protocol handling', async method => {
    const response = await ({ GET, DELETE, POST }[method]!)(new Request(url, { method }));expect(response.status).toBe(401);expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');expect(mocks.runtime).not.toHaveBeenCalled();expect(mocks.servers).toHaveLength(0);expect(await finite(response)).toContain('Unauthorized');
  });
  it.each(['resources/list', 'resources/read'])('finishes legacy %s JSON and tears down its per-request server', async method => {
    const response = await POST(post(method, method === 'resources/read' ? { uri } : {}));expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('application/json');const body = JSON.parse(await finite(response));expect(body.error).toBeUndefined();
    expect(mocks.runtime).not.toHaveBeenCalled();expect(mocks.servers).toHaveLength(1);expect(mocks.servers[0]!.closed).toHaveBeenCalled();
    if (method === 'resources/read') expect(body.result.contents[0]).toMatchObject({ uri, mimeType: 'text/html;profile=mcp-app' });
  });
  it('closes a legacy notification response and its request server', async () => {
    const response = await POST(post('notifications/initialized', {}, false, null));expect(response.status).toBe(202);expect(await finite(response)).toBe('');expect(mocks.servers[0]!.closed).toHaveBeenCalled();
  });
  it.each(['{', ''])('finishes malformed legacy POST and releases its request server (%s)', async body => {
    const response = await POST(new Request(url, { method: 'POST', headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body }));expect(response.status).toBe(400);expect(JSON.parse(await finite(response))).toHaveProperty('error');expect(mocks.servers[0]!.closed).toHaveBeenCalled();
  });
  it.each(['modern', 'legacy'] as const)('keeps %s SDK discovery, resources and read-only enforcement working without unsupported catalogue subscriptions', async era => {
    const wire: Array<{ http: string; rpc?: string; status: number }> = [], { client, transport } = clientFor(era, wire);
    try {
      await client.connect(transport);expect(client.getProtocolEra()).toBe(era);
      expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } });expect(client.autoOpenedSubscription).toBeUndefined();
      expect((await client.listTools()).tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
      expect((await client.listResources()).resources.some(resource => resource.uri === uri)).toBe(true);expect((await client.readResource({ uri })).contents[0]).toMatchObject({ uri, mimeType: 'text/html;profile=mcp-app' });
      await expect(client.callTool({ name: 'media_delete', arguments: { media_id: 'fixture' } })).rejects.toThrow();
      expect(wire.some(call => call.rpc === 'subscriptions/listen')).toBe(false);expect(wire.filter(call => call.http !== 'POST').every(call => call.status === 405)).toBe(true);
    } finally { await client.close(); }
  });
  it('finishes an explicit modern unsupported-listener request with an empty acknowledgement and complete response', async () => {
    const response = await POST(post('subscriptions/listen', { notifications: { toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: [uri] } }, true));expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/event-stream');const text = await finite(response);expect(text).toContain('notifications/subscriptions/acknowledged');expect(text).toContain('"notifications":{}');expect(text).toContain('"resultType":"complete"');
  });
  it('preserves request-scoped modern progress SSE and its final result/EOF', async () => {
    const server = new McpServer({ name: 'progress-fixture', version: '1' });
    server.registerTool('progress_probe', { inputSchema: z.object({}) }, async (_input, context) => {
      await context.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'fixture-progress', progress: 1, total: 1 } });
      return { content: [{ type: 'text', text: 'Progress completed' }] };
    });
    try {
      const response = await serveMcpHttp(server, post('tools/call', { name: 'progress_probe', arguments: {} }, true));expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/event-stream');const text = await finite(response);expect(text).toContain('notifications/progress');expect(text).toContain('Progress completed');
    } finally { await server.close(); }
  });
  it('does not replace a completed legacy result with a cleanup failure or log private errors', async () => {
    const server = new McpServer({ name: 'receipt-fixture', version: '1' }), close = server.close.bind(server), log = vi.spyOn(console, 'error').mockImplementation(() => {});let reads = 0;
    server.registerTool('receipt_probe', { inputSchema: z.object({}) }, async () => { reads++;return { content: [{ type: 'text', text: 'Completed result' }] }; });
    const cleanup = vi.spyOn(server, 'close').mockRejectedValue(new Error('private cleanup details'));
    try {
      const response = await serveMcpHttp(server, post('tools/call', { name: 'receipt_probe', arguments: {} }));expect(response.status).toBe(200);expect(await finite(response)).toContain('Completed result');expect(reads).toBe(1);expect(log).toHaveBeenCalledExactlyOnceWith('{"event":"mcp_http_cleanup_failed","era":"legacy"}');expect(JSON.stringify(log.mock.calls)).not.toContain('private cleanup details');
    } finally { cleanup.mockRestore();log.mockRestore();await close(); }
  });
  it('preserves modern version errors instead of falling back to a legacy handshake', async () => {
    const response = await POST(post('resources/list', {}, true, 1, '2099-01-01'));expect(response.status).toBe(400);const body = JSON.parse(await finite(response));expect(body.error.data.supported).toContain('2026-07-28');expect(body.error.data.requested).toBe('2099-01-01');
  });
});
