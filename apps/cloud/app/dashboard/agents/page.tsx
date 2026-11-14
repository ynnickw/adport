import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { env } from '@/lib/env';
import { AssistantConnect } from '@/components/assistant-connect';
import { getAssistantListings } from '@/lib/cloud/assistant-listings';
import { ApiKeyManager } from './api-key-manager';
import Link from 'next/link';
import { connectedCatalogProviders } from '@/lib/cloud/tool-catalog';
import { listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { listMcpOAuthGrants } from '@/lib/cloud/mcp-oauth-repository';
import { selectProjectAction } from '../projects/actions';
import { Button } from '@/components/controls';

export const metadata = { title: 'AI assistants' };

export default async function AgentsPage({ searchParams }: { searchParams?: Promise<{ projectId?: string; connection?: string; kind?: string; scope?: string }> } = {}) {
  const [tenant, query] = await Promise.all([requireDashboardTenant(), searchParams ?? Promise.resolve({} as { projectId?: string; connection?: string; kind?: string; scope?: string })]);
  if (query.projectId && query.projectId !== tenant.organizationId) {
    const target = tenant.projects?.find(project => project.id === query.projectId);
    const destination = '/dashboard/agents?' + new URLSearchParams({ ...(query.connection ? { connection: query.connection } : {}), ...(query.kind ? { kind: query.kind } : {}), ...(query.scope ? { scope: query.scope } : {}) }) + '#connected-assistants';
    return <main className="page"><PageHeader title="Manage tool access" showDescription description={target ? `This assistant connection is in ${target.name}. Switch projects to review its tool access.` : 'This connection belongs to a project you cannot access. Ask its owner to review tool access.'} />
      {target ? <form action={selectProjectAction}><input type="hidden" name="projectId" value={target.id} /><input type="hidden" name="return_to" value={destination} /><Button type="submit" className="button">Open {target.name}</Button></form> : <Link className="button secondary" href="/dashboard/agents">View your assistants</Link>}
    </main>;
  }
  const baseUrl = env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '');
  const canManage = canAdminister(tenant);
  const [accounts, grants, providersByProject] = await Promise.all([
    listOrganizationAdAccounts(tenant.organizationId),
    canManage ? listMcpOAuthGrants(tenant.organizationId) : Promise.resolve([]),
    canManage ? connectedCatalogProviders([tenant.organizationId]) : undefined,
  ]);
  const initialGrants = grants.map(grant => ({ ...grant, createdAt: grant.createdAt.toISOString(), expiresAt: grant.expiresAt.toISOString(), lastUsedAt: grant.lastUsedAt?.toISOString() ?? null }));
  const active = accounts.filter(account => account.enabled).length;
  return (
    <main className="page">
      <PageHeader title="AI assistants" description="Connect the AI you use. Ask about performance, find wasted spend, and manage your ads from one conversation." />
      <div className="stack agent-access-stack">
        {!active ? <section className="setup-next-step"><div><strong>{canAdminister(tenant) ? accounts.length ? 'Enable an account first' : 'Add your first ad account' : 'No accounts available yet'}</strong><p>{canAdminister(tenant) ? 'Your assistant can connect now, but it will have no ad accounts to read.' : 'Ask a project owner or admin to enable account access for your assistant.'}</p></div><Link className="button secondary small" href={canAdminister(tenant) && !accounts.length ? '/dashboard/connections' : '/dashboard/accounts'}>{canAdminister(tenant) && !accounts.length ? 'Connect a platform' : 'View accounts'}</Link></section> : null}
        {canManage ? <ApiKeyManager key={tenant.organizationId} organizationId={tenant.organizationId} currentUserId={tenant.userId} suggestedProviders={providersByProject?.[tenant.organizationId] ?? []} canManage baseUrl={baseUrl} initialGrants={initialGrants} initialCheckedAt={Date.now()} setup={<AssistantConnect baseUrl={baseUrl} projectName={tenant.organizationName} listings={getAssistantListings()} />} /> : <><AssistantConnect key={tenant.organizationId} baseUrl={baseUrl} projectName={tenant.organizationName} listings={getAssistantListings()} /><p className="inline-note">An owner or admin can view this project’s authorized assistants and manage API keys.</p></>}
      </div>
    </main>
  );
}
