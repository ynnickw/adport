-- The default project remains the organization's billing anchor.
create or replace function private.protect_default_project()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.organization_groups company where company.default_project_id = old.id) then
    if tg_op = 'UPDATE' then
      if new.organization_group_id <> old.organization_group_id then
        raise exception 'The default project cannot be transferred.' using errcode = '23514';
      elsif new.archived_at is not null then
        raise exception 'The default project cannot be archived.';
      end if;
    elsif exists (select 1 from public.organizations sibling
      where sibling.organization_group_id = old.organization_group_id and sibling.id <> old.id) then
      raise exception 'Delete or archive client projects before deleting the organization.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create index mcp_oauth_authorization_codes_active_project_idx on private.mcp_oauth_authorization_codes (organization_id)
  where organization_group_id is null and consumed_at is null;
create index mcp_oauth_refresh_tokens_active_project_idx on private.mcp_oauth_refresh_tokens (organization_id)
  where organization_group_id is null and revoked_at is null;
create index mcp_oauth_access_tokens_active_project_idx on private.mcp_oauth_access_tokens (organization_id)
  where organization_group_id is null and revoked_at is null;
