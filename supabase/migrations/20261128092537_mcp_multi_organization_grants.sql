create table private.mcp_oauth_organization_grants (
  id uuid primary key default gen_random_uuid(),
  scope_key text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references private.mcp_oauth_clients(client_id) on delete cascade,
  resource text not null,
  organization_group_ids uuid[] not null check (cardinality(organization_group_ids) > 1 and array_position(organization_group_ids, null) is null),
  profile text not null check (profile in ('standard', 'reporting', 'full')),
  providers text[],
  created_at timestamptz not null default now()
);

alter table private.mcp_oauth_organization_grants enable row level security;
revoke all on private.mcp_oauth_organization_grants from public, anon, authenticated;
grant select, insert, update on private.mcp_oauth_organization_grants to adport_backend;
create policy mcp_oauth_organization_grants_backend on private.mcp_oauth_organization_grants
  to adport_backend using (true) with check (true);

create index mcp_oauth_organization_grants_groups_idx on private.mcp_oauth_organization_grants using gin (organization_group_ids);
create index mcp_oauth_organization_grants_user_idx on private.mcp_oauth_organization_grants (user_id);
create index mcp_oauth_organization_grants_client_idx on private.mcp_oauth_organization_grants (client_id);

-- Multi-organization credentials have no project anchor. Deleting one selected
-- organization must not delete the credentials for the other organizations.
alter table private.mcp_oauth_authorization_codes
  alter column organization_id drop not null,
  add column organization_grant_id uuid references private.mcp_oauth_organization_grants(id) on delete cascade,
  add check ((organization_id is not null and organization_grant_id is null)
    or (organization_id is null and organization_group_id is null and organization_grant_id is not null));
alter table private.mcp_oauth_refresh_tokens
  alter column organization_id drop not null,
  add column organization_grant_id uuid references private.mcp_oauth_organization_grants(id) on delete cascade,
  add check ((organization_id is not null and organization_grant_id is null)
    or (organization_id is null and organization_group_id is null and organization_grant_id is not null));
alter table private.mcp_oauth_access_tokens
  alter column organization_id drop not null,
  add column organization_grant_id uuid references private.mcp_oauth_organization_grants(id) on delete cascade,
  add check ((organization_id is not null and organization_grant_id is null)
    or (organization_id is null and organization_group_id is null and organization_grant_id is not null));

create index mcp_oauth_codes_org_grant_idx on private.mcp_oauth_authorization_codes (organization_grant_id) where organization_grant_id is not null;
create index mcp_oauth_refresh_org_grant_idx on private.mcp_oauth_refresh_tokens (organization_grant_id) where organization_grant_id is not null;
create index mcp_oauth_access_org_grant_idx on private.mcp_oauth_access_tokens (organization_grant_id) where organization_grant_id is not null;
