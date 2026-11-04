import { redirect } from 'next/navigation';
import { BrandLockup } from '@/components/logos';
import { ConsentView } from './consent-view';
import { AuthFrame } from '@/components/ui';
import { getMcpOAuthClient } from '@/lib/cloud/mcp-oauth-repository';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { validateAuthorizationRequest } from '@/lib/mcp-oauth';
import { createClient } from '@/lib/supabase/server';
import { listProjectAccess } from '@/lib/cloud/workspaces';
import { connectedCatalogProviders } from '@/lib/cloud/tool-catalog';

export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AuthorizePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const item = first(value);
    if (item !== undefined) params.set(key, item);
  }
  const clientId = params.get('client_id') ?? '';
  const client = await getMcpOAuthClient(clientId);
  if (!client) return <AuthorizationError message="This MCP client is not registered with Adport." />;
  let authorization;
  try {
    authorization = validateAuthorizationRequest(params, client);
  } catch (error) {
    return <AuthorizationError message={error instanceof Error ? error.message : 'Invalid authorization request.'} />;
  }

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(`/login?return_to=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`);
  const principal = await sessionPrincipal();
  const projects = await listProjectAccess(data.user.id);
  const providers = await connectedCatalogProviders(projects.map(project => project.id));
  const credentialScopes = principal.grantedScopes ?? principal.scopes;
  const grantedScopes = authorization.scopes.filter((scope) => credentialScopes.includes(scope));
  const redirectHost = new URL(authorization.redirectUri).host;

  return (
    <AuthFrame label="Authorize MCP client" wide>
      <ConsentView
        clientName={authorization.clientName}
        redirectHost={redirectHost}
        scopes={grantedScopes}
        projects={projects.map(project => ({ id: project.id, name: project.name, organizationId: project.organizationId, organizationName: project.organizationName, providers: providers[project.id] ?? [] }))}
        defaultProjectId={principal.organizationId}
        hidden={Array.from(params.entries()).filter(([name]) => !['project_id', 'tool_profile', 'tool_platform_mode', 'tool_providers'].includes(name))}
      />
    </AuthFrame>
  );
}

function AuthorizationError({ message }: { message: string }) {
  return (
    <AuthFrame label="authorization error">
      <BrandLockup size="large" />
      <h1>Connection could not start.</h1>
      <div className="error-callout" role="alert">{message}</div>
      <p>Return to your MCP client and try connecting again.</p>
    </AuthFrame>
  );
}
