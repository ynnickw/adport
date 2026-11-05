import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantPrincipal } from '@/lib/cloud/types';

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  runtime: vi.fn(),
  server: vi.fn(),
  uiServer: vi.fn(),
  oauthClient: vi.fn(),
  membership: vi.fn(),
}));

vi.mock('@/lib/cloud/tool-catalog', () => ({ principalToolSelection: async () => ({ profile: 'full', providers: null }) }));
vi.mock('@/lib/db', () => ({ db: () => mocks.membership }));
vi.mock('@/lib/cloud/auth', () => ({ apiPrincipal: mocks.principal }));
vi.mock('@/lib/cloud/runtime', () => ({ createTenantRuntime: mocks.runtime }));
vi.mock('@/lib/cloud/mcp-projects', () => ({ routeMcpProjects: (runtime: unknown) => runtime }));
vi.mock('@/lib/cloud/mcp-oauth-repository', () => ({ getMcpOAuthClient: mocks.oauthClient }));
vi.mock('@adport/mcp', async importOriginal => ({ ...await importOriginal<typeof import('@adport/mcp')>(), createMcpServer: mocks.server, createMcpUiServer: mocks.uiServer }));
vi.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: () => ({ fetch: async () => Response.json({ ok: true }) }),
  isLegacyRequest: async () => false,
}));

import { POST } from '@/app/mcp/route';

const freePrincipal: TenantPrincipal = {
  organizationId: 'fictional-org',
  userId: 'fictional-user',
  oauthTokenId: 'fictional-token-id',
  clientId: 'fictional-client',
  role: 'owner',
  scopes: ['tools:read'],
  grantedScopes: ['tools:read', 'tools:write'],
  entitlement: { planId: 'reader', planName: 'Free', writeAccess: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership.mockResolvedValue([{ role: 'owner' }]);
  mocks.principal.mockResolvedValue(freePrincipal);
  mocks.runtime.mockResolvedValue({});
  mocks.oauthClient.mockResolvedValue(undefined);
  mocks.server.mockReturnValue({ connect: vi.fn().mockResolvedValue(undefined) });
  mocks.uiServer.mockReturnValue({ connect: vi.fn().mockResolvedValue(undefined) });
});

async function serverOptions(principal = freePrincipal) {
  mocks.principal.mockResolvedValue(principal);
  const response = await POST(new Request('https://app.adport.test/mcp', { method: 'POST' }));
  expect(response.status).toBe(200);
  return mocks.server.mock.calls[0]![0];
}

describe('hosted MCP entitlement explanation', () => {
  it.each(['resources/read', 'resources/list', 'resources/templates/list'])('authenticates %s while avoiding tenant/provider and billing runtime assembly', async method => {
    mocks.oauthClient.mockResolvedValue({ redirectUris: ['https://claude.ai/api/mcp/auth_callback'] });
    const response = await POST(new Request('https://app.adport.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { uri: 'ui://adport/insight-card-v3.html' } }) }));
    expect(response.status).toBe(200); expect(mocks.principal).toHaveBeenCalledOnce();
    expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.server).not.toHaveBeenCalled(); expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.uiServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'adport-cloud', uiDomain: null, uiResourceDomains: expect.arrayContaining([new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin]) }));
  });

  it('does not let an unauthenticated UI resource request reach either server', async () => {
    mocks.principal.mockRejectedValueOnce(new Error('Unauthorized'));
    const response = await POST(new Request('https://app.adport.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://adport/insight-card-v3.html' } }) }));
    expect(response.status).toBe(401); expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.uiServer).not.toHaveBeenCalled(); expect(mocks.server).not.toHaveBeenCalled();
  });

  it('keeps forged resource headers on business calls in the normal scope and policy server', async () => {
    await POST(new Request('https://app.adport.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-method': 'resources/read' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'some_write', arguments: {} } }) }));
    expect(mocks.runtime).toHaveBeenCalledOnce(); expect(mocks.uiServer).not.toHaveBeenCalled(); expect(mocks.server).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['tools:read'], scopeDenials: { 'tools:write': expect.objectContaining({ code: 'PLAN_LIMIT' }) } }));
  });

  it('selects Claude metadata without requiring an initialize request', async () => {
    mocks.oauthClient.mockResolvedValue({ redirectUris: ['https://claude.ai/api/mcp/auth_callback'] });
    const options = await serverOptions();
    expect(options.uiDomain).toBeNull();
    expect(mocks.oauthClient).toHaveBeenCalledWith('fictional-client');
    expect(options.scopes).toEqual(['tools:read']);
    expect(options.uiResourceDomains).toContain(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin);
    expect(options.uiConnectDomains).toEqual([new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin]);
  });

  it('preserves default metadata for other clients and skips lookup for API keys', async () => {
    expect((await serverOptions({ ...freePrincipal, oauthTokenId: undefined, apiKeyId: 'key' })).uiDomain).toBeUndefined();
    expect(mocks.oauthClient).not.toHaveBeenCalled();
  });
  it('directs missing-provider recovery to cloud account setup, not a local CLI command', async () => {
    const options = await serverOptions();
    expect(options.productionOnly).toBe(true);
    expect(options.notConnectedMessage).toContain('Connections in the Adport dashboard');
    expect(options.notConnectedMessage).toContain('Accounts to enable agent access');
    expect(options.notConnectedMessage).not.toMatch(/adport connect|--demo/);
  });

  it('explains Free write access with a priced, organization-specific upgrade link without granting access', async () => {
    const options = await serverOptions();
    const denial = options.scopeDenials['tools:write'];
    expect(options.scopes).toEqual(['tools:read']);
    expect(denial.code).toBe('PLAN_LIMIT');
    expect(denial.data.planLimit).toEqual({
      kind: 'write_access', currentPlan: 'Free', recommendedPlan: 'operator', message: denial.message,
      canManageBilling: true, projectId: 'fictional-org',
      upgradeUrl: new URL('/dashboard/billing?intent=write_access&plan=operator&projectId=fictional-org', process.env.ADPORT_CLOUD_BASE_URL).href,
    });
    expect(denial.message).toContain('Pro (€19/month)');
    expect(denial.message).toContain('No changes were made.');
  });

  it('asks a project owner who is not the organization owner to share the link', async () => {
    mocks.membership.mockResolvedValue([{ role: 'admin' }]);
    const denial = (await serverOptions()).scopeDenials['tools:write'];
    expect(denial.data.planLimit.canManageBilling).toBe(false);
    expect(denial.message).toContain('Ask your organization owner');
  });

  it('does not mislabel a missing OAuth write scope as a plan limit', async () => {
    const options = await serverOptions({ ...freePrincipal, grantedScopes: ['tools:read'] });
    expect(options.scopeDenials).toBeUndefined();
    expect(options.scopes).toEqual(['tools:read']);
  });

  it('does not offer plan-blocked tools to a viewer', async () => {
    expect((await serverOptions({ ...freePrincipal, role: 'viewer' })).scopeDenials).toBeUndefined();
  });

  it('preserves entitled write access', async () => {
    const options = await serverOptions({
      ...freePrincipal,
      scopes: ['tools:read', 'tools:write'],
      entitlement: { planId: 'premium', planName: 'Premium', writeAccess: true },
    });
    expect(options.scopeDenials).toBeUndefined();
    expect(options.scopes).toEqual(['tools:read', 'tools:write']);
  });

  it('does not invent a plan limit when entitlement information is absent', async () => {
    expect((await serverOptions({ ...freePrincipal, entitlement: undefined })).scopeDenials).toBeUndefined();
  });
});
