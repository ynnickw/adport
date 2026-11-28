import { PageHeader } from '@/components/ui';
import { redirect } from 'next/navigation';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { env } from '@/lib/env';
import { ConnectAssistantButton } from '@/components/assistant-connect';
import { getAssistantListings } from '@/lib/cloud/assistant-listings';
import { AssistantConnections } from './assistant-connections';
import { DashboardLink as Link } from '@/components/dashboard-navigation';
import { listAssistantGrants } from '@/lib/cloud/assistant-tool-catalog';
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
  if (query.kind === 'key') redirect('/dashboard/developer?' + new URLSearchParams({ kind: 'key', ...(query.connection ? { connection: query.connection } : {}) }));
  const baseUrl = env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '');
  const canManage = canAdminister(tenant);
  const grants = canManage ? await listAssistantGrants(tenant.organizationId, tenant.userId) : [];
  const initialGrants = grants.map(grant => ({ ...grant, createdAt: grant.createdAt.toISOString(), expiresAt: grant.expiresAt.toISOString(), lastUsedAt: grant.lastUsedAt?.toISOString() ?? null }));
  return (
    <main className="page">
      <PageHeader title="AI assistants" action={<ConnectAssistantButton key={tenant.organizationId} baseUrl={baseUrl} projectName={tenant.organizationName} listings={getAssistantListings()} canManageAccounts={canManage} />} />
      {canManage ? <AssistantConnections key={tenant.organizationId} organizationId={tenant.organizationId} currentUserId={tenant.userId} initialGrants={initialGrants} initialCheckedAt={Date.now()}
        requestedConnection={query.kind === 'oauth' && query.connection ? { clientId: query.connection, scope: query.scope } : undefined} /> : <p className="inline-note">Owners and admins manage project connections.</p>}
    </main>
  );
}
