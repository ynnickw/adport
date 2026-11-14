import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, closeDbForTests } from '@/lib/db';
import { createOrganization, createProject, saveOrganizationMember, removeCompanyMember, updateProject } from '@/lib/cloud/workspaces';
import { resolveMembership, upsertGoogleConnection } from '@/lib/cloud/repository';
import { registerMcpOAuthClient, createMcpAuthorizationCode, exchangeMcpAuthorizationCode, exchangeMcpRefreshToken, authenticateMcpOAuthAccessToken, listMcpOAuthGrants, listMcpProjects } from '@/lib/cloud/mcp-oauth-repository';
import { apiPrincipal } from '@/lib/cloud/auth';
import { getAssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import { mcpResourceUrl, pkceChallenge } from '@/lib/mcp-oauth';
import { resetEnvForTests } from '@/lib/env';
import { POST } from '@/app/mcp/route';
import { GoogleAdsProvider } from '@adport/provider-google';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { removeOrganizationMember } from '@/lib/cloud/tenant-admin';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;

describeDatabase('all-project MCP authorization and HTTP routing', () => {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const users: string[] = [];
  let owner: string, viewer: string, company: string, second: string, separate: string, clientId: string;
  let all: Awaited<ReturnType<typeof exchangeMcpAuthorizationCode>>;
  let single: Awaited<ReturnType<typeof exchangeMcpAuthorizationCode>>;
  const verifier = 'v'.repeat(64);
  const redirectUri = 'http://127.0.0.1:45897/callback';

  async function authorize(userId: string, projectId: string, groupId?: string) {
    const code = await createMcpAuthorizationCode({ organizationId: projectId, userId, scopes: ['tools:read', 'tools:write'] }, {
      clientId, clientName: 'Projects integration test', redirectUri, scopes: ['tools:read', 'tools:write'], codeChallenge: pkceChallenge(verifier), resource: mcpResourceUrl(),
    }, groupId);
    return exchangeMcpAuthorizationCode({ clientId, code, codeVerifier: verifier, redirectUri, resource: mcpResourceUrl() });
  }

  async function rpc(token: string, method: string, params?: object) {
    const response = await POST(new Request(mcpResourceUrl(), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
    expect(response.status).toBe(200);
    return (await response.json()).result;
  }

  async function call(token: string, name: string, args: object = {}) {
    const result = await rpc(token, 'tools/call', { name, arguments: args });
    return { isError: result.isError, ...JSON.parse(result.content[0].text) };
  }

  beforeAll(async () => {
    for (const label of ['owner', 'viewer']) {
      const created = await admin.auth.admin.createUser({ email: `mcp-projects-${label}-${randomUUID()}@example.test`, password: 'Local-Projects-Test-Passw0rd!', email_confirm: true });
      if (created.error || !created.data.user) throw created.error ?? new Error('User creation failed');
      users.push(created.data.user.id);
    }
    [owner, viewer] = users as [string, string];
    company = (await resolveMembership(owner)).organizationId;
    await db()`update public.organization_subscriptions set plan = 'agency', status = 'active' where organization_id = ${company}`;
    second = await createProject(owner, company, 'Second project');
    separate = await createOrganization(owner, 'Separate organization');
    const client = await registerMcpOAuthClient({ clientName: 'Projects integration test', redirectUris: [redirectUri], grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none' });
    clientId = client.clientId;
    all = await authorize(owner, company, company);
    single = await authorize(owner, company);
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'local-test-client');
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'local-test-secret');
    resetEnvForTests();
  });

  afterAll(async () => {
    vi.unstubAllEnvs(); resetEnvForTests();
    if (clientId) await db()`delete from private.mcp_oauth_clients where client_id = ${clientId}`;
    if (users.length) {
      await db()`delete from public.organizations where created_by in ${db()(users)} and id <> organization_group_id`;
      await db()`delete from public.organizations where created_by in ${db()(users)}`;
      for (const user of users) await admin.auth.admin.deleteUser(user);
    }
    await closeDbForTests();
  });

  it('persists explicit all-project consent across token refresh without broadening single-project grants', async () => {
    expect(await authenticateMcpOAuthAccessToken(single.accessToken)).not.toHaveProperty('oauthOrganizationGroupId', company);
    expect(await authenticateMcpOAuthAccessToken(all.accessToken)).toMatchObject({ oauthOrganizationGroupId: company });
    all = await exchangeMcpRefreshToken({ clientId, refreshToken: all.refreshToken, resource: mcpResourceUrl() });
    expect(await authenticateMcpOAuthAccessToken(all.accessToken)).toMatchObject({ oauthOrganizationGroupId: company });
    const grants = await listMcpOAuthGrants(second);
    expect(grants.some(grant => grant.organizationGroupId === company && grant.status === 'active')).toBe(true);
    expect((await getAssistantConnectionStatus({ organizationId: second, userId: owner, scopes: [] })).authorized).toBe(true);
  });

  it('lists only authorized projects, requires a target and rejects another organization even for the same owner', async () => {
    const projects = await call(all.accessToken, 'projects_list');
    expect(projects.projects.map((project: { id: string }) => project.id).sort()).toEqual([company, second].sort());
    expect(await call(all.accessToken, 'accounts_list')).toMatchObject({ isError: true, error: 'INVALID_INPUT' });
    expect(await call(all.accessToken, 'accounts_list', { project_id: separate })).toMatchObject({ isError: true, error: 'POLICY_VIOLATION' });
    await expect(authorize(owner, company, separate)).rejects.toThrow('access');
  });

  it('serves modern discovery and UI resources while retaining OAuth project boundaries and header validation', async () => {
    const client = new Client({ name: 'Modern host fixture', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StreamableHTTPClientTransport(new URL(mcpResourceUrl()), {
      requestInit: { headers: { authorization: `Bearer ${all.accessToken}` } },
      fetch: (url, init) => POST(new Request(url, init)),
    });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe('modern');
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['google_assets', 'linkedin_get_library_image', 'x_draft_tweets', 'projects_list']));
      expect(tools.some(tool => /_api_(read|create|update|delete|remove)$/.test(tool.name))).toBe(false);
      const accounts = tools.find(tool => tool.name === 'accounts_list')!;
      const uri = (accounts._meta?.ui as { resourceUri: string }).resourceUri;
      expect((await client.readResource({ uri })).contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' });
      const projects = await client.callTool({ name: 'projects_list', arguments: {} });
      expect((projects.structuredContent as { projects: Array<{ id: string }> }).projects.map(project => project.id).sort()).toEqual([company, second].sort());
      const foreign = await client.callTool({ name: 'accounts_list', arguments: { project_id: separate } });
      expect(foreign.isError).toBe(true);
      expect(JSON.parse((foreign.content as Array<{ text: string }>)[0]!.text)).toHaveProperty('error', 'POLICY_VIOLATION');
      const mismatch = await POST(new Request(mcpResourceUrl(), {
        method: 'POST', headers: { authorization: `Bearer ${all.accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
      }));
      expect(mismatch.status).toBe(400);
      expect((await mismatch.json()).error.code).toBe(-32020);
    } finally { await client.close(); }
  });

  it('uses a platform connected after consent with the same token and unchanged native tool catalog', async () => {
    const before = await rpc(all.accessToken, 'tools/list');
    expect(before.tools.some((tool: { name: string }) => tool.name === 'google_gaql')).toBe(true);
    expect(await call(all.accessToken, 'accounts_list', { project_id: second, provider: 'google' })).toMatchObject({ error: 'NOT_CONNECTED' });
    const connectionId = await upsertGoogleConnection({ organizationId: second, userId: owner, refreshToken: 'local-not-a-real-token', accessibleCustomerIds: ['1234567890'] });
    await db()`insert into public.organization_ad_accounts (organization_id, connection_id, provider, account_id, name, enabled)
      values (${second}, ${connectionId}, 'google', '1234567890', 'Second project Google account', true)`;
    expect(await call(all.accessToken, 'accounts_list', { project_id: second, provider: 'google' })).toMatchObject({ accounts: [{ id: '1234567890', name: 'Second project Google account' }] });
    const search = vi.spyOn(GoogleAdsProvider.prototype, 'gaqlSearch').mockResolvedValue([{ campaign: { id: '1' } }]);
    try {
      expect(await call(all.accessToken, 'google_gaql', { project_id: second, customer_id: '1234567890', resource: 'campaign', fields: ['campaign.id'] })).toMatchObject({ row_count: 1 });
      expect(await call(all.accessToken, 'google_gaql', { project_id: second, customer_id: '9999999999', resource: 'campaign', fields: ['campaign.id'] })).toMatchObject({ error: 'POLICY_VIOLATION' });
      expect(search).toHaveBeenCalledOnce();
    } finally { search.mockRestore(); }
    expect(await call(all.accessToken, 'accounts_list', { project_id: company, provider: 'google' })).toMatchObject({ error: 'NOT_CONNECTED' });
    expect((await rpc(all.accessToken, 'tools/list')).tools).toEqual(before.tools);
    expect((await getAssistantConnectionStatus({ organizationId: second, userId: owner, scopes: [] })).verified).toBe(true);
    const [singleGrant] = await db()<Array<{ verifiedAt: Date | null }>>`select verified_at from private.mcp_oauth_refresh_tokens
      where user_id = ${owner} and client_id = ${clientId} and organization_group_id is null and consumed_at is null`;
    expect(singleGrant?.verifiedAt).toBeNull();
    expect(await call(single.accessToken, 'accounts_list', { project_id: second, provider: 'google' })).toMatchObject({ error: 'POLICY_VIOLATION' });
  });

  it('includes future accessible projects and removes archived projects without reconnecting', async () => {
    const future = await createProject(owner, company, 'Future project');
    expect((await call(all.accessToken, 'projects_list')).projects.some((project: { id: string }) => project.id === future)).toBe(true);
    await updateProject(owner, future, { archived: true });
    expect((await call(all.accessToken, 'projects_list')).projects.some((project: { id: string }) => project.id === future)).toBe(false);
    expect(await call(all.accessToken, 'accounts_list', { project_id: future })).toMatchObject({ error: 'POLICY_VIOLATION' });
  });

  it('returns the current pricing explanation for the selected project after a downgrade', async () => {
    await db()`update public.organization_subscriptions set plan = 'reader' where organization_id = ${company}`;
    try {
      expect(await call(all.accessToken, 'google_set_budget', { project_id: second, account_id: '1234567890', campaign_id: '1', daily_budget_micros: 1_000_000 })).toMatchObject({
        error: 'PLAN_LIMIT', code: 'PLAN_LIMIT',
        planLimit: { kind: 'write_access', projectId: second, canManageBilling: true, recommendedPlan: 'operator' },
        message: expect.stringContaining('Pro (€19/month)'),
      });
    } finally {
      await db()`update public.organization_subscriptions set plan = 'agency' where organization_id = ${company}`;
    }
  });

  it('rechecks member project assignments and viewer permissions, then rejects removed users and refreshes', async () => {
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: viewer, role: 'viewer', projectIds: [second] });
    const grant = await authorize(viewer, second, company);
    expect((await call(grant.accessToken, 'projects_list')).projects.map((project: { id: string }) => project.id)).toEqual([second]);
    expect(await call(grant.accessToken, 'google_set_budget', { project_id: second, account_id: '1234567890', campaign_id: '1', daily_budget_micros: 1_000_000 })).toMatchObject({ error: 'POLICY_VIOLATION' });
    expect(await call(grant.accessToken, 'accounts_list', { project_id: company })).toMatchObject({ error: 'POLICY_VIOLATION' });
    const third = await createProject(owner, company, 'Reassigned client');
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: viewer, role: 'viewer', projectIds: [third] });
    expect((await call(grant.accessToken, 'projects_list')).projects.map((project: { id: string }) => project.id)).toEqual([third]);
    expect(await call(grant.accessToken, 'accounts_list', { project_id: second })).toMatchObject({ error: 'POLICY_VIOLATION' });
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: viewer, role: 'viewer', projectIds: [company, third] });
    await removeOrganizationMember({ organizationId: company, userId: owner, role: 'owner', scopes: [] }, viewer);
    expect((await call(grant.accessToken, 'projects_list')).projects.map((project: { id: string }) => project.id)).toEqual([third]);
    await removeCompanyMember(owner, company, viewer);
    expect(await listMcpProjects({ organizationId: company, userId: viewer, oauthOrganizationGroupId: company, scopes: [] })).toEqual([]);
    await expect(apiPrincipal(new Request(mcpResourceUrl(), { headers: { authorization: `Bearer ${grant.accessToken}` } }))).rejects.toThrow(/Invalid|revoked/);
    await expect(exchangeMcpRefreshToken({ clientId, refreshToken: grant.refreshToken, resource: mcpResourceUrl() })).rejects.toThrow(/revoked/);
  });
});
