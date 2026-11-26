import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentsPage from '@/app/dashboard/agents/page';
import { AssistantConnections } from '@/app/dashboard/agents/assistant-connections';
import DeveloperPage from '@/app/dashboard/developer/page';

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), grants: vi.fn(), connected: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: mocks.tenant, canAdminister: (tenant: { role: string }) => ['owner', 'admin'].includes(tenant.role) }));
vi.mock('@/lib/cloud/repository', () => ({ listOrganizationAdAccounts: async () => [{ enabled: true, provider: 'meta' }] }));
vi.mock('@/lib/cloud/mcp-oauth-repository', () => ({ listMcpOAuthGrants: mocks.grants }));
vi.mock('@/lib/cloud/tool-catalog', () => ({ connectedCatalogProviders: mocks.connected }));

const grant = { clientId: 'client', userId: 'user', clientName: 'Codex', clientUri: null, scopes: ['tools:read'], resource: 'https://app.adport.test/mcp', createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000), lastUsedAt: new Date(), status: 'active' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockResolvedValue({ organizationId: 'project', organizationName: 'Acme', userId: 'user', role: 'owner' });
  mocks.grants.mockResolvedValue([grant]);
  mocks.connected.mockResolvedValue({ project: ['google', 'meta'] });
});

afterEach(() => vi.restoreAllMocks());

describe('project assistant access', () => {
  it('uses the server snapshot time for stable hydration across a minute boundary', () => {
    const now = Date.now();
    const initialGrants = [{ ...grant, createdAt: grant.createdAt.toISOString(), expiresAt: grant.expiresAt.toISOString(), lastUsedAt: new Date(now - 44000).toISOString(), status: 'active' as const }];
    const render = () => renderToStaticMarkup(<AssistantConnections organizationId="project" currentUserId="user" initialGrants={initialGrants} initialCheckedAt={now} />);
    const serverHtml = render();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
    expect(render()).toBe(serverHtml);
  });
  it('puts an existing connection first and shows actual use metadata', async () => {
    const html = renderToStaticMarkup(await AgentsPage());
    expect(mocks.grants).toHaveBeenCalledWith('project');
    expect(mocks.connected).not.toHaveBeenCalled();
    expect(html).toContain('This project');
    expect(html).toContain('Read only');
    expect(html).toContain('Developer settings');
    expect(html).not.toContain('<h2>AI assistant</h2>');
    expect(html).toContain('In use');
    expect(html).toContain('Last used');
  });

  it('does not describe an unused authorization as a working connection', async () => {
    mocks.grants.mockResolvedValue([{ ...grant, lastUsedAt: null }]);
    const html = renderToStaticMarkup(await AgentsPage());
    expect(html).toContain('Waiting for first read');
    expect(html).not.toContain('In use');
  });

  it('offers one setup action when no assistant has been authorized', async () => {
    mocks.grants.mockResolvedValue([]);
    const html = renderToStaticMarkup(await AgentsPage());
    expect(html).toContain('>Connect assistant</button>');
    expect(html).toContain('No assistant connected yet');
  });

  it.each(['member', 'viewer'])('does not query or expose project credential metadata to a %s', async role => {
    mocks.tenant.mockResolvedValue({ organizationId: 'project', organizationName: 'Acme', role });
    const html = renderToStaticMarkup(await AgentsPage());
    expect(mocks.grants).not.toHaveBeenCalled();
    expect(mocks.connected).not.toHaveBeenCalled();
    expect(html).toContain('>Connect assistant</button>');
    expect(html).not.toContain('Refresh status');
    expect(html).not.toContain('Create key');
    expect(html).not.toContain('Connected assistants');
    const developer = renderToStaticMarkup(await DeveloperPage());
    expect(developer).toContain('Only project owners and admins');
    expect(developer).not.toContain('Create API key');
    expect(mocks.connected).not.toHaveBeenCalled();
  });

  it('keeps a settings link in the intended project and preserves its target connection when switching', async () => {
    mocks.tenant.mockResolvedValue({ organizationId: 'other-project', role: 'owner', projects: [{ id: 'project', name: 'Client project' }] });
    const html = renderToStaticMarkup(await AgentsPage({ searchParams: Promise.resolve({ projectId: 'project', connection: 'client', kind: 'oauth' }) }));
    expect(html).toContain('Open Client project');
    expect(html).toContain('connection=client&amp;kind=oauth#connected-assistants');
    expect(mocks.grants).not.toHaveBeenCalled();
  });

  it('does not expose a target project’s grants when a settings link is unauthorized', async () => {
    mocks.tenant.mockResolvedValue({ organizationId: 'other-project', role: 'owner', projects: [] });
    const html = renderToStaticMarkup(await AgentsPage({ searchParams: Promise.resolve({ projectId: 'project' }) }));
    expect(html).toContain('project you cannot access');
    expect(mocks.grants).not.toHaveBeenCalled();
  });
});
