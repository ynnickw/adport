import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { resourceSecretKey } from '@adport/core';
import { PostgresResourceSecretStore } from '@/lib/cloud/resource-credentials';
import { resolveMembership } from '@/lib/cloud/repository';
import { closeDbForTests, db } from '@/lib/db';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
describeDatabase('private resource credential database boundary', () => {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const projects: string[] = [], users: string[] = [];
  const scope = { provider: 'spotify', accountId: randomUUID(), businessId: randomUUID(), resourceId: randomUUID(), credentialId: randomUUID() };
  let sql: ReturnType<typeof postgres>, owner: PostgresResourceSecretStore, other: PostgresResourceSecretStore;
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname) || !['localhost', '127.0.0.1'].includes(new URL(process.env.SUPABASE_DB_URL!).hostname)) throw new Error('Resource credential tests require local Supabase.');
    sql = postgres(process.env.SUPABASE_DB_URL!, { max: 1, prepare: false });
    for (let index = 0; index < 2; index++) {
      const result = await admin.auth.admin.createUser({ email: `resource-vault-${randomUUID()}@example.test`, password: 'Local-Resource-Fixture-Passw0rd!', email_confirm: true });
      if (result.error || !result.data.user) throw result.error ?? new Error('Fixture user creation failed');
      users.push(result.data.user.id);projects.push((await resolveMembership(result.data.user.id)).organizationId);
    }
    const store = (index: number) => new PostgresResourceSecretStore({ organizationId: projects[index]!, userId: users[index]!, role: 'owner', scopes: ['tools:read', 'tools:write'] }, 'spotify', new Set([scope.accountId]));
    owner = store(0);other = store(1);
  });
  afterAll(async () => {
    if (projects.length) await db()`delete from public.organizations where id in ${db()(projects)}`;
    for (const user of users) await admin.auth.admin.deleteUser(user);
    await sql?.end({ timeout: 2 });await closeDbForTests();
  });
  it('separates projects and encrypts immutable credentials under concurrent writes', async () => {
    const results = await Promise.all([owner.putIfAbsent(scope, 'first-local-fixture'), owner.putIfAbsent(scope, 'second-local-fixture')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await owner.get(scope)).toBe(results[0] ? 'first-local-fixture' : 'second-local-fixture');
    expect(await other.get(scope)).toBeUndefined();expect(await other.has(scope)).toBe(false);expect(await other.delete(scope)).toBe(false);
    const rows = await sql`select ciphertext from private.provider_resource_credentials where organization_id = ${projects[0]!} and resource_key = ${resourceSecretKey(scope)}`;
    expect(rows).toHaveLength(1);expect(rows[0]!.ciphertext).not.toContain('local-fixture');
  });
  it('rejects ciphertext transplanted into another project and denies API roles at SQL level', async () => {
    await other.putIfAbsent(scope, 'other-local-fixture');
    await sql`update private.provider_resource_credentials set ciphertext = (select ciphertext from private.provider_resource_credentials where organization_id = ${projects[0]!} and resource_key = ${resourceSecretKey(scope)}) where organization_id = ${projects[1]!} and resource_key = ${resourceSecretKey(scope)}`;
    await expect(other.get(scope)).rejects.toThrow();
    const rows = await sql`select has_table_privilege('anon', 'private.provider_resource_credentials', 'select') as anon_read,
      has_table_privilege('authenticated', 'private.provider_resource_credentials', 'select') as member_read,
      has_table_privilege('authenticated', 'private.provider_resource_credentials', 'insert') as member_write,
      (select relrowsecurity from pg_class where oid = 'private.provider_resource_credentials'::regclass) as rls`;
    expect(rows[0]).toMatchObject({ anon_read: false, member_read: false, member_write: false, rls: true });
    expect(await owner.delete(scope)).toBe(true);expect(await owner.has(scope)).toBe(false);
  });
});
