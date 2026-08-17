import { createMcpServer } from '@adport/mcp';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { apiPrincipal } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';

async function handle(request: Request): Promise<Response> {
  try {
    const principal = await apiPrincipal(request);
    const runtime = await createTenantRuntime(principal);
    const server = createMcpServer({ runtime, name: 'adport-cloud', version: '0.1.0', scopes: principal.scopes });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return await transport.handleRequest(request, {
      authInfo: {
        token: principal.apiKeyId!,
        clientId: principal.apiKeyId!,
        scopes: principal.scopes,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unauthorized';
    return Response.json({ error: message }, { status: 401 });
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
