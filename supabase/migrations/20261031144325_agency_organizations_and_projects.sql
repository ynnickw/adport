-- Existing tenant IDs remain project IDs, preserving OAuth grants, ciphertext
-- AAD, approvals and every existing provider/tool contract.
create table public.organization_groups (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 120),
  default_project_id uuid not null unique references public.organizations(id)
    on delete cascade deferrable initially deferred,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint organization_group_billing_anchor check (default_project_id = id)
);
create index organization_groups_created_by_idx on public.organization_groups (created_by);

alter table public.organizations
  add column organization_group_id uuid references public.organization_groups(id) on delete cascade,
  add column archived_at timestamptz;
create index organizations_group_idx on public.organizations (organization_group_id, created_at);

insert into public.organization_groups (id, name, default_project_id, created_by, created_at)
select id, name, id, created_by, created_at from public.organizations;
update public.organizations set organization_group_id = id;
alter table public.organizations alter column organization_group_id set not null;
-- Flush the backfill's deferred FK events before later ALTER TABLE statements.
set constraints organization_groups_default_project_id_fkey immediate;

create table public.organization_group_memberships (
  organization_group_id uuid not null references public.organization_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.organization_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_group_id, user_id)
);
create index organization_group_memberships_user_idx
  on public.organization_group_memberships (user_id, organization_group_id);
insert into public.organization_group_memberships (organization_group_id, user_id, role, created_at)
select organization_id, user_id, role, created_at from public.organization_memberships;

create function private.initialize_project_organization()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.organization_group_id is null then
    new.organization_group_id := new.id;
    insert into public.organization_groups (id, name, default_project_id, created_by)
      values (new.id, new.name, new.id, new.created_by);
  end if;
  return new;
end;
$$;
create trigger initialize_project_organization before insert on public.organizations
  for each row execute function private.initialize_project_organization();

create function private.register_project_member()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_group_memberships (organization_group_id, user_id, role)
    select project.organization_group_id, new.user_id,
      case when project.id = company.default_project_id and new.role = 'owner'
        and new.user_id = company.created_by then 'owner'::public.organization_role
        else 'member'::public.organization_role end
    from public.organizations project
    join public.organization_groups company on company.id = project.organization_group_id
    where project.id = new.organization_id
    on conflict (organization_group_id, user_id) do nothing;
  return new;
end;
$$;
create trigger register_project_member after insert on public.organization_memberships
  for each row execute function private.register_project_member();

-- Organization owners/admins inherit all projects. Other members receive only
-- explicit project grants, including client users restricted to one project.
create view private.project_memberships as
select distinct on (organization_id, user_id) organization_id, user_id, role, created_at
from (
  select member.organization_id, member.user_id, member.role, member.created_at
  from public.organization_memberships member
  join public.organizations project on project.id = member.organization_id
  where project.archived_at is null
  union all
  select project.id, member.user_id, member.role, member.created_at
  from public.organization_group_memberships member
  join public.organizations project on project.organization_group_id = member.organization_group_id
  where member.role in ('owner', 'admin') and project.archived_at is null
) access
order by organization_id, user_id,
  case role when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end;
revoke all on private.project_memberships from public, anon, authenticated;
grant select on private.project_memberships to adport_backend;

create function private.has_project_access(target_project uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.project_memberships
    where organization_id = target_project and user_id = (select auth.uid()));
$$;
revoke all on function private.has_project_access(uuid) from public, anon;
grant execute on function private.has_project_access(uuid) to authenticated, adport_backend;

-- Replace direct-membership SELECT policies with the effective project grant.
-- A single policy includes inherited admins without repeatedly checking RLS.
do $$
declare tenant_table record; old_policy record;
begin
  for tenant_table in
    select distinct tablename from pg_policies where schemaname = 'public'
      and tablename <> 'organization_memberships'
      and exists (select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = tablename and c.column_name = 'organization_id')
  loop
    for old_policy in select policyname from pg_policies where schemaname = 'public'
      and tablename = tenant_table.tablename and cmd = 'SELECT' and 'authenticated' = any(roles)
    loop
      execute format('drop policy %I on public.%I', old_policy.policyname, tenant_table.tablename);
    end loop;
    execute format('create policy project_access_select on public.%I for select to authenticated using (private.has_project_access(organization_id))', tenant_table.tablename);
  end loop;
end;
$$;
drop policy if exists organizations_select_member on public.organizations;
create policy project_access_select on public.organizations for select to authenticated
  using (private.has_project_access(id));

alter table public.organization_groups enable row level security;
alter table public.organization_group_memberships enable row level security;
revoke all on public.organization_groups, public.organization_group_memberships from anon, authenticated;
grant select on public.organization_groups, public.organization_group_memberships to authenticated;
grant select, insert, update, delete on public.organization_groups, public.organization_group_memberships to adport_backend;
create policy groups_select_member on public.organization_groups for select to authenticated
  using (exists (select 1 from public.organization_group_memberships member
    where member.organization_group_id = id and member.user_id = (select auth.uid())));
create policy group_memberships_select_self on public.organization_group_memberships for select to authenticated
  using (user_id = (select auth.uid()));
create policy groups_backend_all on public.organization_groups for all to adport_backend using (true) with check (true);
create policy group_memberships_backend_all on public.organization_group_memberships for all to adport_backend using (true) with check (true);

create or replace function private.organization_member_directory(target_organization_id uuid)
returns table(user_id uuid, email text, display_name text, role public.organization_role, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select member.user_id, auth_user.email::text, profile.display_name, member.role, member.created_at
  from private.project_memberships member
  join auth.users auth_user on auth_user.id = member.user_id
  join public.profiles profile on profile.user_id = member.user_id
  where member.organization_id = target_organization_id order by member.created_at;
$$;

create function private.organization_group_member_directory(target_group uuid)
returns table(user_id uuid, email text, display_name text, role public.organization_role, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select member.user_id, auth_user.email::text, profile.display_name, member.role, member.created_at
  from public.organization_group_memberships member
  join auth.users auth_user on auth_user.id = member.user_id
  join public.profiles profile on profile.user_id = member.user_id
  where member.organization_group_id = target_group order by member.created_at;
$$;
revoke all on function private.initialize_project_organization(), private.register_project_member(),
  private.organization_group_member_directory(uuid) from public, anon, authenticated;
grant execute on function private.organization_group_member_directory(uuid) to adport_backend;

create function private.protect_default_project()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.organization_group_id <> old.organization_group_id then
      raise exception 'Projects cannot be moved between organizations.';
    end if;
  end if;
  if exists (select 1 from public.organization_groups company where company.default_project_id = old.id) then
    if tg_op = 'UPDATE' and new.archived_at is not null then
      raise exception 'The default project cannot be archived.';
    elsif tg_op = 'DELETE' and exists (select 1 from public.organizations sibling
      where sibling.organization_group_id = old.organization_group_id and sibling.id <> old.id) then
      raise exception 'Delete or archive client projects before deleting the organization.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger protect_default_project before delete or update of archived_at, organization_group_id on public.organizations
  for each row execute function private.protect_default_project();
revoke all on function private.protect_default_project() from public, anon, authenticated;

create function private.enforce_organization_capacity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare company_id uuid; allowed_count integer; used_count integer; allowed_plan public.cloud_plan;
begin
  if tg_table_name = 'organization_ad_accounts' then
    if not new.enabled then return new; end if;
    select organization_group_id into company_id from public.organizations where id = new.organization_id and archived_at is null;
    if company_id is null then raise exception 'Archived projects cannot enable agent account access.' using errcode = '23514'; end if;
  else
    company_id := new.organization_group_id;
  end if;
  perform 1 from public.organization_groups where id = company_id for update;
  select case when subscription.status not in ('active', 'trialing', 'past_due') then 'reader'::public.cloud_plan
    else subscription.plan end into strict allowed_plan
    from public.organization_groups company join public.organization_subscriptions subscription
      on subscription.organization_id = company.default_project_id where company.id = company_id;
  if tg_table_name = 'organization_ad_accounts' then
    allowed_count := case allowed_plan when 'reader' then 3 when 'operator' then 5 when 'premium' then 15 when 'agency' then 40 else null end;
    select count(*) into used_count from public.organization_ad_accounts account
      join public.organizations project on project.id = account.organization_id
      where project.organization_group_id = company_id and project.archived_at is null and account.enabled;
    if allowed_count is not null and used_count > allowed_count then
      raise exception 'Organization active account limit reached. Disable an account in another project or upgrade.' using errcode = '23514';
    end if;
  else
    allowed_count := case allowed_plan when 'reader' then 1 when 'operator' then 2 when 'premium' then 5 when 'agency' then 15 else null end;
    select count(*) into used_count from public.organization_group_memberships where organization_group_id = company_id;
    if allowed_count is not null and used_count > allowed_count then
      raise exception 'Organization member limit reached. Remove a member or upgrade.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger enforce_organization_accounts after insert or update of enabled on public.organization_ad_accounts
  for each row execute function private.enforce_organization_capacity();
create trigger enforce_organization_members after insert on public.organization_group_memberships
  for each row execute function private.enforce_organization_capacity();
revoke all on function private.enforce_organization_capacity() from public, anon, authenticated;
