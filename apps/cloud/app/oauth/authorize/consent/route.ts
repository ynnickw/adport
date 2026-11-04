import { createMcpAuthorizationCode, getMcpOAuthClient } from '@/lib/cloud/mcp-oauth-repository';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { oauthError, validateAuthorizationRequest } from '@/lib/mcp-oauth';
import { z } from 'zod';
import { listProjectAccess } from '@/lib/cloud/workspaces';
import { saveToolSelection } from '@/lib/cloud/tool-catalog';
import { toolSelectionFromForm } from '@/lib/mcp-tool-selection';

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const params = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      if (key !== 'decision' && typeof value === 'string') params.set(key, value);
    }
    const client = await getMcpOAuthClient(params.get('client_id') ?? '');
    if (!client) return oauthError('invalid_client', 'Unknown client_id.', 401);
    const authorization = validateAuthorizationRequest(params, client);
    const target = new URL(authorization.redirectUri);
    if (form.get('decision') !== 'allow') {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'The resource owner denied the request.');
    } else {
      const selection = toolSelectionFromForm(form);
      const projectId = form.get('project_id');
      if (typeof projectId === 'string' && projectId.startsWith('all:')) {
        const organizationId = z.string().uuid().parse(projectId.slice(4));
        const session = await sessionPrincipal();
        const projects = await listProjectAccess(session.userId!);
        const project = projects.find(project => project.organizationId === organizationId);
        if (!project) throw new Error('You do not have access to this organization.');
        const principal = await sessionPrincipal(project.id);
        const code = await createMcpAuthorizationCode(principal, authorization, organizationId);
        await saveToolSelection({ ...principal, clientId: authorization.clientId, resource: authorization.resource, oauthOrganizationGroupId: organizationId }, selection);
        target.searchParams.set('code', code);
      } else {
        const principal = await sessionPrincipal(projectId ? z.string().uuid().parse(projectId) : undefined);
        const code = await createMcpAuthorizationCode(principal, authorization);
        await saveToolSelection({ ...principal, clientId: authorization.clientId, resource: authorization.resource }, selection);
        target.searchParams.set('code', code);
      }
    }
    if (authorization.state) target.searchParams.set('state', authorization.state);
    return Response.redirect(target, 303);
  } catch (error) {
    return oauthError('invalid_request', error instanceof Error ? error.message : 'Invalid authorization request.');
  }
}
