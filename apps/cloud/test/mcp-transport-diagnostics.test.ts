import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { diagnoseMcpRejection } from '@/lib/mcp-transport-diagnostics';

afterEach(() => vi.restoreAllMocks());

describe('MCP transport rejection diagnostics', () => {
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
});
