-- Stable plan IDs retain existing subscriptions. Only current quotas and free viewers change.
create function private.organization_editing_member_count(target_company uuid)
returns bigint language sql volatile security definer set search_path = '' as $$
  select count(*) from public.organization_group_memberships member
  where member.organization_group_id = target_company and (
    member.role <> 'viewer' or exists (
      select 1 from public.organization_memberships access
      join public.organizations project on project.id = access.organization_id
      where project.organization_group_id = target_company and access.user_id = member.user_id and access.role <> 'viewer'
    )
  );
$$;
revoke all on function private.organization_editing_member_count(uuid) from public, anon, authenticated;
grant execute on function private.organization_editing_member_count(uuid) to adport_backend;

create or replace function private.enforce_organization_capacity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare company_id uuid; allowed_count integer; used_count integer; allowed_plan public.cloud_plan;
begin
  if tg_table_name = 'organization_ad_accounts' then
    if not new.enabled then return new; end if;
    select organization_group_id into company_id from public.organizations where id = new.organization_id and archived_at is null;
    if company_id is null then raise exception 'Archived projects cannot enable agent account access.' using errcode = '23514'; end if;
  else
    if new.role = 'viewer' then return new; end if;
    if tg_op = 'UPDATE' and old.role <> 'viewer' then return new; end if;
    company_id := new.organization_group_id;
  end if;
  perform 1 from public.organization_groups where id = company_id for update;
  select case when subscription.status not in ('active', 'trialing', 'past_due') then 'reader'::public.cloud_plan
    else subscription.plan end into strict allowed_plan
    from public.organization_groups company join public.organization_subscriptions subscription
      on subscription.organization_id = company.default_project_id where company.id = company_id;
  if tg_table_name = 'organization_ad_accounts' then
    allowed_count := case allowed_plan when 'reader' then 3 when 'operator' then 5 when 'premium' then 20 when 'agency' then 60 else null end;
    select count(*) into used_count from public.organization_ad_accounts account
      join public.organizations project on project.id = account.organization_id
      where project.organization_group_id = company_id and project.archived_at is null and account.enabled;
    if allowed_count is not null and used_count > allowed_count then
      raise exception 'Organization active account limit reached. Disable an account in another project or upgrade.' using errcode = '23514';
    end if;
  else
    allowed_count := case allowed_plan when 'reader' then 1 when 'operator' then 2 when 'premium' then 5 when 'agency' then 15 else null end;
    used_count := private.organization_editing_member_count(company_id);
    if allowed_count is not null and used_count > allowed_count then
      raise exception 'Organization member limit reached. Upgrade to add editing members; read-only viewers are free.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger enforce_organization_members on public.organization_group_memberships;
create trigger enforce_organization_members after insert or update of role on public.organization_group_memberships
  for each row execute function private.enforce_organization_capacity();

-- Project invitations and role changes must use the same company-wide seat gate.
create or replace function private.register_project_member()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_project uuid; target_user uuid; company_id uuid; creator uuid; default_project uuid; editing boolean;
begin
  if tg_op = 'DELETE' then target_project := old.organization_id; target_user := old.user_id;
  else target_project := new.organization_id; target_user := new.user_id; end if;
  select project.organization_group_id into company_id from public.organizations project where project.id = target_project;
  if company_id is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  select company.created_by, company.default_project_id into creator, default_project
    from public.organization_groups company where company.id = company_id for update;
  if tg_op <> 'DELETE' then
    insert into public.organization_group_memberships (organization_group_id, user_id, role)
      values (company_id, target_user, case
        when target_project = default_project and new.role = 'owner' and target_user = creator then 'owner'::public.organization_role
        when new.role = 'viewer' then 'viewer'::public.organization_role else 'member'::public.organization_role end)
      on conflict (organization_group_id, user_id) do nothing;
  end if;
  select exists (select 1 from public.organization_memberships access
    join public.organizations project on project.id = access.organization_id
    where project.organization_group_id = company_id and access.user_id = target_user and access.role <> 'viewer') into editing;
  update public.organization_group_memberships set role = case when editing then 'member'::public.organization_role else 'viewer'::public.organization_role end
    where organization_group_id = company_id and user_id = target_user and role not in ('owner', 'admin')
      and role <> case when editing then 'member'::public.organization_role else 'viewer'::public.organization_role end;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
drop trigger register_project_member on public.organization_memberships;
create trigger register_project_member after insert or delete or update of role on public.organization_memberships
  for each row execute function private.register_project_member();

-- Correct historical viewer-only project invitations without changing any project grant.
update public.organization_group_memberships member set role = 'viewer'
where member.role = 'member'
  and exists (select 1 from public.organization_memberships access join public.organizations project on project.id = access.organization_id
    where project.organization_group_id = member.organization_group_id and access.user_id = member.user_id)
  and not exists (select 1 from public.organization_memberships access join public.organizations project on project.id = access.organization_id
    where project.organization_group_id = member.organization_group_id and access.user_id = member.user_id and access.role <> 'viewer');
revoke all on function private.register_project_member(), private.enforce_organization_capacity() from public, anon, authenticated;
