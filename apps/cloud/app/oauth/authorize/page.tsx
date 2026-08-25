import { redirect } from 'next/navigation';
import { BrandLockup } from '@/components/logos';
import { AuthFrame } from '@/components/ui';
import { getMcpOAuthClient } from '@/lib/cloud/mcp-oauth-repository';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { db } from '@/lib/db';
import { validateAuthorizationRequest } from '@/lib/mcp-oauth';
import { createClient } from '@/lib/supabase/server';

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
  const organization = await db()<Array<{ name: string }>>`
    select name from public.organizations where id = ${principal.organizationId} limit 1
  `;
  const redirectHost = new URL(authorization.redirectUri).host;

  return (
    <AuthFrame label="authorize MCP client">
      <BrandLockup size="large" />
      <h1>Connect {authorization.clientName}.</h1>
      <p>
        This gives <strong>{authorization.clientName}</strong> access to the Adport workspace
        {' '}<strong>{organization[0]?.name ?? 'Workspace'}</strong>. Tokens work only with Adport&apos;s hosted MCP.
      </p>
      <div className="callout">
        Return destination: <strong>{redirectHost}</strong>. Only continue if you started this connection there.
      </div>
      <dl className="connection-meta oauth-consent-scopes">
        {authorization.scopes.includes('tools:read') ? <><dt>Read</dt><dd>Ad accounts, campaigns, reports, findings, and audit evidence.</dd></> : null}
        {authorization.scopes.includes('tools:write') ? <><dt>Propose changes</dt><dd>Create previews and apply only operations that pass Adport&apos;s two-step policy gate.</dd></> : null}
      </dl>
      <form className="form" method="post" action="/oauth/authorize/consent">
        {Array.from(params.entries()).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <div className="form-actions">
          <button className="button" type="submit" name="decision" value="allow">Authorize</button>
          <button className="button secondary" type="submit" name="decision" value="deny">Cancel</button>
        </div>
      </form>
      <p className="auth-switch">You can revoke the connection from your MCP client at any time.</p>
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
