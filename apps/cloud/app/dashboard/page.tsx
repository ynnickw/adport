import { redirect } from 'next/navigation';
import { policySchema } from '@adport/core';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { listOrganizationMembers } from '@/lib/cloud/tenant-admin';
import { ApiKeyManager } from './api-key-manager';
import { DisconnectGoogle } from './connection-actions';
import { LiveData } from './live-data';
import { ProviderConnections } from './provider-connections';
import { signOut } from './actions';
import { TeamSettings } from './team-settings';
import { DangerZone } from './danger-zone';

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect('/login');
  const { data: memberships } = await supabase.from('organization_memberships').select('organization_id, role').limit(1);
  const membership = memberships?.[0];
  if (!membership) throw new Error('No organization membership found.');
  const [{ data: organizations }, { data: connections }, members, settings, params] = await Promise.all([
    supabase.from('organizations').select('id, name, slug').eq('id', membership.organization_id).limit(1),
    supabase.from('connections').select('id, provider, status, external_label, last_error, connected_at').eq('organization_id', membership.organization_id),
    listOrganizationMembers(membership.organization_id),
    db()<Array<{ policy: unknown; dataRetentionDays: number }>>`
      select policy, data_retention_days from public.organization_settings
      where organization_id = ${membership.organization_id}
    `,
    searchParams,
  ]);
  const organization = organizations?.[0];
  const google = connections?.find((connection) => connection.provider === 'google');
  return (
    <main className="shell dashboard">
      <div className="dashboard-header"><div><p className="muted">{organization?.name}</p><h1>Control center</h1></div><form action={signOut}><button className="button secondary">Sign out</button></form></div>
      {params.connected ? <p className="success">Google Ads connected successfully.</p> : null}
      {params.error ? <p className="error">{params.error}</p> : null}
      <div className="grid">
        <section className="card">
          <div className="card-header"><div><h2>Google Ads</h2><span className="muted">Single Google Ads OAuth scope · encrypted token vault</span></div>{google ? <span className={`status ${google.status === 'error' ? 'error' : ''}`}>{google.status}</span> : null}</div>
          <p className="muted small">Access account structure and performance, then preview and apply user-approved Google Ads changes. Adport requests only the Google Ads scope. <a href="https://adport.dev/privacy">Data handling details</a>.</p>
          {google ? <div className="actions"><span>{google.external_label}</span><DisconnectGoogle organizationId={membership.organization_id} />{google.status === 'error' ? <a className="button secondary" href={`/api/oauth/google/start?organization_id=${membership.organization_id}`}>Reconnect</a> : null}</div> : <a className="button" href={`/api/oauth/google/start?organization_id=${membership.organization_id}`}>Connect Google Ads</a>}
        </section>
        <ProviderConnections organizationId={membership.organization_id} connections={(connections ?? []).map((connection) => ({
          provider: connection.provider,
          status: connection.status,
          externalLabel: connection.external_label,
          lastError: connection.last_error,
        }))} />
        <TeamSettings
          organizationId={membership.organization_id}
          currentUserId={auth.user.id}
          currentRole={membership.role}
          members={members}
          policy={policySchema.parse(settings[0]?.policy ?? {})}
          dataRetentionDays={settings[0]?.dataRetentionDays ?? 90}
        />
        {membership.role === 'owner' ? <DangerZone organizationId={membership.organization_id} /> : null}
        <ApiKeyManager organizationId={membership.organization_id} />
        <section className="card full"><h2>Remote MCP endpoint</h2><p className="muted">Configure your AI client with this URL and an Adport API key.</p><div className="code">{`${process.env.ADPORT_CLOUD_BASE_URL ?? 'http://localhost:3000'}/mcp`}</div></section>
        <LiveData organizationId={membership.organization_id} connected={Boolean(connections?.some((connection) => connection.status === 'connected'))} />
      </div>
    </main>
  );
}
