import { describe, expect, it, vi } from 'vitest';
import { inspectMcpRequest, isMcpUiResourceRequest } from '@/lib/mcp-ui-request';

const url = 'https://adport.test/mcp';
const body = (extra: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://adport/insight-card-v3.html' }, ...extra });
function request(value: unknown, headers: Record<string, string> = {}) { return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) }); }

describe('bounded static MCP UI request classification', () => {
  it.each(['server/discover', 'tools/list', 'prompts/list'])('identifies legacy %s for rejection diagnostics without granting the static UI path', async method => {
    const input = body({ method, params: {} }), req = request(input);
    expect(await inspectMcpRequest(req)).toEqual({ uiOnly: false, discoveryMethod: method });
    expect(await req.json()).toEqual(input);
  });

  it('keeps unknown resources on the normal server while preserving their method for diagnostics', async () => {
    const req = request(body({ params: { uri: 'ui://private-resource' } }));
    expect(await inspectMcpRequest(req)).toEqual({ uiOnly: false, discoveryMethod: 'resources/read' });
    expect(await req.json()).toEqual(body({ params: { uri: 'ui://private-resource' } }));
  });

  it('does not classify business payloads, notifications, batches or forged method headers as discovery', async () => {
    for (const input of [body({ method: 'tools/call', params: { name: 'resources/read', arguments: { private: 'private-value' } } }), body({ id: null }), [body()]]) {
      expect(await inspectMcpRequest(request(input))).toEqual({ uiOnly: false });
    }
    expect(await inspectMcpRequest(request(body({ method: 'tools/call' }), { 'mcp-method': 'resources/read' }))).toEqual({ uiOnly: false });
    expect(await inspectMcpRequest(request(body(), { 'mcp-method': 'tools/call' }))).toEqual({ uiOnly: false });
  });

  it.each([undefined, 'resources/read'])('recognizes a legacy or modern resource read and preserves its original body (%s)', async method => {
    const input = body(), req = request(input, method ? { 'mcp-method': method } : {});
    expect(await isMcpUiResourceRequest(req)).toBe(true);
    expect(await req.json()).toEqual(input);
  });

  it('recognizes both registered resource URIs, resource listings and template listings', async () => {
    expect(await isMcpUiResourceRequest(request(body({ params: { uri: 'ui://adport/insight-card-v2.html' } })))).toBe(true);
    for (const method of ['resources/list', 'resources/templates/list']) expect(await isMcpUiResourceRequest(request(body({ method, params: {} })))).toBe(true);
  });

  it('never routes business calls, discovery, batches, unknown URIs or forged method headers through the static server', async () => {
    for (const input of [body({ method: 'tools/call' }), body({ method: 'tools/list' }), body({ method: 'server/discover' }), body({ params: { uri: 'ui://provider/private' } }), [body()], { method: 'resources/read', id: 1 }, body({ id: null }), body({ params: { uri: 42 } })]) expect(await isMcpUiResourceRequest(request(input))).toBe(false);
    const req = request(body({ method: 'tools/call', params: { name: 'write', arguments: { method: 'resources/read' } } }), { 'mcp-method': 'resources/read' });
    expect(await isMcpUiResourceRequest(req)).toBe(false); expect((await req.json()).method).toBe('tools/call');
    expect(await isMcpUiResourceRequest(request(body(), { 'mcp-method': 'tools/call' }))).toBe(false);
  });

  it('falls back on malformed JSON, non-JSON and oversized bodies without consuming or logging private payloads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const malformed = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
      expect(await isMcpUiResourceRequest(malformed)).toBe(false); expect(await malformed.text()).toBe('{');
      expect(await isMcpUiResourceRequest(request(body(), { 'content-type': 'text/plain' }))).toBe(false);
      const value = body({ private: 'private-token'.repeat(900) }), large = request(value);
      expect(await isMcpUiResourceRequest(large)).toBe(false); expect(await large.json()).toEqual(value);
      expect(await isMcpUiResourceRequest(request(body(), { 'content-length': '9000' }))).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('bounds waiting for an unfinished request while leaving the original stream usable', async () => {
    let source: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(await isMcpUiResourceRequest(req)).toBe(false);
    source!.enqueue(new TextEncoder().encode(JSON.stringify(body()))); source!.close();
    expect(await req.json()).toEqual(body());
  });
});
