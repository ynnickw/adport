import { createMcpServer, createMcpUiServer, ADPORT_UI_RESOURCE_DOMAINS } from '@adport/mcp';
import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { apiPrincipal } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { HttpError } from '@/lib/http';
import { oauthIssuerUrl, protectedResourceMetadataUrl } from '@/lib/mcp-oauth';
import { getMcpOAuthClient } from '@/lib/cloud/mcp-oauth-repository';
import { mcpUiDomain } from '@/lib/mcp-ui-domain';
import { adWritePlanLimit } from '@/lib/cloud/write-plan-limit';
import { env } from '@/lib/env';
import { routeMcpProjects } from '@/lib/cloud/mcp-projects';
import { principalToolSelection } from '@/lib/cloud/tool-catalog';
import { diagnoseMcpRejection, recordMcpUiResponse } from '@/lib/mcp-transport-diagnostics';
import { inspectMcpRequest, type McpDiscoveryMethod } from '@/lib/mcp-ui-request';

async function handle(request: Request): Promise<Response> {
  let discoveryMethod: McpDiscoveryMethod | undefined;
  try {
    const principal = await apiPrincipal(request);
    const toolScopes = principal.oauthOrganizationGroupId ? principal.grantedScopes ?? principal.scopes : principal.scopes;
    // Each HTTP request has a fresh server, so initialize/clientInfo cannot
    // identify the host on subsequent resources/read requests.
    const oauthClient = principal.oauthTokenId && principal.clientId
      ? await getMcpOAuthClient(principal.clientId)
      : undefined;
    const requestShape = await inspectMcpRequest(request);
    const uiOnly = requestShape.uiOnly;
    discoveryMethod = requestShape.discoveryMethod;
    const writeLimit = uiOnly || principal.oauthOrganizationGroupId ? undefined : await adWritePlanLimit(principal, env().ADPORT_CLOUD_BASE_URL);
    const writePlanDenial = writeLimit
      ? {
          code: 'PLAN_LIMIT',
          message: writeLimit.message,
          data: { planLimit: writeLimit },
        }
      : undefined;
    const uiOptions = {
      name: 'adport-cloud',
      uiDomain: mcpUiDomain(oauthClient?.redirectUris ?? []),
      uiResourceDomains: [...ADPORT_UI_RESOURCE_DOMAINS, new URL(env().NEXT_PUBLIC_SUPABASE_URL).origin],
      uiConnectDomains: [new URL(env().NEXT_PUBLIC_SUPABASE_URL).origin],
      version: '0.1.0',
      icons: [{
        src: `${oauthIssuerUrl()}/icon.svg?brand=orange-dot-v2`,
        mimeType: 'image/svg+xml',
        sizes: ['any'],
      }],
    };
    let server: ReturnType<typeof createMcpServer>;
    if (uiOnly) server = createMcpUiServer(uiOptions);
    else {
      const catalog = await principalToolSelection(principal);
      const tenantRuntime = await createTenantRuntime(principal, { surface: 'mcp', catalog });
      const runtime = principal.oauthTokenId ? routeMcpProjects(tenantRuntime, principal, catalog) : tenantRuntime;
      server = createMcpServer({
        ...uiOptions,
        runtime,
        instructions: principal.oauthTokenId
          ? `Call projects_list to discover the projects and platforms authorized for this connection. Use project_id on operations to choose the intended project; it is required when multiple projects are available. Each project has its own accounts and policies. This connection uses the ${catalog.profile} tool profile. Tool access and platforms can be changed on Adport's AI assistants page; refresh the assistant's tool list after changing them.`
          : undefined,
        productionOnly: true,
        scopes: toolScopes,
        scopeDenials: writePlanDenial ? { 'tools:write': writePlanDenial } : undefined,
        notConnectedMessage: 'This provider is not connected or available in the selected Adport project. Open Connections in the Adport dashboard to connect a supported provider, then Accounts to enable agent access.'
          + (principal.oauthTokenId ? ' Use projects_list to find projects with this provider.' : '')
          + ' Local CLI credentials and demo mode do not connect this cloud workspace.',
      });
    }
    const requestOptions = {
      authInfo: {
        token: principal.apiKeyId ?? principal.oauthTokenId!,
        clientId: principal.clientId ?? principal.apiKeyId!,
        scopes: toolScopes,
      },
    };
    let response: Response;
    // Preserve existing JSON responses for legacy clients. The SDK classifier
    // routes modern envelopes to its modern entry, including malformed claims.
    if (await isLegacyRequest(request)) {
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      response = await transport.handleRequest(request, requestOptions);
    } else {
      const handler = createMcpHandler(() => server, { legacy: 'reject' });
      response = await handler.fetch(request, requestOptions);
    }
    await diagnoseMcpRejection(request, response, 'transport', discoveryMethod);
    if (uiOnly) recordMcpUiResponse(discoveryMethod, response.status);
    return response;
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 401;
    const message = error instanceof Error ? error.message : 'Unauthorized';
    const headers = new Headers({ 'cache-control': 'no-store' });
    if (status === 401) {
      headers.set('www-authenticate', `Bearer resource_metadata="${protectedResourceMetadataUrl()}", scope="tools:read tools:write"`);
    }
    const response = Response.json({ error: message }, { status, headers });
    await diagnoseMcpRejection(request, response, 'request_setup', discoveryMethod);
    return response;
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
