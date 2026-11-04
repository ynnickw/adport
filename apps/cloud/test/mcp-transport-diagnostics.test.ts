import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpHandler, McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { diagnoseMcpRejection } from '@/lib/mcp-transport-diagnostics';
import { inspectMcpRequest } from '@/lib/mcp-ui-request';

afterEach(() => vi.restoreAllMocks());

describe('MCP transport rejection diagnostics', () => {
  it('reports a native legacy HTTP200 resource error using the pre-inspected method, leaving the response intact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = new Request('https://adport.test/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: 'Bearer private-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'private-id', method: 'resources/read', params: { uri: 'ui://diagnostics/private-value' } }) });
    const shape = await inspectMcpRequest(request);
    expect(shape).toEqual({ uiOnly: false, discoveryMethod: 'resources/read' });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = new McpServer({ name: 'legacy-diagnostics', version: '1' });
    server.registerResource('fixture', 'ui://diagnostics/known', {}, async () => ({ contents: [] }));
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      expect(response.status).toBe(200);
      await diagnoseMcpRejection(request, response, 'transport', shape.discoveryMethod);
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ status: 200, rpcMethod: 'resources/read', reason: 'invalid_params' });
      expect(await response.json()).toHaveProperty('error');
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-token|private-value|private-id|Bearer/);
    } finally { await server.close(); }
  });

  it('does not inspect or log legacy business errors or successful discovery data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const method of ['tools/call', 'tools/list']) {
      const request = new Request('https://adport.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { private: 'private-value' } }) });
      const shape = await inspectMcpRequest(request);
      const response = method === 'tools/call' ? Response.json({ error: { code: -32603, message: 'private-value' } }) : Response.json({ result: { tools: [{ description: 'private-value' }] } });
      await diagnoseMcpRejection(request, response, 'transport', shape.discoveryMethod);
      expect(await response.json()).toBeDefined();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{', {}, 400, 'invalid_json'],
    ['invalid JSON-RPC', '{"secret":"private-value"}', {}, 400, 'invalid_jsonrpc'],
    ['unsupported protocol', '{"jsonrpc":"2.0","method":"tools/list","id":1}', { 'mcp-protocol-version': '2099-01-01' }, 400, 'unsupported_protocol'],
    ['missing SSE accept', '{}', { accept: 'application/json' }, 406, 'accept_json_and_sse_required'],
    ['wrong content type', '{}', { 'content-type': 'text/plain' }, 415, 'json_content_type_required'],
  ])('classifies native SDK %s without consuming its response', async (_name, body, headers, status, reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = new Request('https://adport.test/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: 'Bearer private-token', ...headers },
      body,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const response = await transport.handleRequest(request);
    expect(response.status).toBe(status);
    await diagnoseMcpRejection(request, response);
    expect(await response.json()).toHaveProperty('error');
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ event: 'mcp_request_rejected', status, reason, phase: 'transport' });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-value|private-token|secret|Bearer/);
    await transport.close();
  });

  it('never logs arbitrary response text, headers, protocol strings or exception data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = new Request('https://adport.test/mcp?secret=private-value', {
      method: 'POST', headers: { 'mcp-protocol-version': 'private-value', authorization: 'private-value' }, body: 'private-value',
    });
    const response = Response.json({ error: { code: -32700, message: 'private-value', data: 'private-value' } }, { status: 400 });
    await diagnoseMcpRejection(request, response);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ reason: 'unknown', protocol: 'other' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-value');
  });

  it('does not log successful, auth or provider-tool responses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const status of [200, 202, 401, 403, 500]) {
      await diagnoseMcpRejection(new Request('https://adport.test/mcp'), Response.json({ error: 'private-value' }, { status }));
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports in-band discovery errors without logging error messages or successful catalog data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = new Request('https://adport.test/mcp', { headers: { 'mcp-method': 'prompts/list', 'mcp-protocol-version': '2026-07-28' } });
    const response = Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'private-value' } });
    await diagnoseMcpRejection(request, response);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ status: 200, rpcMethod: 'prompts/list', reason: 'method_not_found' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-value');
    expect((await response.json()).error.message).toBe('private-value');
    warn.mockClear();
    await diagnoseMcpRejection(request, Response.json({ result: { tools: [{ description: 'private-value' }] } }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('classifies a native modern SDK SSE resource error while preserving the client response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'diagnostics-test', version: '1' });
      server.registerResource('fixture', 'ui://diagnostics/known', {}, async () => ({ contents: [] }));
      return server;
    }, { responseMode: 'sse' });
    const client = new Client({ name: 'diagnostics-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const contentTypes: Array<string | null> = [];
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('https://adport.test/mcp'), {
        fetch: async (url, init) => {
          const request = new Request(url, init);
          const response = await handler.fetch(request);
          contentTypes.push(response.headers.get('content-type'));
          await diagnoseMcpRejection(request, response);
          return response;
        },
      }));
      await expect(client.readResource({ uri: 'ui://diagnostics/private-value' })).rejects.toThrow();
      expect(contentTypes.at(-1)).toContain('text/event-stream');
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ status: 200, rpcMethod: 'resources/read', rpcCode: -32602, reason: 'invalid_params' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private-value');
    } finally { await client.close(); await handler.close(); }
  });

  it('handles split CRLF SSE frames and notifications without logging private messages', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = [
      ': keepalive\r\n\r\nevent: message\r\ndata: {"method":"notifications/private-value"}\r\n\r',
      '\nevent: message\r\ndata: {"id":"private-value","error":{"code":-32601,"message":"private-value"}}\r\n\r\n',
    ];
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    } });
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    await diagnoseMcpRejection(new Request('https://adport.test/mcp', { headers: { 'mcp-method': 'tools/list' } }), response);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ reason: 'method_not_found' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-value');
    expect(await response.text()).toBe(chunks.join(''));
  });

  it('bounds inspection of oversized catalogs and open SSE streams without consuming the host response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = new Request('https://adport.test/mcp', { headers: { 'mcp-method': 'tools/list' } });
    const large = `data: ${JSON.stringify({ result: { tools: ['private-value'.repeat(6000)] } })}\n\n`;
    const response = new Response(large, { headers: { 'content-type': 'text/event-stream' } });
    await diagnoseMcpRejection(request, response);
    expect(await response.text()).toBe(large);
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const open = new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
    await diagnoseMcpRejection(request, open);
    streamController!.enqueue(new TextEncoder().encode(': still open\n\n'));
    streamController!.close();
    expect(await open.text()).toBe(': still open\n\n');
    expect(warn).not.toHaveBeenCalled();
  });
});
