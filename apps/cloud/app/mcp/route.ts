import { createMcpServer, ADPORT_UI_RESOURCE_DOMAINS } from '@adport/mcp';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { apiPrincipal } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { HttpError } from '@/lib/http';
import { mcpResourceUrl, oauthIssuerUrl, protectedResourceMetadataUrl } from '@/lib/mcp-oauth';
import { getMcpOAuthClient } from '@/lib/cloud/mcp-oauth-repository';
import { mcpUiDomain } from '@/lib/mcp-ui-domain';
import { adWritePlanLimit } from '@/lib/cloud/write-plan-limit';
import { env } from '@/lib/env';
import { routeMcpProjects } from '@/lib/cloud/mcp-projects';
import { diagnoseMcpRejection } from '@/lib/mcp-transport-diagnostics';

async function handle(request: Request): Promise<Response> {
  try {
    const principal = await apiPrincipal(request);
    const tenantRuntime = await createTenantRuntime(principal, { surface: 'mcp' });
    const runtime = principal.oauthTokenId ? routeMcpProjects(tenantRuntime, principal) : tenantRuntime;
    const toolScopes = principal.oauthOrganizationGroupId ? principal.grantedScopes ?? principal.scopes : principal.scopes;
    // Each HTTP request has a fresh server, so initialize/clientInfo cannot
    // identify the host on subsequent resources/read requests.
    const oauthClient = principal.oauthTokenId && principal.clientId
      ? await getMcpOAuthClient(principal.clientId)
      : undefined;
    const writeLimit = principal.oauthOrganizationGroupId ? undefined : await adWritePlanLimit(principal, env().ADPORT_CLOUD_BASE_URL);
    const writePlanDenial = writeLimit
      ? {
          code: 'PLAN_LIMIT',
          message: writeLimit.message,
          data: { planLimit: writeLimit },
        }
      : undefined;
    const server = createMcpServer({
      runtime,
      instructions: principal.oauthTokenId
        ? 'Call projects_list to discover the projects and platforms authorized for this connection. Use project_id on operations to choose the intended project; it is required when multiple projects are available. Each project has its own accounts and policies. New connected platforms are available after their accounts are enabled, without reconnecting the assistant.'
        : undefined,
      name: 'adport-cloud',
      productionOnly: true,
      uiDomain: mcpUiDomain(oauthClient?.redirectUris ?? [], mcpResourceUrl()),
      uiResourceDomains: [...ADPORT_UI_RESOURCE_DOMAINS, new URL(env().NEXT_PUBLIC_SUPABASE_URL).origin],
      version: '0.1.0',
      icons: [{
        src: `${oauthIssuerUrl()}/icon.svg?brand=orange-dot-v2`,
        mimeType: 'image/svg+xml',
        sizes: ['any'],
      }],
      scopes: toolScopes,
      scopeDenials: writePlanDenial ? { 'tools:write': writePlanDenial } : undefined,
      notConnectedMessage: 'This provider is not connected or available in the selected Adport project. Open Connections in the Adport dashboard to connect a supported provider, then Accounts to enable agent access.'
        + (principal.oauthTokenId ? ' Use projects_list to find projects with this provider.' : '')
        + ' Local CLI credentials and demo mode do not connect this cloud workspace.',
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      authInfo: {
        token: principal.apiKeyId ?? principal.oauthTokenId!,
        clientId: principal.clientId ?? principal.apiKeyId!,
        scopes: toolScopes,
      },
    });
    await diagnoseMcpRejection(request, response);
    return response;
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 401;
    const message = error instanceof Error ? error.message : 'Unauthorized';
    const headers = new Headers({ 'cache-control': 'no-store' });
    if (status === 401) {
      headers.set('www-authenticate', `Bearer resource_metadata="${protectedResourceMetadataUrl()}", scope="tools:read tools:write"`);
    }
    const response = Response.json({ error: message }, { status, headers });
    await diagnoseMcpRejection(request, response, 'request_setup');
    return response;
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
