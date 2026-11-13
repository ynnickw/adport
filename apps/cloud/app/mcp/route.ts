import { createMcpServer, createMcpUiServer, ADPORT_UI_RESOURCE_DOMAINS } from '@adport/mcp';
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
import { mcpPostOnlyResponse, serveMcpHttp } from '@/lib/mcp-http';

async function handle(request: Request): Promise<Response> {
  let discoveryMethod: McpDiscoveryMethod | undefined;
  try {
    const principal = await apiPrincipal(request);
    if (request.method !== 'POST') return mcpPostOnlyResponse();
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
          ? `Call projects_list to discover authorized projects and platforms. Use project_id on operations; it is required with multiple projects. Each project has its own accounts and policies. This connection uses the ${catalog.profile} tool profile. Before saying a workflow is unsupported or a needed tool is missing, call capabilities_list with relevant keywords and project_id. It discovers hidden tools, explains access requirements and returns a direct Manage tool access link. After saving, refresh the assistant’s tool list or reconnect if it stays unchanged. Access changes never run the requested operation automatically.`
          : `This connection uses the ${catalog.profile} tool profile. If a needed tool is missing, call capabilities_list before claiming the workflow is unsupported. It returns supported workflows, enablement steps and a Manage tool access link. Refresh the assistant’s tool list after access changes.`,
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
    const response = await serveMcpHttp(server, request, requestOptions);
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
