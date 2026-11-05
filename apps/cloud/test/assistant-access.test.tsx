import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentsPage from '@/app/dashboard/agents/page';
import { ApiKeyManager } from '@/app/dashboard/agents/api-key-manager';

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), grants: vi.fn() }));
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: mocks.tenant, canAdminister: (tenant: { role: string }) => ['owner', 'admin'].includes(tenant.role) }));
vi.mock('@/lib/cloud/repository', () => ({ listOrganizationAdAccounts: async () => [{ enabled: true, provider: 'meta' }] }));
vi.mock('@/lib/cloud/mcp-oauth-repository', () => ({ listMcpOAuthGrants: mocks.grants }));

const grant = { clientId: 'client', userId: 'user', clientName: 'Codex', clientUri: null, scopes: ['tools:read'], resource: 'https://app.adport.test/mcp', createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000), lastUsedAt: new Date(), status: 'active' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockResolvedValue({ organizationId: 'project', organizationName: 'Acme', role: 'owner' });
  mocks.grants.mockResolvedValue([grant]);
});

afterEach(() => vi.restoreAllMocks());

describe('project assistant access', () => {
  it('uses the server snapshot time for stable hydration across a minute boundary', () => {
    const now = Date.now();
    const initialGrants = [{ ...grant, createdAt: grant.createdAt.toISOString(), expiresAt: grant.expiresAt.toISOString(), lastUsedAt: new Date(now - 44000).toISOString(), status: 'active' as const }];
    const render = () => renderToStaticMarkup(<ApiKeyManager organizationId="project" canManage baseUrl="https://app.adport.test" initialGrants={initialGrants} initialCheckedAt={now} setup={null} />);
    const serverHtml = render();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
    expect(render()).toBe(serverHtml);
  });
  it('puts an existing connection first and shows actual use metadata', async () => {
    const html = renderToStaticMarkup(await AgentsPage());
    expect(mocks.grants).toHaveBeenCalledWith('project');
    expect(html.indexOf('Connected assistants')).toBeLessThan(html.indexOf('<h2>AI assistant</h2>'));
    expect(html).toContain('In use');
    expect(html).toContain('Last reached Adport');
  });

  it('does not describe an unused authorization as a working connection', async () => {
    mocks.grants.mockResolvedValue([{ ...grant, lastUsedAt: null }]);
    const html = renderToStaticMarkup(await AgentsPage());
    expect(html).toContain('Authorized, waiting for its first request.');
    expect(html).not.toContain('In use');
  });

  it('starts with setup when no assistant has been authorized', async () => {
    mocks.grants.mockResolvedValue([]);
    const html = renderToStaticMarkup(await AgentsPage());
    expect(html.indexOf('<h2>AI assistant</h2>')).toBeLessThan(html.indexOf('Connected assistants'));
    expect(html).toContain('No assistant connected yet');
  });

  it.each(['member', 'viewer'])('does not query or expose project credential metadata to a %s', async role => {
    mocks.tenant.mockResolvedValue({ organizationId: 'project', organizationName: 'Acme', role });
    const html = renderToStaticMarkup(await AgentsPage());
    expect(mocks.grants).not.toHaveBeenCalled();
    expect(html).toContain('<h2>AI assistant</h2>');
    expect(html).not.toContain('Refresh status');
    expect(html).not.toContain('Create key');
    expect(html).not.toContain('Connected assistants');
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
