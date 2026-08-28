import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDbForTests, db } from '@/lib/db';
import { createContext, DEFAULT_POLICY, PolicyEngine } from '@adport/core';
import {
  authenticateApiKey,
  createApiKey,
  PostgresAuditStore,
  PostgresPendingStore,
  resolveMembership,
  revokeApiKey,
  upsertGoogleConnection,
  loadGoogleCredential,
  loadProviderCredentials,
  listOrganizationAdAccounts,
  PostgresFindingsStore,
  setOrganizationAdAccountEnabled,
  syncDiscoveredAccounts,
  upsertProviderConnection,
} from '@/lib/cloud/repository';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { processStripeEvent } from '@/lib/cloud/billing';
import { resetEnvForTests } from '@/lib/env';
import {
  changeOrganizationMemberRole,
  inviteOrganizationMember,
  listOrganizationMembers,
  removeOrganizationMember,
  updateOrganizationSettings,
} from '@/lib/cloud/tenant-admin';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secretKey = process.env.SUPABASE_SECRET_KEY!;
const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;

describeDatabase('Supabase tenant boundary', () => {
  const password = 'Local-Test-Passw0rd!';
  const users: string[] = [];
  let firstUserId: string;
  let firstOrgId: string;
  let secondOrgId: string;
  let secondUserId: string;
  let secondEmail: string;
  let firstAccessToken: string;

  beforeAll(async () => {
    for (const label of ['first', 'second']) {
      const email = `${label}-${randomUUID()}@example.test`;
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) throw error ?? new Error('User creation failed');
      users.push(data.user.id);
      const client = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const signedIn = await client.auth.signInWithPassword({ email, password });
      if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error('Sign in failed');
      const membership = await resolveMembership(data.user.id);
      if (label === 'first') {
        firstUserId = data.user.id;
        firstOrgId = membership.organizationId;
        firstAccessToken = signedIn.data.session.access_token;
      } else {
        secondOrgId = membership.organizationId;
        secondUserId = data.user.id;
        secondEmail = email;
      }
    }
  });

  afterAll(async () => {
    await db()`delete from public.organizations where id in ${db()([firstOrgId, secondOrgId])}`;
    for (const id of users) await admin.auth.admin.deleteUser(id);
    await closeDbForTests();
  });

  it('creates a personal tenant through the auth trigger and enforces RLS', async () => {
    const firstUserClient = createClient(url, publishableKey, {
      global: { headers: { Authorization: `Bearer ${firstAccessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const own = await firstUserClient.from('organizations').select('id');
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ id: firstOrgId }]);
    const other = await firstUserClient.from('organizations').select('id').eq('id', secondOrgId);
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
  });

  it('encrypts Google refresh tokens and never stores plaintext', async () => {
    await upsertGoogleConnection({
      organizationId: firstOrgId,
      userId: firstUserId,
      refreshToken: 'refresh-token-plain',
      accessibleCustomerIds: ['1234567890'],
    });
    const stored = await loadGoogleCredential(firstOrgId);
    expect(stored?.refreshToken).toBe('refresh-token-plain');
    const raw = await db()<Array<{ ciphertext: string }>>`
      select ciphertext from private.provider_credentials where organization_id = ${firstOrgId}
    `;
    expect(raw[0]?.ciphertext).not.toContain('refresh-token-plain');
  });

  it('shows an API key once, authenticates its digest, and revokes it', async () => {
    const created = await createApiKey({
      organizationId: firstOrgId,
      userId: firstUserId,
      name: 'integration test',
      scopes: ['tools:read', 'tools:write'],
    });
    expect(created.key).toMatch(/^adp_/);
    expect((await authenticateApiKey(created.key))?.organizationId).toBe(firstOrgId);
    expect(await revokeApiKey({ organizationId: firstOrgId, userId: firstUserId, scopes: [] }, created.id)).toBe(true);
    expect(await authenticateApiKey(created.key)).toBeUndefined();
  });

  it('persists discovered accounts and enforces the configured active-account limit', async () => {
    const connections = await db()<Array<{ id: string }>>`
      select id from public.connections where organization_id = ${firstOrgId} and provider = 'google'
    `;
    await syncDiscoveredAccounts({
      organizationId: firstOrgId,
      connectionId: connections[0]!.id,
      provider: 'google',
      accounts: [
        { provider: 'google', id: '1234567890', name: 'First account', currency: 'EUR' },
        { provider: 'google', id: '9999999999', name: 'Second account', currency: 'EUR' },
      ],
      maxActiveAccounts: 1,
    });
    const inventory = await listOrganizationAdAccounts(firstOrgId);
    expect(inventory).toHaveLength(2);
    expect(inventory.filter((account) => account.enabled)).toHaveLength(1);
    const inactive = inventory.find((account) => !account.enabled)!;
    await expect(setOrganizationAdAccountEnabled({
      principal: { organizationId: firstOrgId, userId: firstUserId, role: 'owner', scopes: [] },
      provider: 'google', accountId: inactive.accountId, enabled: true, maxActiveAccounts: 1,
      currentPlan: 'Reader', recommendedPlan: 'operator',
    })).rejects.toThrow(/Disable another account first/);
  });

  it('persists findings inside the organization boundary', async () => {
    const store = new PostgresFindingsStore(firstOrgId);
    const now = new Date().toISOString();
    await store.save({
      id: 'test-rule:google:1234567890:c1',
      ruleId: 'test-rule',
      severity: 'warn',
      provider: 'google',
      accountId: '1234567890',
      entity: { level: 'campaign', id: 'c1', name: 'Campaign' },
      title: 'Test finding',
      detail: 'Evidence',
      recommendation: 'Review it',
      metrics: {},
      dateRange: { start: '2026-08-01', end: '2026-08-27' },
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });
    expect(await store.get('test-rule:google:1234567890:c1')).toMatchObject({ status: 'open', provider: 'google' });
    await store.setStatus('test-rule:google:1234567890:c1', 'dismissed');
    expect(await store.list({ status: 'dismissed' })).toHaveLength(1);
    expect(await new PostgresFindingsStore(secondOrgId).list()).toEqual([]);
  });

  it('downscales active account access when Stripe returns a subscription to Free', async () => {
    process.env.STRIPE_OPERATOR_PRICE_ID = 'price_operator_test';
    process.env.STRIPE_AGENCY_PRICE_ID = 'price_agency_test';
    resetEnvForTests();
    const connections = await db()<Array<{ id: string }>>`
      select id from public.connections where organization_id = ${firstOrgId} and provider = 'google'
    `;
    await syncDiscoveredAccounts({
      organizationId: firstOrgId,
      connectionId: connections[0]!.id,
      provider: 'google',
      accounts: [
        { provider: 'google', id: '1234567890', name: 'First account', currency: 'EUR' },
        { provider: 'google', id: '9999999999', name: 'Second account', currency: 'EUR' },
        { provider: 'google', id: '8888888888', name: 'Third account', currency: 'EUR' },
        { provider: 'google', id: '7777777777', name: 'Fourth account', currency: 'EUR' },
      ],
      maxActiveAccounts: 4,
    });
    const outcome = await processStripeEvent({
      id: `evt_${randomUUID()}`,
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: `sub_${randomUUID()}`,
          customer: `cus_${randomUUID()}`,
          metadata: { organizationId: firstOrgId },
          items: { data: [{ price: { id: 'price_operator_test' }, current_period_end: null }] },
          status: 'canceled',
          cancel_at_period_end: false,
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);
    expect(outcome).toBe('processed');
    expect((await listOrganizationAdAccounts(firstOrgId)).filter((account) => account.enabled)).toHaveLength(3);
    const subscription = await db()<Array<{ plan: string; status: string }>>`
      select plan, status from public.organization_subscriptions where organization_id = ${firstOrgId}
    `;
    expect(subscription[0]).toEqual({ plan: 'operator', status: 'canceled' });
    const audit = await db()<Array<{ event: string }>>`
      select event from public.audit_events
      where organization_id = ${firstOrgId} and event = 'subscription_updated'
    `;
    expect(audit).toHaveLength(1);
    delete process.env.STRIPE_OPERATOR_PRICE_ID;
    delete process.env.STRIPE_AGENCY_PRICE_ID;
    resetEnvForTests();
  });

  it('encrypts every provider credential and assembles all provider modules for one tenant', async () => {
    process.env.GOOGLE_ADS_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_ADS_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'test-developer-token';
    process.env.APPLE_ADS_CLIENT_ID = 'SEARCHADS.11111111-2222-3333-4444-555555555555';
    process.env.APPLE_ADS_TEAM_ID = 'SEARCHADS.11111111-2222-3333-4444-555555555555';
    process.env.APPLE_ADS_KEY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    process.env.APPLE_ADS_PRIVATE_KEY = ['-----BEGIN ', `PRIVATE KEY-----\n${'test'.repeat(30)}\n-----END `, 'PRIVATE KEY-----'].join('');
    resetEnvForTests();
    await upsertProviderConnection({ organizationId: firstOrgId, userId: firstUserId, provider: 'meta', credential: { accessToken: 'meta-access-token-secret-value' } });
    await upsertProviderConnection({ organizationId: firstOrgId, userId: firstUserId, provider: 'tiktok', credential: { accessToken: 'tiktok-access-token-secret', appId: 'tiktok-app', secret: 'tiktok-secret' } });
    await upsertProviderConnection({ organizationId: firstOrgId, userId: firstUserId, provider: 'microsoft', credential: { developerToken: 'microsoft-developer-token', clientId: 'microsoft-client', refreshToken: 'microsoft-refresh-token-secret' } });
    await upsertProviderConnection({ organizationId: firstOrgId, userId: firstUserId, provider: 'reddit', credential: { clientId: 'reddit-client', clientSecret: 'reddit-client-secret', refreshToken: 'reddit-refresh-token-secret', userAgent: 'adport-cloud-test/1.0' } });
    await upsertProviderConnection({ organizationId: firstOrgId, userId: firstUserId, provider: 'apple', credential: { refreshToken: 'apple-refresh-token-secret' } });

    const decrypted = await loadProviderCredentials(firstOrgId);
    expect(decrypted.meta?.accessToken).toBe('meta-access-token-secret-value');
    expect(Object.keys(decrypted).sort()).toEqual(['apple', 'google', 'meta', 'microsoft', 'reddit', 'tiktok']);
    const raw = await db()<Array<{ ciphertext: string }>>`
      select ciphertext from private.provider_credentials where organization_id = ${firstOrgId}
    `;
    expect(raw.map((row) => row.ciphertext).join(' ')).not.toContain('meta-access-token-secret-value');
    expect(raw.map((row) => row.ciphertext).join(' ')).not.toContain('reddit-client-secret');
    expect(raw.map((row) => row.ciphertext).join(' ')).not.toContain('apple-refresh-token-secret');

    const runtime = await createTenantRuntime({ organizationId: firstOrgId, userId: firstUserId, scopes: ['tools:read'] });
    expect(runtime.ctx.providers.list().map((provider) => provider.id).sort()).toEqual(['apple', 'google', 'meta', 'microsoft', 'reddit', 'tiktok']);
  });

  it('persists pending operations and audit events per organization', async () => {
    const principal = { organizationId: firstOrgId, userId: firstUserId, scopes: ['tools:write'] };
    const pending = new PostgresPendingStore(principal);
    const audit = new PostgresAuditStore(principal);
    const id = randomUUID();
    await pending.put({
      id,
      provider: 'google',
      opHash: 'hash',
      op: { tool: 'test', provider: 'google', accountId: '1234567890', kind: 'update', payload: { status: 'PAUSED' } },
      preview: { summary: 'Pause campaign', changes: ['status ENABLED → PAUSED'], coercions: [], budgetDeltas: [], serverValidated: true },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await pending.get(id))?.opHash).toBe('hash');
    await audit.append({ event: 'validated', provider: 'google', tool: 'test', accountId: '1234567890', pendingId: id, summary: 'Pause campaign' });
    const events = await db()<Array<{ pendingId: string }>>`
      select pending_id from public.audit_events where organization_id = ${firstOrgId} and pending_id = ${id}
    `;
    expect(events).toHaveLength(1);
    await pending.delete(id);
    expect(await pending.get(id)).toBeUndefined();
  });

  it('administers tenant members and settings atomically with audit events', async () => {
    await db()`update public.organization_subscriptions set plan = 'operator', status = 'active' where organization_id = ${firstOrgId}`;
    const owner = { organizationId: firstOrgId, userId: firstUserId, role: 'owner' as const, scopes: [] };
    const invited = await inviteOrganizationMember(owner, secondEmail, 'member');
    expect(invited).toMatchObject({ added: true, invitationSent: false, targetUserId: secondUserId });
    expect((await listOrganizationMembers(firstOrgId)).map((member) => member.userId)).toContain(secondUserId);

    await changeOrganizationMemberRole(owner, secondUserId, 'viewer');
    const changed = await db()<Array<{ role: string }>>`
      select role from public.organization_memberships
      where organization_id = ${firstOrgId} and user_id = ${secondUserId}
    `;
    expect(changed[0]?.role).toBe('viewer');
    await expect(changeOrganizationMemberRole(owner, firstUserId, 'member')).rejects.toThrow('last owner');

    const updatedPolicy = { ...DEFAULT_POLICY, protected_accounts: ['protected-123'], pending_ttl_minutes: 8 };
    await updateOrganizationSettings(owner, updatedPolicy, 45);
    const settings = await db()<Array<{ policy: typeof updatedPolicy; dataRetentionDays: number }>>`
      select policy, data_retention_days from public.organization_settings where organization_id = ${firstOrgId}
    `;
    expect(settings[0]).toMatchObject({ policy: updatedPolicy, dataRetentionDays: 45 });

    await db()`
      insert into public.audit_events
        (organization_id, actor_user_id, event, provider, tool, account_id, summary, created_at)
      values
        (${firstOrgId}, ${firstUserId}, 'note', 'cloud', 'retention_test', '*', 'expired-retention-event', now() - interval '46 days'),
        (${firstOrgId}, ${firstUserId}, 'note', 'cloud', 'retention_test', '*', 'current-retention-event', now())
    `;
    await db()`select private.apply_data_retention()`;
    const retentionEvents = await db()<Array<{ summary: string }>>`
      select summary from public.audit_events
      where organization_id = ${firstOrgId} and tool = 'retention_test'
    `;
    expect(retentionEvents.map((event) => event.summary)).toEqual(['current-retention-event']);

    await removeOrganizationMember(owner, secondUserId);
    expect((await listOrganizationMembers(firstOrgId)).map((member) => member.userId)).not.toContain(secondUserId);
    const events = await db()<Array<{ event: string }>>`
      select event from public.audit_events
      where organization_id = ${firstOrgId}
        and event in ('member_invited', 'member_role_updated', 'member_removed', 'settings_updated')
      order by id asc
    `;
    expect(events.map((event) => event.event)).toEqual(['member_invited', 'member_role_updated', 'settings_updated', 'member_removed']);
  });

  it('enforces the two-step write contract with tenant-scoped Postgres stores', async () => {
    const principal = { organizationId: firstOrgId, userId: firstUserId, scopes: ['tools:write'] };
    const engine = new PolicyEngine(
      DEFAULT_POLICY,
      new PostgresPendingStore(principal),
      new PostgresAuditStore(principal),
    );
    const { ctx, registry } = await createContext({ includeMock: true, engine });
    const input = { account_id: 'mock-1', campaign_id: 'c1', status: 'PAUSED' as const };

    const preview = (await registry.call('mock_set_campaign_status', input, ctx)) as {
      status: string;
      pending_operation_id: string;
    };
    expect(preview.status).toBe('pending_validation');
    expect(await new PostgresPendingStore(principal).get(preview.pending_operation_id)).toBeDefined();

    const applied = (await registry.call(
      'mock_set_campaign_status',
      { ...input, pending_operation_id: preview.pending_operation_id },
      ctx,
    )) as { status: string };
    expect(applied.status).toBe('applied');
    expect(await new PostgresPendingStore(principal).get(preview.pending_operation_id)).toBeUndefined();

    const events = await db()<Array<{ event: string }>>`
      select event from public.audit_events
      where organization_id = ${firstOrgId} and pending_id = ${preview.pending_operation_id}
      order by created_at asc
    `;
    expect(events.map((event) => event.event)).toEqual(['validated', 'applied']);
  });
});
