import { ZodError } from 'zod';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { registerMcpOAuthClient } from '@/lib/cloud/mcp-oauth-repository';
import { clientRegistrationSchema, oauthError, validateRedirectUris } from '@/lib/mcp-oauth';

export async function POST(request: Request) {
  try {
    const source = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
    if (!(await enforceRateLimit(`mcp-oauth-register:${source}`, 20))) {
      return oauthError('temporarily_unavailable', 'Client registration rate limit exceeded.', 429);
    }
    const input = clientRegistrationSchema.parse(await request.json());
    const redirectUris = validateRedirectUris(input.redirect_uris);
    const client = await registerMcpOAuthClient({
      clientName: input.client_name,
      clientUri: input.client_uri,
      logoUri: input.logo_uri,
      redirectUris,
      grantTypes: input.grant_types,
      responseTypes: input.response_types,
      tokenEndpointAuthMethod: input.token_endpoint_auth_method,
    });
    return Response.json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.clientName,
      ...(client.clientUri ? { client_uri: client.clientUri } : {}),
      ...(client.logoUri ? { logo_uri: client.logoUri } : {}),
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      ...(input.application_type ? { application_type: input.application_type } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const description = error instanceof ZodError
      ? error.issues.map((issue) => issue.message).join('; ')
      : error instanceof Error ? error.message : 'Invalid client metadata.';
    return oauthError('invalid_client_metadata', description);
  }
}
