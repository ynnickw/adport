import { PageHeader } from '@/components/ui';
import { redirect } from 'next/navigation';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { env } from '@/lib/env';
import { ConnectAssistantButton } from '@/components/assistant-connect';
import { getAssistantListings } from '@/lib/cloud/assistant-listings';
import { AssistantConnections } from './assistant-connections';
import Link from 'next/link';
import { listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { listMcpOAuthGrants } from '@/lib/cloud/mcp-oauth-repository';
import { selectProjectAction } from '../projects/actions';
import { Button } from '@/components/controls';
import { usesAdAccountSlot } from '@/lib/cloud/providers';

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
  if (query.kind === 'key') redirect('/dashboard/developer?' + new URLSearchParams({ kind: 'key', ...(query.connection ? { connection: query.connection } : {}) }));
  const baseUrl = env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '');
  const canManage = canAdminister(tenant);
  const [accounts, grants] = await Promise.all([
    listOrganizationAdAccounts(tenant.organizationId),
    canManage ? listMcpOAuthGrants(tenant.organizationId) : Promise.resolve([]),
  ]);
  const initialGrants = grants.map(grant => ({ ...grant, createdAt: grant.createdAt.toISOString(), expiresAt: grant.expiresAt.toISOString(), lastUsedAt: grant.lastUsedAt?.toISOString() ?? null }));
  const adAccounts = accounts.filter(account => usesAdAccountSlot(account.provider));
  const active = adAccounts.filter(account => account.enabled).length;
  return (
    <main className="page">
      <PageHeader title="AI assistants" action={<ConnectAssistantButton key={tenant.organizationId} baseUrl={baseUrl} projectName={tenant.organizationName} listings={getAssistantListings()} canManage={canManage} />} />
      <div className="stack agent-access-stack">
        {canManage ? <AssistantConnections key={tenant.organizationId} organizationId={tenant.organizationId} currentUserId={tenant.userId} initialGrants={initialGrants} initialCheckedAt={Date.now()} /> : <p className="inline-note">You can connect an assistant. Owners and admins manage project connections.</p>}
        <div className="assistant-access-summary"><Link href="/dashboard/accounts">{active ? `View ad account access (${active} enabled)` : canManage && !adAccounts.length ? 'Add accounts' : 'No enabled ad accounts'}</Link>
          <span>Changes require approval and account permission. <Link href="/dashboard/policies">View safeguards</Link></span>
          {canManage ? <Link href="/dashboard/developer">Developer settings</Link> : null}
        </div>
      </div>
    </main>
  );
}
