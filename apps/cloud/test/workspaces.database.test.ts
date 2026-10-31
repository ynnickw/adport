import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, closeDbForTests } from '@/lib/db';
import { createOrganization, createProject, listProjectAccess, saveOrganizationMember, removeCompanyMember, updateProject } from '@/lib/cloud/workspaces';
import { resolveMembership, createApiKey, authenticateApiKey, upsertGoogleConnection, setOrganizationAdAccountEnabled, PostgresPendingStore } from '@/lib/cloud/repository';
import { getOrganizationEntitlement, applyPlanToPrincipal } from '@/lib/cloud/plans';
import { registerMcpOAuthClient, createMcpAuthorizationCode, exchangeMcpAuthorizationCode, exchangeMcpRefreshToken, authenticateMcpOAuthAccessToken } from '@/lib/cloud/mcp-oauth-repository';
import { mcpResourceUrl, pkceChallenge } from '@/lib/mcp-oauth';
import { processStripeEvent } from '@/lib/cloud/billing';
import { resetEnvForTests } from '@/lib/env';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;

describeDatabase('agency organizations and isolated projects', () => {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const users: string[] = [];
  let owner: string;
  let client: string;
  let outsider: string;
  let clientToken: string;
  let company: string;
  let firstProject: string;
  let secondProject: string;
  let oauthClientId: string;
  let grant: Awaited<ReturnType<typeof exchangeMcpAuthorizationCode>>;
  const verifier = 'v'.repeat(64);
  const redirectUri = 'http://127.0.0.1:45895/callback';

  beforeAll(async () => {
    for (const label of ['owner', 'client', 'outsider']) {
      const email = `agency-${label}-${randomUUID()}@example.test`;
      const created = await admin.auth.admin.createUser({ email, password: 'Local-Agency-Test-Passw0rd!', email_confirm: true });
      if (created.error || !created.data.user) throw created.error ?? new Error('Local user creation failed');
      users.push(created.data.user.id);
      if (label === 'client') {
        const signedIn = await createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!).auth.signInWithPassword({ email, password: 'Local-Agency-Test-Passw0rd!' });
        if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error('Local sign in failed');
        clientToken = signedIn.data.session.access_token;
      }
    }
    owner = users[0]!; client = users[1]!; outsider = users[2]!;
    company = (await resolveMembership(owner)).organizationId;
    await db()`update public.organization_subscriptions set plan = 'agency', status = 'active' where organization_id = ${company}`;
    firstProject = await createProject(owner, company, 'Client Alpha');
    secondProject = await createProject(owner, company, 'Client Beta');
  });

  afterAll(async () => {
    if (oauthClientId) await db()`delete from private.mcp_oauth_clients where client_id = ${oauthClientId}`;
    if (users.length) {
      await db()`delete from public.organizations where created_by in ${db()(users)} and id <> organization_group_id`;
      await db()`delete from public.organizations where created_by in ${db()(users)}`;
      for (const user of users) await admin.auth.admin.deleteUser(user);
    }
    await closeDbForTests();
  });

  it('preserves the original tenant ID and inherits one subscription across isolated projects', async () => {
    const roots = await db()<Array<{ defaultProjectId: string }>>`select default_project_id from public.organization_groups where id = ${company}`;
    expect(roots[0]?.defaultProjectId).toBe(company);
    expect((await resolveMembership(owner, firstProject)).role).toBe('owner');
    expect((await getOrganizationEntitlement(secondProject)).plan.id).toBe('agency');
    expect((await getOrganizationEntitlement(secondProject)).billingOrganizationId).toBe(company);
    const separate = await createOrganization(owner, 'Independent company');
    expect((await getOrganizationEntitlement(separate)).plan.id).toBe('reader');
    await expect(createProject(outsider, company, 'Unauthorized project')).rejects.toThrow('owner or admin');
  });

  it('limits client members to explicitly selected projects in both backend and RLS reads', async () => {
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: client, role: 'viewer', projectIds: [firstProject] });
    const access = await listProjectAccess(client);
    expect(access.some(project => project.id === firstProject)).toBe(true);
    expect(access.some(project => project.id === secondProject)).toBe(false);
    await expect(resolveMembership(client, secondProject)).rejects.toThrow('access');
    await expect(saveOrganizationMember({ actorUserId: client, organizationId: company, userId: client, role: 'owner', projectIds: [] })).rejects.toThrow('owner or admin');
    const restricted = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      global: { headers: { authorization: `Bearer ${clientToken}` } }, auth: { persistSession: false },
    });
    const visible = await restricted.from('organizations').select('id').in('id', [firstProject, secondProject, company]);
    expect(visible.error).toBeNull();
    expect(visible.data).toEqual([{ id: firstProject }]);
    const forged = await restricted.from('organization_group_memberships').insert({ organization_group_id: company, user_id: outsider, role: 'owner' });
    expect(forged.error).not.toBeNull();
    const principal = await applyPlanToPrincipal({ organizationId: firstProject, userId: client, scopes: ['tools:read', 'tools:write'] });
    expect(principal.scopes).toEqual(['tools:read']);
  });

  it('keeps credentials, approval tokens and OAuth grants bound to a single project', async () => {
    await upsertGoogleConnection({ organizationId: firstProject, userId: owner, refreshToken: 'local-alpha-test-token', accessibleCustomerIds: ['alpha'] });
    await upsertGoogleConnection({ organizationId: secondProject, userId: owner, refreshToken: 'local-beta-test-token', accessibleCustomerIds: ['beta'] });
    const id = randomUUID();
    const pending = new PostgresPendingStore({ organizationId: firstProject, userId: owner, scopes: [] });
    await pending.put({ id, provider: 'google', opHash: 'alpha-hash', op: { tool: 'test', provider: 'google', accountId: 'alpha', kind: 'update', payload: { status: 'PAUSED' } },
      preview: { summary: 'Pause Alpha campaign', changes: [], coercions: [], budgetDeltas: [], serverValidated: true }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await new PostgresPendingStore({ organizationId: secondProject, userId: owner, scopes: [] }).get(id)).toBeUndefined();
    const oauthClient = await registerMcpOAuthClient({ clientName: 'Agency project test', redirectUris: [redirectUri], grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none' });
    oauthClientId = oauthClient.clientId;
    const code = await createMcpAuthorizationCode({ organizationId: firstProject, userId: client, role: 'viewer', scopes: ['tools:read'] }, {
      clientId: oauthClientId, clientName: 'Agency project test', redirectUri, scopes: ['tools:read'], codeChallenge: pkceChallenge(verifier), resource: mcpResourceUrl(), state: 'agency-test',
    });
    grant = await exchangeMcpAuthorizationCode({ clientId: oauthClientId, code, codeVerifier: verifier, redirectUri, resource: mcpResourceUrl() });
    expect((await authenticateMcpOAuthAccessToken(grant.accessToken))?.organizationId).toBe(firstProject);
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: client, role: 'viewer', projectIds: [secondProject] });
    expect(await authenticateMcpOAuthAccessToken(grant.accessToken)).toBeUndefined();
    await expect(exchangeMcpRefreshToken({ clientId: oauthClientId, refreshToken: grant.refreshToken, resource: mcpResourceUrl() })).rejects.toThrow('revoked');
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: client, role: 'viewer', projectIds: [firstProject] });
    expect(await authenticateMcpOAuthAccessToken(grant.accessToken)).toBeUndefined();
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: client, role: 'viewer', projectIds: [secondProject] });
  });

  it('serializes account activation across projects and enforces organization-wide seats', async () => {
    await db()`update public.organization_subscriptions set plan = 'operator' where organization_id = ${company}`;
    await expect(saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: outsider, role: 'viewer', projectIds: [firstProject] })).rejects.toThrow('member limit');
    for (const projectId of [firstProject, secondProject]) {
      const connections = await db()<Array<{ id: string }>>`select id from public.connections where organization_id = ${projectId} and provider = 'google'`;
      for (let i = 0; i < 3; i++) await db()`insert into public.organization_ad_accounts (organization_id, connection_id, provider, account_id, name)
        values (${projectId}, ${connections[0]!.id}, 'google', ${`account-${i}`}, ${`Account ${i}`})`;
    }
    const enable = (projectId: string, i: number) => setOrganizationAdAccountEnabled({ principal: { organizationId: projectId, userId: owner, role: 'owner', scopes: [] }, provider: 'google', accountId: `account-${i}`, enabled: true, maxActiveAccounts: 5, currentPlan: 'Operator', recommendedPlan: 'premium' });
    await enable(firstProject, 0); await enable(firstProject, 1); await enable(firstProject, 2); await enable(secondProject, 0);
    const concurrent = await Promise.allSettled([enable(secondProject, 1), enable(secondProject, 2)]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1);
    const enabled = await db()<Array<{ count: number }>>`select count(*)::int as count from public.organization_ad_accounts where organization_id in ${db()([firstProject, secondProject])} and enabled`;
    expect(enabled[0]?.count).toBe(5);
    const inactive = await db()<Array<{ organizationId: string; accountId: string }>>`select organization_id, account_id
      from public.organization_ad_accounts where organization_id in ${db()([firstProject, secondProject])} and not enabled limit 1`;
    await expect(db()`update public.organization_ad_accounts set enabled = true
      where organization_id = ${inactive[0]!.organizationId} and account_id = ${inactive[0]!.accountId}`).rejects.toThrow('Organization active account limit');
  });

  it('downscales the shared account allowance across every project on cancellation', async () => {
    process.env.STRIPE_OPERATOR_PRICE_ID = 'price_agency_local_operator';
    resetEnvForTests();
    await processStripeEvent({ id: `evt_local_${randomUUID()}`, type: 'customer.subscription.deleted', data: { object: {
      id: `sub_local_${randomUUID()}`, customer: `cus_local_${randomUUID()}`, metadata: { organizationId: company },
      items: { data: [{ price: { id: 'price_agency_local_operator' } }] }, status: 'canceled', cancel_at_period_end: false,
    } } } as unknown as Parameters<typeof processStripeEvent>[0]);
    const enabled = await db()<Array<{ count: number }>>`select count(*)::int as count from public.organization_ad_accounts where organization_id in ${db()([firstProject, secondProject])} and enabled`;
    expect(enabled[0]?.count).toBe(3);
    expect((await getOrganizationEntitlement(secondProject)).plan.id).toBe('reader');
    delete process.env.STRIPE_OPERATOR_PRICE_ID;
    resetEnvForTests();
  });

  it('suspends archived project keys and prevents default-project archival', async () => {
    const key = await createApiKey({ organizationId: firstProject, userId: owner, name: 'Local archive test', scopes: ['tools:read'] });
    expect(await authenticateApiKey(key.key)).toBeDefined();
    await updateProject(owner, firstProject, { archived: true });
    expect(await authenticateApiKey(key.key)).toBeUndefined();
    await expect(resolveMembership(owner, firstProject)).rejects.toThrow('access');
    await expect(updateProject(owner, company, { archived: true })).rejects.toThrow('default project');
    await updateProject(owner, firstProject, { archived: false });
    expect(await authenticateApiKey(key.key)).toBeDefined();
  });

  it('protects the last organization owner and removes all project grants for departing clients', async () => {
    await expect(saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: owner, role: 'member', projectIds: [firstProject] })).rejects.toThrow('last organization owner');
    await removeCompanyMember(owner, company, client);
    expect((await listProjectAccess(client)).some(project => project.organizationId === company)).toBe(false);
    expect(await authenticateMcpOAuthAccessToken(grant.accessToken)).toBeUndefined();
    await expect(removeCompanyMember(owner, company, owner)).rejects.toThrow('last organization owner');
  });

  it('handles more simultaneous team edits than the database pool without waiting for a second connection', async () => {
    await db()`update public.organization_subscriptions set plan = 'operator', status = 'active' where organization_id = ${company}`;
    await Promise.all(Array.from({ length: 12 }, () => saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: client, role: 'viewer', projectIds: [secondProject] })));
    expect((await resolveMembership(client, secondProject)).role).toBe('viewer');
  });

  it('serializes concurrent owner demotions so an organization always retains an owner', async () => {
    await db()`update public.organization_subscriptions set plan = 'operator', status = 'active' where organization_id = ${company}`;
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: client, role: 'owner', projectIds: [] });
    const results = await Promise.allSettled([
      saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: owner, role: 'member', projectIds: [firstProject] }),
      saveOrganizationMember({ actorUserId: client, organizationId: company, userId: client, role: 'member', projectIds: [secondProject] }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const owners = await db()<Array<{ count: number }>>`select count(*)::int as count from public.organization_group_memberships
      where organization_group_id = ${company} and role = 'owner'`;
    expect(owners[0]?.count).toBe(1);
  });
});
