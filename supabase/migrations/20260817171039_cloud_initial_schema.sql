create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'adport_backend') then
    create role adport_backend nologin noinherit;
  end if;
end
$$;
grant adport_backend to postgres;

create type public.organization_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.connection_status as enum ('connected', 'error', 'revoked');
create type public.deletion_status as enum ('requested', 'processing', 'completed', 'failed');

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organizations_created_by_idx on public.organizations (created_by);

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.organization_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_memberships_user_id_idx
  on public.organization_memberships (user_id, organization_id);

create table public.organization_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  policy jsonb not null default '{"require_validation":true,"paused_creation":true,"max_budget_delta_pct":25,"max_daily_budget_micros":null,"protected_accounts":[],"pending_ttl_minutes":15}'::jsonb,
  data_retention_days integer not null default 90 check (data_retention_days between 1 and 3650),
  updated_at timestamptz not null default now()
);

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit')),
  status public.connection_status not null default 'connected',
  external_subject text,
  external_label text,
  scopes text[] not null default '{}',
  connected_by uuid not null references auth.users(id),
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  last_error text,
  revoked_at timestamptz,
  unique (organization_id, provider),
  unique (id, organization_id, provider)
);

create index connections_organization_id_idx on public.connections (organization_id, connected_at desc);
create index connections_connected_by_idx on public.connections (connected_by);

create table private.provider_credentials (
  connection_id uuid primary key,
  organization_id uuid not null,
  provider text not null check (provider in ('google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit')),
  ciphertext text not null,
  key_version integer not null default 1 check (key_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, organization_id, provider)
    references public.connections(id, organization_id, provider) on delete cascade
);

create index provider_credentials_organization_provider_idx
  on private.provider_credentials (organization_id, provider);
create index provider_credentials_connection_tenant_provider_idx
  on private.provider_credentials (connection_id, organization_id, provider);

create table private.oauth_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit')),
  state_hash text not null unique,
  verifier_ciphertext text not null,
  return_path text not null default '/dashboard' check (return_path ~ '^/[^/]'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);

create index oauth_transactions_active_idx
  on private.oauth_transactions (state_hash, expires_at)
  where consumed_at is null;
create index oauth_transactions_organization_id_idx on private.oauth_transactions (organization_id);
create index oauth_transactions_user_id_idx on private.oauth_transactions (user_id);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  key_prefix text not null,
  secret_hash text not null unique,
  scopes text[] not null default array['tools:read', 'tools:write']::text[]
    check (cardinality(scopes) > 0 and scopes <@ array['tools:read', 'tools:write']::text[]),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_keys_active_prefix_idx on public.api_keys (key_prefix)
  where revoked_at is null;
create index api_keys_organization_id_idx on public.api_keys (organization_id);
create index api_keys_created_by_idx on public.api_keys (created_by);

create table public.pending_operations (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  operation_hash text not null,
  operation jsonb not null,
  preview jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);

create index pending_operations_active_idx
  on public.pending_operations (organization_id, expires_at)
  where consumed_at is null;
create index pending_operations_created_by_idx on public.pending_operations (created_by)
  where created_by is not null;

create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  api_key_id uuid references public.api_keys(id) on delete set null,
  event text not null check (event in (
    'validated', 'applied', 'rejected', 'note', 'connected', 'revoked',
    'api_key_created', 'api_key_revoked', 'member_invited', 'member_role_updated',
    'member_removed', 'settings_updated', 'deletion_requested'
  )),
  provider text not null,
  tool text not null,
  account_id text not null,
  pending_id uuid,
  summary text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_org_created_idx
  on public.audit_events (organization_id, created_at desc, id desc);
create index audit_events_pending_id_idx on public.audit_events (pending_id) where pending_id is not null;
create index audit_events_actor_user_id_idx on public.audit_events (actor_user_id)
  where actor_user_id is not null;
create index audit_events_api_key_id_idx on public.audit_events (api_key_id)
  where api_key_id is not null;

create table private.rate_limit_buckets (
  subject_hash text not null,
  window_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (subject_hash, window_start)
);

create table public.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  status public.deletion_status not null default 'requested',
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  error text
);

create index deletion_requests_org_requested_idx
  on public.deletion_requests (organization_id, requested_at desc);
create index deletion_requests_requested_by_idx on public.deletion_requests (requested_by)
  where requested_by is not null;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger organizations_set_updated_at before update on public.organizations
  for each row execute function private.set_updated_at();
create trigger organization_settings_set_updated_at before update on public.organization_settings
  for each row execute function private.set_updated_at();
create trigger provider_credentials_set_updated_at before update on private.provider_credentials
  for each row execute function private.set_updated_at();

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization_uuid uuid := gen_random_uuid();
  base_name text := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1), 'My organization');
  base_slug text := lower(regexp_replace(coalesce(split_part(new.email, '@', 1), 'adport'), '[^a-z0-9]+', '-', 'g'));
begin
  insert into public.profiles (user_id, display_name) values (new.id, left(base_name, 120));
  insert into public.organizations (id, name, slug, created_by)
    values (organization_uuid, left(base_name || '''s organization', 120), left(trim(both '-' from base_slug), 48) || '-' || substr(organization_uuid::text, 1, 8), new.id);
  insert into public.organization_memberships (organization_id, user_id, role)
    values (organization_uuid, new.id, 'owner');
  insert into public.organization_settings (organization_id) values (organization_uuid);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.organization_settings enable row level security;
alter table public.connections enable row level security;
alter table public.api_keys enable row level security;
alter table public.pending_operations enable row level security;
alter table public.audit_events enable row level security;
alter table public.deletion_requests enable row level security;

create policy profiles_select_self on public.profiles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy profiles_update_self on public.profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy memberships_select_self on public.organization_memberships for select to authenticated
  using ((select auth.uid()) = user_id);

create policy organizations_select_member on public.organizations for select to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organizations.id
      and membership.user_id = (select auth.uid())
  ));

create policy organization_settings_select_member on public.organization_settings for select to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organization_settings.organization_id
      and membership.user_id = (select auth.uid())
  ));
create policy organization_settings_update_admin on public.organization_settings for update to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organization_settings.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('owner', 'admin')
  ))
  with check (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organization_settings.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('owner', 'admin')
  ));

create policy connections_select_member on public.connections for select to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = connections.organization_id
      and membership.user_id = (select auth.uid())
  ));

-- These tables are intentionally server-only. Explicit deny policies document
-- that boundary and keep PostgREST closed even if a grant is added accidentally.
create policy api_keys_server_only on public.api_keys as restrictive for all to authenticated
  using (false) with check (false);
create policy pending_operations_server_only on public.pending_operations as restrictive for all to authenticated
  using (false) with check (false);

create policy audit_events_select_member on public.audit_events for select to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = audit_events.organization_id
      and membership.user_id = (select auth.uid())
  ));

create policy deletion_requests_select_member on public.deletion_requests for select to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = deletion_requests.organization_id
      and membership.user_id = (select auth.uid())
  ));

create policy profiles_backend_all on public.profiles for all to adport_backend using (true) with check (true);
create policy organizations_backend_all on public.organizations for all to adport_backend using (true) with check (true);
create policy memberships_backend_all on public.organization_memberships for all to adport_backend using (true) with check (true);
create policy organization_settings_backend_all on public.organization_settings for all to adport_backend using (true) with check (true);
create policy connections_backend_all on public.connections for all to adport_backend using (true) with check (true);
create policy api_keys_backend_all on public.api_keys for all to adport_backend using (true) with check (true);
create policy pending_operations_backend_all on public.pending_operations for all to adport_backend using (true) with check (true);
create policy audit_events_backend_all on public.audit_events for all to adport_backend using (true) with check (true);
create policy deletion_requests_backend_all on public.deletion_requests for all to adport_backend using (true) with check (true);

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.organizations, public.organization_memberships, public.connections, public.audit_events, public.deletion_requests to authenticated;
grant select, update on public.organization_settings to authenticated;

revoke all on public.api_keys, public.pending_operations from anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant usage on schema public, private to adport_backend;
grant select, insert, update, delete on all tables in schema public to adport_backend;
grant select, insert, update, delete on all tables in schema private to adport_backend;
grant usage, select on all sequences in schema public, private to adport_backend;

create or replace function private.find_auth_user_id(target_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(target_email) limit 1
$$;

create or replace function private.organization_member_directory(target_organization_id uuid)
returns table (user_id uuid, email text, display_name text, role public.organization_role, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select membership.user_id, auth_user.email::text, profile.display_name, membership.role, membership.created_at
  from public.organization_memberships membership
  join auth.users auth_user on auth_user.id = membership.user_id
  join public.profiles profile on profile.user_id = membership.user_id
  where membership.organization_id = target_organization_id
  order by membership.created_at asc
$$;

revoke all on function private.find_auth_user_id(text) from public, anon, authenticated;
revoke all on function private.organization_member_directory(uuid) from public, anon, authenticated;
grant execute on function private.find_auth_user_id(text) to adport_backend;
grant execute on function private.organization_member_directory(uuid) to adport_backend;

create extension if not exists pg_cron with schema pg_catalog;

create or replace function private.apply_data_retention()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.audit_events event
  using public.organization_settings setting
  where event.organization_id = setting.organization_id
    and event.created_at < now() - make_interval(days => setting.data_retention_days);

  delete from public.pending_operations operation
  using public.organization_settings setting
  where operation.organization_id = setting.organization_id
    and coalesce(operation.consumed_at, operation.expires_at)
      < now() - make_interval(days => setting.data_retention_days);

  delete from public.deletion_requests request
  using public.organization_settings setting
  where request.organization_id = setting.organization_id
    and request.requested_at < now() - make_interval(days => setting.data_retention_days);

  delete from private.oauth_transactions
  where expires_at < now() - interval '1 day';

  delete from private.rate_limit_buckets
  where window_start < now() - interval '1 hour';
end;
$$;

revoke all on function private.apply_data_retention() from public, anon, authenticated;
grant execute on function private.apply_data_retention() to adport_backend;
select cron.schedule('adport-data-retention', '17 3 * * *', 'select private.apply_data_retention()');
