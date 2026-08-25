import { oauthIssuerUrl } from '@/lib/mcp-oauth';

export async function GET() {
  const issuer = oauthIssuerUrl();
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: ['tools:read', 'tools:write'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: 'https://adport.dev',
  }, { headers: { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' } });
}
