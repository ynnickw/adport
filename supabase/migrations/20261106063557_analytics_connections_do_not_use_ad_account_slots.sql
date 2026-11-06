-- Analytics integrations retain explicit account access without consuming advertising capacity.
create or replace function private.provider_uses_ad_account_slot(provider text)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select provider is distinct from 'gtm';
$$;
revoke all on function private.provider_uses_ad_account_slot(text) from public, anon, authenticated;
grant execute on function private.provider_uses_ad_account_slot(text) to adport_backend;

create or replace function private.enforce_organization_capacity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare company_id uuid; allowed_count integer; used_count integer; allowed_plan public.cloud_plan;
begin
  if tg_table_name = 'organization_ad_accounts' then
    if not new.enabled then return new; end if;
    select organization_group_id into company_id from public.organizations where id = new.organization_id and archived_at is null;
    if company_id is null then raise exception 'Archived projects cannot enable agent account access.' using errcode = '23514'; end if;
    if not private.provider_uses_ad_account_slot(new.provider) then return new; end if;
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
      where project.organization_group_id = company_id and project.archived_at is null and account.enabled
        and private.provider_uses_ad_account_slot(account.provider);
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
revoke all on function private.enforce_organization_capacity() from public, anon, authenticated;
