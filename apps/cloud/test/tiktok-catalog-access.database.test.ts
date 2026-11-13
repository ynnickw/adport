import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { catalogGrant, creationScope, requireCatalogAccess } from '@adport/provider-tiktok';
import { PostgresTikTokCatalogAccessStore } from '@/lib/cloud/tiktok-catalog-access';

const mocks = vi.hoisted(() => ({ backend: undefined as unknown }));
vi.mock('@/lib/db', () => ({ db: () => mocks.backend }));
const database = process.env.ADPORT_CATALOG_DISPOSABLE_DB_URL;
const describeDatabase = database ? describe : describe.skip;

describeDatabase('disposable Postgres catalog authorization', () => {
  let admin: ReturnType<typeof postgres>, backend: ReturnType<typeof postgres>, owner: PostgresTikTokCatalogAccessStore, other: PostgresTikTokCatalogAccessStore;
  const projects = [randomUUID(), randomUUID()], connections = [randomUUID(), randomUUID()];
  const scope = { accountId: '7111000000000000001', businessId: '111', resourceId: '222', kind: 'catalog' as const };
  beforeAll(async () => {
    const target = new URL(database!);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !/^\/adport_catalog_scope_qa(?:_[a-f0-9]+)?$/.test(target.pathname) || process.env.ADPORT_CATALOG_DISPOSABLE_DB !== '1') throw new Error('This test requires an explicitly created disposable catalog-scope database.');
    admin = postgres(database!, { max: 2, prepare: false, transform: { column: postgres.camel.column } });
    await admin.unsafe(`create schema private;
      do $$ begin if not exists(select 1 from pg_roles where rolname = 'adport_backend') then create role adport_backend nologin; end if; end $$;
      do $$ begin if not exists(select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; end $$;
      do $$ begin if not exists(select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$;
      grant adport_backend to postgres;
      create table public.organizations(id uuid primary key);
      create table public.connections(id uuid primary key, status text not null, account_selection_id uuid);
      create table public.organization_ad_accounts(organization_id uuid not null references public.organizations(id), provider text not null, account_id text not null, connection_id uuid not null references public.connections(id), enabled boolean not null, primary key(organization_id, provider, account_id));
      grant usage on schema private, public to adport_backend;
      grant select, update on public.organizations, public.connections, public.organization_ad_accounts to adport_backend;`);
    const migration = await readFile(resolve(import.meta.dirname, '../../../supabase/migrations/20261105103646_tiktok_catalog_project_access.sql'), 'utf8');await admin.unsafe(migration);
    for (let index = 0; index < projects.length; index++) {
      await admin`insert into public.organizations(id) values(${projects[index]!})`;
      await admin`insert into public.connections(id, status) values(${connections[index]!}, 'connected')`;
      await admin`insert into public.organization_ad_accounts(organization_id, provider, account_id, connection_id, enabled) values(${projects[index]!}, 'tiktok', ${scope.accountId}, ${connections[index]!}, true)`;
    }
    backend = postgres(database!, { max: 4, prepare: false, connection: { role: 'adport_backend' }, transform: { column: postgres.camel.column } });mocks.backend = backend;
    const store = (index: number) => new PostgresTikTokCatalogAccessStore({ organizationId: projects[index]!, userId: randomUUID(), role: 'owner', scopes: ['tools:read', 'tools:write', 'connections:manage'] }, new Set([scope.accountId]), true);
    owner = store(0);other = store(1);
  });
  afterEach(async () => {
    if (!admin) return;
    await admin`update public.organization_ad_accounts set enabled = true`;
    await admin`update public.connections set status = 'connected', account_selection_id = null`;
  });
  afterAll(async () => { await backend?.end({ timeout: 2 });await admin?.end({ timeout: 2 }); });

  it('isolates projects sharing the same native advertiser and preserves immutable scope hashes', async () => {
    const absent = await owner.get(scope);expect(absent).toEqual(catalogGrant(scope));
    const selected = await owner.compareAndSet(scope, absent.hash, 'read');expect(selected).toMatchObject({ mode: 'read', revision: 1 });expect(await other.get(scope)).toEqual(catalogGrant(scope));expect(await other.list(scope.accountId)).toEqual([]);
    expect((await owner.list(scope.accountId))[0]).toEqual(selected);expect((await owner.get({ ...scope, businessId: '999' })).mode).toBe('none');expect((await owner.get({ ...scope, resourceId: '999' })).mode).toBe('none');
  });
  it('serializes concurrent updates and rejects stale approvals instead of overwriting', async () => {
    const target = { ...scope, resourceId: '223' }, before = await owner.get(target);
    const result = await Promise.allSettled([owner.compareAndSet(target, before.hash, 'read'), owner.compareAndSet(target, before.hash, 'write')]);expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);expect((await owner.get(target)).revision).toBe(1);
    await expect(owner.compareAndSet(target, before.hash, 'none')).rejects.toThrow('changed');expect((await owner.get(target)).revision).toBe(1);
  });
  it('permits revocation on disabled/disconnected accounts and denies native access or new grants', async () => {
    const target = { ...scope, resourceId: '224' }, before = await owner.get(target);await owner.compareAndSet(target, before.hash, 'write');
    await admin`update public.organization_ad_accounts set enabled = false where organization_id = ${projects[0]!}`;await admin`update public.connections set status = 'revoked' where id = ${connections[0]!}`;
    const observed = await owner.get(target);expect(observed.mode).toBe('write');await expect(requireCatalogAccess(owner, target)).rejects.toThrow('disabled, disconnected');
    const revoked = await owner.compareAndSet(target, observed.hash, 'none');expect(revoked).toMatchObject({ mode: 'none', revision: 2 });await expect(owner.compareAndSet(target, revoked.hash, 'read')).rejects.toThrow('disabled, disconnected');
  });
  it('enforces private-schema privileges and RLS and refuses malformed/cross-account grants', async () => {
    const checks = await admin`select has_table_privilege('anon', 'private.tiktok_catalog_access', 'select') as anon_read,
      has_table_privilege('authenticated', 'private.tiktok_catalog_access', 'select') as authenticated_read,
      has_table_privilege('adport_backend', 'private.tiktok_catalog_access', 'select') as backend_read,
      has_table_privilege('adport_backend', 'private.tiktok_catalog_access', 'delete') as backend_delete,
      (select relrowsecurity from pg_class where oid = 'private.tiktok_catalog_access'::regclass) as rls`;
    expect(checks[0]).toMatchObject({ anonRead: false, authenticatedRead: false, backendRead: true, backendDelete: false, rls: true });
    await expect(admin.begin(sql => sql.unsafe('set local role authenticated; select * from private.tiktok_catalog_access'))).rejects.toMatchObject({ code: '42501' });
    await expect(admin`insert into private.tiktok_catalog_access(organization_id, account_id, business_id, resource_kind, resource_id, access_mode) values(${projects[0]!}, ${scope.accountId}, '111', 'catalog', '999', 'create')`).rejects.toMatchObject({ code: '23514' });
    await expect(admin`insert into private.tiktok_catalog_access(organization_id, account_id, business_id, resource_kind, resource_id, access_mode) values(${projects[0]!}, '999', '111', 'catalog', '999', 'read')`).rejects.toMatchObject({ code: '23503' });
  });
  const agent = (scopes = ['tools:read', 'tools:write']) => new PostgresTikTokCatalogAccessStore({ organizationId: projects[0]!, apiKeyId: randomUUID(), role: 'member', scopes }, new Set([scope.accountId]));
  it('adopts an exact new catalog under creation delegation without granting the agent permission administration', async () => {
    const parent = creationScope(scope.accountId, '301'), current = await owner.get(parent), delegated = await owner.compareAndSet(parent, current.hash, 'create'), target = { ...scope, businessId: '301', resourceId: '302' };
    expect(agent().canManage).toBe(false);const result = await agent().adoptCreated(target, delegated.hash);expect(result).toMatchObject({ mode: 'write', revision: 1 });expect(await owner.get(target)).toEqual(result);expect((await other.get(target)).mode).toBe('none');
    await expect(agent().compareAndSet(parent, delegated.hash, 'none')).rejects.toThrow('signed-in');await expect(agent().adoptCreated(target, delegated.hash)).rejects.toThrow('owner decision');await owner.compareAndSet(parent, delegated.hash, 'none');expect((await agent().get(target)).mode).toBe('write');
  });
  it('refuses stale, foreign, readonly and disabled creation adoption and preserves child owner decisions', async () => {
    const parent = creationScope(scope.accountId, '310'), delegated = await owner.compareAndSet(parent, (await owner.get(parent)).hash, 'create'), target = { ...scope, businessId: '310', resourceId: '311' };
    await expect(agent(['tools:read']).adoptCreated(target, delegated.hash)).rejects.toThrow('writable');await expect(agent().adoptCreated({ ...target, businessId: '999' }, delegated.hash)).rejects.toThrow('delegation changed');
    const child = await owner.compareAndSet(target, (await owner.get(target)).hash, 'none');await expect(agent().adoptCreated(target, delegated.hash)).rejects.toThrow('owner decision');expect(await owner.get(target)).toEqual(child);
    await admin`update public.organization_ad_accounts set enabled = false where organization_id = ${projects[0]!}`;await expect(agent().adoptCreated({ ...target, resourceId: '312' }, delegated.hash)).rejects.toThrow('disabled, disconnected');
  });
  it('serializes revocation ahead of a waiting adoption and rechecks the delegation inside its transaction', async () => {
    const parent = creationScope(scope.accountId, '320'), delegated = await owner.compareAndSet(parent, (await owner.get(parent)).hash, 'create'), target = { ...scope, businessId: '320', resourceId: '321' };let revocation!: Promise<unknown>, adoption!: Promise<unknown>;
    await admin.begin(async sql => {
      await sql`select account_id from public.organization_ad_accounts where organization_id = ${projects[0]!} for update`;
      revocation = owner.compareAndSet(parent, delegated.hash, 'none');
      await vi.waitFor(async () => { const rows = await admin`select pid from pg_stat_activity where usename = 'postgres' and application_name = 'postgres.js' and wait_event_type = 'Lock'`;expect(rows.length).toBeGreaterThan(0); });
      adoption = agent().adoptCreated(target, delegated.hash);void adoption.catch(() => {});
      await vi.waitFor(async () => { const rows = await admin`select pid from pg_stat_activity where application_name = 'postgres.js' and wait_event_type = 'Lock'`;expect(rows.length).toBeGreaterThan(1); });
    });
    await revocation;await expect(adoption).rejects.toThrow('delegation changed');expect((await owner.get(target)).mode).toBe('none');
  });
  it('removes catalog grants when their imported advertiser is removed', async () => {
    const target = { ...scope, resourceId: '225' }, current = await other.get(target);await other.compareAndSet(target, current.hash, 'read');await admin`delete from public.organization_ad_accounts where organization_id = ${projects[1]!}`;
    const rows = await admin`select * from private.tiktok_catalog_access where organization_id = ${projects[1]!}`;expect(rows).toHaveLength(0);
  });
});
