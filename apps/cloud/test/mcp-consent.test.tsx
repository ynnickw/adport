import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentView } from '@/app/oauth/authorize/consent-view';
import { mcpResourceUrl } from '@/lib/mcp-oauth';

const mocks = vi.hoisted(() => ({ session: vi.fn(), projects: vi.fn(), client: vi.fn(), code: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/workspaces', () => ({ listProjectAccess: mocks.projects }));
vi.mock('@/lib/cloud/mcp-oauth-repository', () => ({ getMcpOAuthClient: mocks.client, createMcpAuthorizationCode: mocks.code }));
vi.mock('@/lib/cloud/tool-catalog', () => ({ saveToolSelection: vi.fn() }));
import { POST } from '@/app/oauth/authorize/consent/route';

const company = '11111111-1111-4111-8111-111111111111';
const project = '22222222-2222-4222-8222-222222222222';
const principal = { organizationId: project, userId: 'user', scopes: ['tools:read'] };
const redirectUri = 'http://127.0.0.1:45897/callback';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue(principal);
  mocks.projects.mockResolvedValue([{ id: project, name: 'Client', organizationId: company, organizationName: 'Company' }]);
  mocks.client.mockResolvedValue({ clientId: 'client', clientName: 'Claude', redirectUris: [redirectUri] });
  mocks.code.mockResolvedValue('test-authorization-code');
});

async function consent(projectId: string, decision = 'allow') {
  return POST(new Request('http://localhost/oauth/authorize/consent', { method: 'POST', body: new URLSearchParams({
    client_id: 'client', response_type: 'code', redirect_uri: redirectUri, scope: 'tools:read', resource: mcpResourceUrl(),
    code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 'preserved-state', project_id: projectId, decision,
  }) }));
}

describe('project consent', () => {
  it('defaults to All projects in the current organization and explains its scope', () => {
    const html = renderToStaticMarkup(<ConsentView clientName="Claude" redirectHost="claude.ai" scopes={['tools:read']} projects={[
      { id: 'other-project', name: 'Other client', organizationId: 'other-company', organizationName: 'Other company' },
      { id: project, name: 'Client', organizationId: company, organizationName: 'Company' },
    ]} defaultProjectId={project} hidden={[]} />);
    expect(html).toContain(`name="project_id" value="all:${company}"`);
    expect(html).toContain('All projects includes current and future projects you can access in that organization.');
  });

  it('passes explicit organization consent to the issuer and preserves OAuth state', async () => {
    const response = await consent(`all:${company}`);
    expect(response.status).toBe(303);
    expect(mocks.code).toHaveBeenCalledWith(principal, expect.objectContaining({ clientId: 'client' }), company);
    expect(new URL(response.headers.get('location')!).searchParams.get('state')).toBe('preserved-state');
  });

  it('rejects an organization that is absent from current project access', async () => {
    mocks.projects.mockResolvedValue([]);
    expect((await consent(`all:${company}`)).status).toBe(400);
    expect(mocks.code).not.toHaveBeenCalled();
  });

  it('preserves single-project consent and does not issue a grant on cancellation', async () => {
    expect((await consent(project)).status).toBe(303);
    expect(mocks.code).toHaveBeenCalledWith(principal, expect.any(Object));
    mocks.code.mockClear();
    const canceled = await consent(`all:${company}`, 'deny');
    expect(new URL(canceled.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(mocks.code).not.toHaveBeenCalled();
  });
});
