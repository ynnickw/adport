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
const otherCompany = '33333333-3333-4333-8333-333333333333';
const principal = { organizationId: project, userId: 'user', scopes: ['tools:read'] };
const redirectUri = 'http://127.0.0.1:45897/callback';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue(principal);
  mocks.projects.mockResolvedValue([{ id: project, name: 'Client', organizationId: company, organizationName: 'Company' }]);
  mocks.client.mockResolvedValue({ clientId: 'client', clientName: 'Claude', redirectUris: [redirectUri] });
  mocks.code.mockResolvedValue('test-authorization-code');
});

async function consent(projectId: string, decision = 'allow', organizationIds?: string[], origin = 'http://localhost') {
  const form = new URLSearchParams({
    client_id: 'client', response_type: 'code', redirect_uri: redirectUri, scope: 'tools:read', resource: mcpResourceUrl(),
    code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 'preserved-state', project_id: projectId, decision,
  });
  if (organizationIds) {
    form.set('access_scope', 'organizations');
    for (const id of organizationIds) form.append('organization_ids', id);
  }
  return POST(new Request('http://localhost/oauth/authorize/consent', { method: 'POST', headers: { origin }, body: form }));
}

describe('project consent', () => {
  it('preselects only the current organization and offers inline help', () => {
    const html = renderToStaticMarkup(<ConsentView clientName="Claude" redirectHost="claude.ai" scopes={['tools:read']} projects={[
      { id: 'other-project', name: 'Other client', organizationId: otherCompany, organizationName: 'Other company' },
      { id: project, name: 'Client', organizationId: company, organizationName: 'Company' },
    ]} defaultProjectId={project} hidden={[]} />);
    const choices = html.match(/<input[^>]+name="organization_ids"[^>]*>/g) ?? [];
    expect(choices).toHaveLength(2);
    expect(choices.find(choice => choice.includes(company))).toContain('checked=""');
    expect(choices.find(choice => choice.includes(otherCompany))).not.toContain('checked=""');
    expect(html).toContain('Select all');
    expect(html).toContain('aria-label="About workspace access"');
    expect(html).toContain('aria-label="About Standard access"');
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

  it('issues one authorization for the selected organizations and rejects unavailable selections', async () => {
    mocks.projects.mockResolvedValue([{ id: project, organizationId: company }, { id: 'other-project', organizationId: otherCompany }]);
    expect((await consent('', 'allow', [company, otherCompany])).status).toBe(303);
    expect(mocks.code).toHaveBeenCalledWith(principal, expect.objectContaining({ clientId: 'client' }), {
      organizationIds: [company, otherCompany], selection: { profile: 'standard', providers: [] },
    });
    mocks.code.mockClear();
    expect((await consent('', 'allow', [company, '44444444-4444-4444-8444-444444444444'])).status).toBe(400);
    expect((await consent('', 'allow', [])).status).toBe(400);
    expect((await consent('', 'allow', [company, otherCompany], 'https://unrelated.test')).status).toBe(403);
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
