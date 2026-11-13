import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport, type McpServer } from '@modelcontextprotocol/server';

type RequestOptions = Parameters<WebStandardStreamableHTTPServerTransport['handleRequest']>[1];

export function mcpPostOnlyResponse(): Response {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'This stateless MCP endpoint accepts POST requests.' } }, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
}

/** One authenticated request owns one server; no cross-request update publisher exists. */
export async function serveMcpHttp(server: McpServer, request: Request, options?: RequestOptions): Promise<Response> {
  const capabilities = server.server.getCapabilities();
  server.server.registerCapabilities({
    ...(capabilities.tools ? { tools: { listChanged: false } } : {}),
    ...(capabilities.resources ? { resources: { listChanged: false, subscribe: false } } : {}),
    ...(capabilities.prompts ? { prompts: { listChanged: false } } : {}),
  });
  if (await isLegacyRequest(request)) {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, options);
    } finally {
      // JSON has its terminal result before handleRequest resolves. Cleanup must
      // not turn an already-applied operation into a new transport/auth failure.
      await server.close().catch(() => console.error(JSON.stringify({ event: 'mcp_http_cleanup_failed', era: 'legacy' })));
    }
  }
  // Keep the SDK's per-request progress streaming and modern validation. It
  // closes ordinary modern exchanges after their terminal response.
  return createMcpHandler(() => server, { legacy: 'reject' }).fetch(request, options);
}
