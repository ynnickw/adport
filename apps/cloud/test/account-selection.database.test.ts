import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, closeDbForTests } from '@/lib/db';
import { resetEnvForTests } from '@/lib/env';
import { getAccountSelection, saveAccountSelection, stageAccountSelection } from '@/lib/cloud/account-selection';
import { listOrganizationAdAccounts, loadEnabledAccountIds, loadProviderCredentials, setOrganizationAdAccountEnabled, upsertProviderConnection } from '@/lib/cloud/repository';
import type { TenantPrincipal } from '@/lib/cloud/types';

const databaseUrl = process.env.ADPORT_SELECTION_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('one-time provider account selection (local database)', () => {
  let admin: ReturnType<typeof postgres>;
  let principal: TenantPrincipal;
  let other: TenantPrincipal;
  const users: string[] = [];
  let id: string;
  let connectionId: string;
  const accounts = [{ provider: 'google', id: 'chosen', name: 'Chosen account', currency: 'EUR' }, { provider: 'google', id: 'excluded', name: 'Do not import' }];

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '55322') throw new Error('Selection tests require the explicit local Adport database on port 55322.');
    process.env.SUPABASE_DB_URL = databaseUrl;
    resetEnvForTests();
    admin = postgres(databaseUrl!, { max: 1 });
    for (let i = 0; i < 2; i++) {
      const userId = randomUUID(); users.push(userId);
      await admin`insert into auth.users (id, email, raw_user_meta_data) values (${userId}, ${`selection-${userId}@example.test`}, '{}'::jsonb)`;
      const [membership] = await admin`select organization_id from public.organization_memberships where user_id = ${userId}`;
      const value: TenantPrincipal = { organizationId: membership!.organization_id, userId, role: 'owner', scopes: [] };
      if (i === 0) principal = value; else other = value;
    }
  });
  afterAll(async () => {
    if (!admin) return;
    for (const userId of users) {
      await admin`delete from public.organizations where id in (select organization_id from public.organization_memberships where user_id = ${userId})`;
      await admin`delete from auth.users where id = ${userId}`;
    }
    await closeDbForTests(); await admin.end();
  });
  beforeEach(async () => {
    await db()`delete from public.connections where organization_id = ${principal.organizationId} and provider = 'google'`;
    id = randomUUID();
    connectionId = await upsertProviderConnection({ organizationId: principal.organizationId, userId: principal.userId!, provider: 'google', credential: { refreshToken: 'fixture-only' }, selectionId: id });
    await stageAccountSelection({ principal, id, connectionId, provider: 'google', accounts, returnPath: '/dashboard/accounts?select_provider=google' });
  });

  it('keeps discovered accounts private and disables runtime access until saved', async () => {
    expect(await listOrganizationAdAccounts(principal.organizationId)).toEqual([]);
    expect(await loadEnabledAccountIds(principal.organizationId)).toEqual({});
    expect(await loadProviderCredentials(principal.organizationId)).toEqual({});
    expect(await loadProviderCredentials(principal.organizationId, true)).toHaveProperty('google');
    expect((await getAccountSelection(principal, id))?.accounts).toEqual(accounts);
    const [row] = await admin`select ciphertext from private.provider_account_selections where id = ${id}`;
    expect(row!.ciphertext).not.toContain('Do not import');
  });

  it('saves only the selected subset, removes the snapshot and rejects replay', async () => {
    expect(await saveAccountSelection(principal, id, ['chosen'])).toMatchObject({ count: 1, returnPath: '/dashboard/accounts?select_provider=google&accounts_saved=google' });
    expect(await listOrganizationAdAccounts(principal.organizationId)).toMatchObject([{ accountId: 'chosen', enabled: false }]);
    expect(await getAccountSelection(principal, id)).toBeUndefined();
    expect(await admin`select id from private.provider_account_selections where id = ${id}`).toHaveLength(0);
    await expect(saveAccountSelection(principal, id, ['excluded'])).rejects.toThrow(/expired or was already saved/);
    await expect(setOrganizationAdAccountEnabled({ principal, provider: 'google', accountId: 'excluded', enabled: true, maxActiveAccounts: 3, currentPlan: 'Reader', recommendedPlan: 'operator' })).rejects.toThrow(/not found/);
  });

  it('rejects foreign organizations, other users and non-admins', async () => {
    expect(await getAccountSelection(other, id)).toBeUndefined();
    expect(await getAccountSelection({ ...principal, userId: other.userId }, id)).toBeUndefined();
    await expect(saveAccountSelection(other, id, ['chosen'])).rejects.toThrow(/expired/);
    await expect(saveAccountSelection({ ...principal, userId: other.userId }, id, ['chosen'])).rejects.toThrow(/expired/);
    await expect(saveAccountSelection({ ...principal, role: 'member' }, id, ['chosen'])).rejects.toThrow(/Owner or admin/);
    await expect(getAccountSelection({ ...principal, role: 'viewer' }, id)).rejects.toThrow(/Owner or admin/);
    expect(await getAccountSelection(principal, id)).toBeDefined();
  });

  it('rejects fabricated IDs and duplicates without partially saving', async () => {
    for (const values of [['chosen', 'fabricated'], ['chosen', 'chosen']]) {
      await expect(saveAccountSelection(principal, id, values)).rejects.toThrow(/Only accounts returned/);
      expect(await listOrganizationAdAccounts(principal.organizationId)).toEqual([]);
      expect(await getAccountSelection(principal, id)).toBeDefined();
    }
  });

  it('expires the picker and requires reauthorization', async () => {
    await admin`update private.provider_account_selections set expires_at = now() - interval '1 second' where id = ${id}`;
    expect(await getAccountSelection(principal, id)).toBeUndefined();
    await expect(saveAccountSelection(principal, id, ['chosen'])).rejects.toThrow(/expired/);
  });

  it('invalidates old selections on reauthorization and preserves selected active access', async () => {
    await saveAccountSelection(principal, id, ['chosen']);
    await setOrganizationAdAccountEnabled({ principal, provider: 'google', accountId: 'chosen', enabled: true, maxActiveAccounts: 3, currentPlan: 'Reader', recommendedPlan: 'operator' });
    const nextId = randomUUID();
    await upsertProviderConnection({ organizationId: principal.organizationId, userId: principal.userId!, provider: 'google', credential: { refreshToken: 'next-fixture' }, selectionId: nextId });
    expect(await loadEnabledAccountIds(principal.organizationId)).toEqual({});
    await expect(stageAccountSelection({ principal, id, connectionId, provider: 'google', accounts, returnPath: '/dashboard/accounts' })).rejects.toThrow(/replaced/);
    await stageAccountSelection({ principal, id: nextId, connectionId, provider: 'google', accounts, returnPath: '/onboarding' });
    await saveAccountSelection(principal, nextId, ['chosen']);
    expect((await loadEnabledAccountIds(principal.organizationId)).google).toEqual(new Set(['chosen']));
  });

  it('supports selecting none and removes previously added accounts', async () => {
    await saveAccountSelection(principal, id, ['chosen']);
    const nextId = randomUUID();
    await upsertProviderConnection({ organizationId: principal.organizationId, userId: principal.userId!, provider: 'google', credential: { refreshToken: 'next-fixture' }, selectionId: nextId });
    await stageAccountSelection({ principal, id: nextId, connectionId, provider: 'google', accounts, returnPath: '/dashboard/accounts' });
    await saveAccountSelection(principal, nextId, []);
    expect(await listOrganizationAdAccounts(principal.organizationId)).toEqual([]);
    const [connection] = await admin`select external_label, external_subject, account_selection_id from public.connections where id = ${connectionId}`;
    expect(connection).toMatchObject({ external_label: '0 added Google Ads account(s)', external_subject: null, account_selection_id: null });
  });

  it('serializes concurrent saves so a snapshot can be consumed only once', async () => {
    const results = await Promise.allSettled([saveAccountSelection(principal, id, ['chosen']), saveAccountSelection(principal, id, ['excluded'])]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await listOrganizationAdAccounts(principal.organizationId)).toHaveLength(1);
  });

  it('denies direct snapshot reads to browser database roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      await expect(admin.begin(async sql => {
        await sql.unsafe(`set local role ${role}`);
        await sql`select * from private.provider_account_selections`;
      })).rejects.toMatchObject({ code: '42501' });
    }
  });
});
