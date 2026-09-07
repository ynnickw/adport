import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantPrincipal } from '@/lib/cloud/types';

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  runtime: vi.fn(),
  server: vi.fn(),
  oauthClient: vi.fn(),
}));

vi.mock('@/lib/cloud/auth', () => ({ apiPrincipal: mocks.principal }));
vi.mock('@/lib/cloud/runtime', () => ({ createTenantRuntime: mocks.runtime }));
vi.mock('@/lib/cloud/mcp-oauth-repository', () => ({ getMcpOAuthClient: mocks.oauthClient }));
vi.mock('@adport/mcp', () => ({ createMcpServer: mocks.server }));
vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: class {
    async handleRequest() { return Response.json({ ok: true }); }
  },
}));

import { POST } from '@/app/mcp/route';

const freePrincipal: TenantPrincipal = {
  organizationId: 'fictional-org',
  oauthTokenId: 'fictional-token-id',
  clientId: 'fictional-client',
  role: 'owner',
  scopes: ['tools:read'],
  grantedScopes: ['tools:read', 'tools:write'],
  entitlement: { planId: 'reader', planName: 'Free', writeAccess: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal.mockResolvedValue(freePrincipal);
  mocks.runtime.mockResolvedValue({});
  mocks.oauthClient.mockResolvedValue(undefined);
  mocks.server.mockReturnValue({ connect: vi.fn().mockResolvedValue(undefined) });
});

async function serverOptions(principal = freePrincipal) {
  mocks.principal.mockResolvedValue(principal);
  const response = await POST(new Request('https://app.adport.test/mcp', { method: 'POST' }));
  expect(response.status).toBe(200);
  return mocks.server.mock.calls[0]![0];
}

describe('hosted MCP entitlement explanation', () => {
  it('selects Claude metadata without requiring an initialize request', async () => {
    mocks.oauthClient.mockResolvedValue({ redirectUris: ['https://claude.ai/api/mcp/auth_callback'] });
    const options = await serverOptions();
    expect(options.uiDomain).toMatch(/^[a-f0-9]{32}\.claudemcpcontent\.com$/);
    expect(mocks.oauthClient).toHaveBeenCalledWith('fictional-client');
    expect(options.scopes).toEqual(['tools:read']);
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

  it('identifies the plan limit without promoting or initiating a purchase', async () => {
    const options = await serverOptions();
    const denial = options.scopeDenials['tools:write'];
    expect(options.scopes).toEqual(['tools:read']);
    expect(denial.code).toBe('PLAN_LIMIT');
    expect(denial.data.planLimit).toEqual({
      kind: 'write_access',
      currentPlan: 'Free',
      recommendedPlan: 'operator',
      message: denial.message,
    });
    expect(denial.message).toContain('not included in the current Free plan');
    expect(denial.message).toContain('require operator or higher with write access');
    expect(JSON.stringify(denial)).not.toMatch(/https?:|upgrade|subscribe|checkout|billing|buy/i);
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
