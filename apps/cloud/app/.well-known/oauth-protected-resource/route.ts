import { mcpResourceUrl, oauthIssuerUrl } from '@/lib/mcp-oauth';

export async function GET() {
  return Response.json({
    resource: mcpResourceUrl(),
    authorization_servers: [oauthIssuerUrl()],
    scopes_supported: ['tools:read', 'tools:write'],
    bearer_methods_supported: ['header'],
    resource_name: 'Adport hosted MCP',
    resource_documentation: 'https://adport.dev',
  }, { headers: { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' } });
}
