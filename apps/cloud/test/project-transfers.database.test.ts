import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDbForTests, db } from '@/lib/db';
import { mcpResourceUrl, pkceChallenge } from '@/lib/mcp-oauth';
import { stageAccountSelection } from '@/lib/cloud/account-selection';
import { authenticateMcpOAuthAccessToken, createMcpAuthorizationCode, exchangeMcpAuthorizationCode, exchangeMcpRefreshToken, listMcpProjects, registerMcpOAuthClient } from '@/lib/cloud/mcp-oauth-repository';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { transferProject } from '@/lib/cloud/project-transfers';
import { authenticateApiKey, createApiKey, loadEnabledAccountIds, loadGoogleCredential, resolveMembership, upsertGoogleConnection, upsertProviderConnection } from '@/lib/cloud/repository';
import { createOrganization, createProject, saveOrganizationMember, updateProject } from '@/lib/cloud/workspaces';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;

describeDatabase('project transfers between organizations', () => {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
  const users: string[] = [];
  const verifier = 'v'.repeat(64);
  const redirectUri = 'http://127.0.0.1:45899/callback';
  let owner: string, sourceOwner: string, destinationOwner: string, sourceOnly: string, viewer: string;
  let source: string, destination: string, freeDestination: string, clientId: string;

  async function addEnabledAccounts(projectId: string, count: number) {
    const connectionId = await upsertGoogleConnection({ organizationId: projectId, userId: owner,
      refreshToken: 'synthetic-project-transfer-fixture', accessibleCustomerIds: [] });
    for (let index = 0; index < count; index++) await db()`
      insert into public.organization_ad_accounts (organization_id, connection_id, provider, account_id, name, enabled)
      values (${projectId}, ${connectionId}, 'google', ${String(index + 1)}, 'Transfer fixture account', true)`;
    return connectionId;
  }

  async function authorizationCode(projectId: string, organizationGroupId?: string) {
    return createMcpAuthorizationCode({ organizationId: projectId, userId: owner, scopes: ['tools:read'] }, {
      clientId, clientName: 'Transfer fixture', redirectUri, scopes: ['tools:read'], codeChallenge: pkceChallenge(verifier), resource: mcpResourceUrl(),
    }, organizationGroupId);
  }

  function exchange(code: string) {
    return exchangeMcpAuthorizationCode({ clientId, code, codeVerifier: verifier, redirectUri, resource: mcpResourceUrl() });
  }

  const request = (projectId: string) => ({ actorUserId: owner, projectId, sourceOrganizationId: source, destinationOrganizationId: destination });

  beforeAll(async () => {
    for (let index = 0; index < 5; index++) {
      const created = await admin.auth.admin.createUser({ email: `project-transfer-${randomUUID()}@example.test`, email_confirm: true });
      if (created.error || !created.data.user) throw created.error ?? new Error('Could not create test user.');
      users.push(created.data.user.id);
    }
    [owner, sourceOwner, destinationOwner, sourceOnly, viewer] = users as [string, string, string, string, string];
    source = await createOrganization(owner, 'Source team');
    destination = await createOrganization(owner, 'Destination team');
    freeDestination = await createOrganization(owner, 'Free team');
    await db()`update public.organization_subscriptions set plan = 'agency' where organization_id = ${source}`;
    await db()`update public.organization_subscriptions set plan = 'premium' where organization_id = ${destination}`;
    await saveOrganizationMember({ actorUserId: owner, organizationId: source, userId: sourceOwner, role: 'owner', projectIds: [] });
    await saveOrganizationMember({ actorUserId: owner, organizationId: destination, userId: sourceOwner, role: 'admin', projectIds: [] });
    await saveOrganizationMember({ actorUserId: owner, organizationId: source, userId: destinationOwner, role: 'admin', projectIds: [] });
    await saveOrganizationMember({ actorUserId: owner, organizationId: destination, userId: destinationOwner, role: 'owner', projectIds: [] });
    await saveOrganizationMember({ actorUserId: owner, organizationId: source, userId: sourceOnly, role: 'owner', projectIds: [] });
    clientId = (await registerMcpOAuthClient({ clientName: 'Transfer fixture', redirectUris: [redirectUri],
      grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none' })).clientId;
  });

  afterAll(async () => {
    if (clientId) await db()`delete from private.mcp_oauth_clients where client_id = ${clientId}`;
    if (users.length) {
      await db()`delete from public.organizations where created_by in ${db()(users)} and id <> organization_group_id`;
      await db()`delete from public.organizations where created_by in ${db()(users)}`;
      for (const user of users) await admin.auth.admin.deleteUser(user);
    }
    await closeDbForTests();
  });

  it('requires ownership in both organizations and protects the billing anchor', async () => {
    const projectId = await createProject(owner, source, 'Restricted transfer');
    for (const actorUserId of [sourceOwner, destinationOwner, sourceOnly]) {
      await expect(transferProject({ ...request(projectId), actorUserId })).rejects.toMatchObject({ status: 403 });
    }
    await expect(transferProject(request(source))).rejects.toThrow('tied to organization billing');
    await expect(db()`update public.organizations set organization_group_id = ${destination} where id = ${source}`)
      .rejects.toThrow('default project cannot be transferred');
    await expect(transferProject({ ...request(projectId), destinationOrganizationId: source })).rejects.toThrow('different organization');
  });

  it('moves the project in place and replaces source access with destination access', async () => {
    const projectId = await createProject(owner, source, 'Client launch');
    const connectionId = await addEnabledAccounts(projectId, 1);
    const selectionId = randomUUID();
    const pendingConnectionId = await upsertProviderConnection({ organizationId: projectId, userId: owner, provider: 'meta',
      credential: { accessToken: 'synthetic-pending-grant' }, selectionId });
    await db()`insert into public.organization_ad_accounts (organization_id, connection_id, provider, account_id, name, enabled)
      values (${projectId}, ${pendingConnectionId}, 'meta', 'act_1', 'Previous enabled account', true)`;
    await stageAccountSelection({ principal: { userId: owner, organizationId: projectId, role: 'owner', scopes: [] },
      id: selectionId, connectionId: pendingConnectionId, provider: 'meta', accounts: [], returnPath: '/dashboard/accounts' });
    await db()`update public.organization_settings set data_retention_days = 400 where organization_id = ${projectId}`;
    await db()`insert into public.organization_memberships (organization_id, user_id, role) values (${projectId}, ${viewer}, 'viewer')`;
    const key = await createApiKey({ organizationId: projectId, userId: sourceOnly, name: 'Source key', scopes: ['tools:read'] });
    const legacy = await exchange(await authorizationCode(projectId));
    const unusedCode = await authorizationCode(projectId);
    const sourceGrant = await exchange(await authorizationCode(projectId, source));
    const destinationGrant = await exchange(await authorizationCode(destination, destination));
    const pendingId = randomUUID();
    await db()`insert into public.pending_operations (id, organization_id, provider, operation_hash, operation, preview, created_at, expires_at)
      values (${pendingId}, ${projectId}, 'google', 'local-fixture', '{}', '{}', now(), now() + interval '15 minutes')`;
    await db()`insert into private.member_invitations
      (token_hash, organization_group_id, project_id, project_ids, email, role, invited_by) values
      (${randomUUID()}, ${source}, ${projectId}, '{}', 'project@example.test', 'viewer', ${owner}),
      (${randomUUID()}, ${source}, null, ${[projectId, source]}, 'scoped@example.test', 'viewer', ${owner}),
      (${randomUUID()}, ${source}, null, '{}', 'unrelated@example.test', 'admin', ${owner})`;

    const outcomes = await Promise.allSettled([transferProject(request(projectId)), transferProject(request(projectId))]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: { archived: false, destinationProjectId: destination } },
    ]);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await getOrganizationEntitlement(projectId)).billingOrganizationId).toBe(destination);
    expect((await resolveMembership(destinationOwner, projectId)).role).toBe('owner');
    await expect(resolveMembership(sourceOnly, projectId)).rejects.toThrow('access');
    await expect(resolveMembership(viewer, projectId)).rejects.toThrow('access');
    expect((await loadGoogleCredential(projectId))?.connectionId).toBe(connectionId);
    expect(await loadEnabledAccountIds(projectId)).toEqual({ google: new Set(['1']) });
    expect(await db()`select id from private.provider_account_selections where id = ${selectionId}`).toHaveLength(0);
    expect(await db()`select data_retention_days from public.organization_settings where organization_id = ${projectId}`)
      .toMatchObject([{ dataRetentionDays: 365 }]);
    expect(await authenticateApiKey(key.key)).toBeUndefined();
    await expect(createApiKey({ organizationId: projectId, userId: sourceOnly, name: 'Old access', scopes: ['tools:read'] })).rejects.toThrow('access');
    await expect(upsertGoogleConnection({ organizationId: projectId, userId: sourceOnly,
      refreshToken: 'synthetic-invalid-after-transfer', accessibleCustomerIds: [] })).rejects.toThrow('access');
    expect(await authenticateMcpOAuthAccessToken(legacy.accessToken)).toBeUndefined();
    await expect(exchangeMcpRefreshToken({ clientId, refreshToken: legacy.refreshToken, resource: mcpResourceUrl() })).rejects.toThrow('revoked');
    await expect(exchange(unusedCode)).rejects.toThrow('already used');
    const sourcePrincipal = (await authenticateMcpOAuthAccessToken(sourceGrant.accessToken))!;
    const destinationPrincipal = (await authenticateMcpOAuthAccessToken(destinationGrant.accessToken))!;
    expect((await listMcpProjects(sourcePrincipal)).map(project => project.id)).not.toContain(projectId);
    expect((await listMcpProjects(destinationPrincipal)).map(project => project.id)).toContain(projectId);
    expect(await db()`select id from public.pending_operations where id = ${pendingId} and consumed_at is not null`).toHaveLength(1);
    const canceled = await db()<Array<{ email: string }>>`select email from private.member_invitations
      where organization_group_id = ${source} and canceled_at is not null order by email`;
    expect(canceled.map(invitation => invitation.email)).toEqual(['project@example.test', 'scoped@example.test']);
    const audit = await db()<Array<{ organizationId: string }>>`select organization_id from public.audit_events
      where tool = 'project_transfer' and account_id = ${projectId}`;
    expect(audit.map(event => event.organizationId).sort()).toEqual([source, projectId].sort());
  });

  it('leaves access and connections intact when the destination lacks account capacity', async () => {
    const projectId = await createProject(owner, source, 'Capacity check');
    await addEnabledAccounts(projectId, 1);
    await addEnabledAccounts(freeDestination, 3);
    const key = await createApiKey({ organizationId: projectId, userId: sourceOnly, name: 'Capacity test key', scopes: ['tools:read'] });
    await expect(transferProject({ ...request(projectId), destinationOrganizationId: freeDestination })).rejects.toThrow('Free team would have 4 enabled ad accounts');
    expect((await resolveMembership(sourceOnly, projectId)).role).toBe('owner');
    expect(await authenticateApiKey(key.key)).toMatchObject({ organizationId: projectId });
    expect((await getOrganizationEntitlement(projectId)).billingOrganizationId).toBe(source);
  });

  it('keeps an archived project archived when transferring it', async () => {
    const projectId = await createProject(owner, source, 'Archived project');
    await updateProject(owner, projectId, { archived: true });
    await expect(transferProject({ ...request(projectId), destinationOrganizationId: freeDestination })).resolves.toEqual({ archived: true, destinationProjectId: freeDestination });
    await expect(resolveMembership(owner, projectId)).rejects.toThrow('access');
    await updateProject(owner, projectId, { archived: false });
    expect((await getOrganizationEntitlement(projectId)).billingOrganizationId).toBe(freeDestination);
  });
});
