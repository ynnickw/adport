import { createMcpServer } from '@adport/mcp';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { apiPrincipal } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { HttpError } from '@/lib/http';
import { mcpResourceUrl, oauthIssuerUrl, protectedResourceMetadataUrl } from '@/lib/mcp-oauth';
import { getMcpOAuthClient } from '@/lib/cloud/mcp-oauth-repository';
import { mcpUiDomain } from '@/lib/mcp-ui-domain';
import { adWritePlanLimit } from '@/lib/cloud/write-plan-limit';
import { env } from '@/lib/env';

async function handle(request: Request): Promise<Response> {
  try {
    const principal = await apiPrincipal(request);
    const runtime = await createTenantRuntime(principal, { surface: 'mcp' });
    // Each HTTP request has a fresh server, so initialize/clientInfo cannot
    // identify the host on subsequent resources/read requests.
    const oauthClient = principal.oauthTokenId && principal.clientId
      ? await getMcpOAuthClient(principal.clientId)
      : undefined;
    const writeLimit = await adWritePlanLimit(principal, env().ADPORT_CLOUD_BASE_URL);
    const writePlanDenial = writeLimit
      ? {
          code: 'PLAN_LIMIT',
          message: writeLimit.message,
          data: { planLimit: writeLimit },
        }
      : undefined;
    const server = createMcpServer({
      runtime,
      name: 'adport-cloud',
      productionOnly: true,
      uiDomain: mcpUiDomain(oauthClient?.redirectUris ?? [], mcpResourceUrl()),
      version: '0.1.0',
      icons: [{
        src: `${oauthIssuerUrl()}/icon.svg?brand=orange-dot-v2`,
        mimeType: 'image/svg+xml',
        sizes: ['any'],
      }],
      scopes: principal.scopes,
      scopeDenials: writePlanDenial ? { 'tools:write': writePlanDenial } : undefined,
      notConnectedMessage: 'This provider is not connected or available for this Adport Cloud workspace. Open Connections in the Adport dashboard to connect a supported provider, then Accounts to enable agent access. Local CLI credentials and demo mode do not connect this cloud workspace.',
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return await transport.handleRequest(request, {
      authInfo: {
        token: principal.apiKeyId ?? principal.oauthTokenId!,
        clientId: principal.clientId ?? principal.apiKeyId!,
        scopes: principal.scopes,
      },
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 401;
    const message = error instanceof Error ? error.message : 'Unauthorized';
    const headers = new Headers({ 'cache-control': 'no-store' });
    if (status === 401) {
      headers.set('www-authenticate', `Bearer resource_metadata="${protectedResourceMetadataUrl()}", scope="tools:read tools:write"`);
    }
    return Response.json({ error: message }, { status, headers });
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
