import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { env } from '@/lib/env';
import { AssistantConnect } from '@/components/assistant-connect';
import { getAssistantListings } from '@/lib/cloud/assistant-listings';
import { ApiKeyManager } from './api-key-manager';
import Link from 'next/link';
import type { ToolProvider } from '@adport/core';
import { listOrganizationAdAccounts } from '@/lib/cloud/repository';
import { listMcpOAuthGrants } from '@/lib/cloud/mcp-oauth-repository';

export const metadata = { title: 'AI assistants' };

export default async function AgentsPage() {
  const tenant = await requireDashboardTenant();
  const baseUrl = env().ADPORT_CLOUD_BASE_URL.replace(/\/$/, '');
  const canManage = canAdminister(tenant);
  const [accounts, grants] = await Promise.all([
    listOrganizationAdAccounts(tenant.organizationId),
    canManage ? listMcpOAuthGrants(tenant.organizationId) : Promise.resolve([]),
  ]);
  const initialGrants = grants.map(grant => ({ ...grant, createdAt: grant.createdAt.toISOString(), expiresAt: grant.expiresAt.toISOString(), lastUsedAt: grant.lastUsedAt?.toISOString() ?? null }));
  const active = accounts.filter(account => account.enabled).length;
  return (
    <main className="page">
      <PageHeader title="AI assistants" description="Connect the AI you use. Ask about performance, find wasted spend, and manage your ads from one conversation." />
      <div className="stack agent-access-stack">
        {!active ? <section className="setup-next-step"><div><strong>{canAdminister(tenant) ? accounts.length ? 'Enable an account first' : 'Add your first ad account' : 'No accounts available yet'}</strong><p>{canAdminister(tenant) ? 'Your assistant can connect now, but it will have no ad accounts to read.' : 'Ask a project owner or admin to enable account access for your assistant.'}</p></div><Link className="button secondary small" href={canAdminister(tenant) && !accounts.length ? '/dashboard/connections' : '/dashboard/accounts'}>{canAdminister(tenant) && !accounts.length ? 'Connect a platform' : 'View accounts'}</Link></section> : null}
        {canManage ? <ApiKeyManager key={tenant.organizationId} organizationId={tenant.organizationId} currentUserId={tenant.userId} suggestedProviders={[...new Set(accounts.filter(account => account.enabled).map(account => account.provider))] as ToolProvider[]} canManage baseUrl={baseUrl} initialGrants={initialGrants} initialCheckedAt={Date.now()} setup={<AssistantConnect baseUrl={baseUrl} projectName={tenant.organizationName} listings={getAssistantListings()} />} /> : <><AssistantConnect key={tenant.organizationId} baseUrl={baseUrl} projectName={tenant.organizationName} listings={getAssistantListings()} /><p className="inline-note">An owner or admin can view this project’s authorized assistants and manage API keys.</p></>}
      </div>
    </main>
  );
}
