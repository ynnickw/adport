import { createMcpAuthorizationCode, getMcpOAuthClient } from '@/lib/cloud/mcp-oauth-repository';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { oauthError, validateAuthorizationRequest } from '@/lib/mcp-oauth';

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
      const principal = await sessionPrincipal();
      target.searchParams.set('code', await createMcpAuthorizationCode(principal, authorization));
    }
    if (authorization.state) target.searchParams.set('state', authorization.state);
    return Response.redirect(target, 303);
  } catch (error) {
    return oauthError('invalid_request', error instanceof Error ? error.message : 'Invalid authorization request.');
  }
}
