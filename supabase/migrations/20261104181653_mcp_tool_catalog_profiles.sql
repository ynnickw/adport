-- Missing rows deliberately retain Full access for existing connections.
create table private.mcp_tool_catalog_settings (
  connection_key text primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  organization_group_id uuid references public.organization_groups(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  client_id text references private.mcp_oauth_clients(client_id) on delete cascade,
  api_key_id uuid references public.api_keys(id) on delete cascade,
  profile text not null check (profile in ('standard', 'reporting', 'full')),
  providers text[] check (providers <@ array['google','meta','tiktok','apple','microsoft','reddit','snapchat','spotify','pinterest','linkedin','x']::text[]),
  updated_at timestamptz not null default now(),
  check ((organization_group_id is not null and organization_id is null and api_key_id is null) or (organization_group_id is null and organization_id is not null)),
  check ((api_key_id is not null and client_id is null) or (api_key_id is null and client_id is not null and user_id is not null))
);
alter table private.mcp_tool_catalog_settings enable row level security;
revoke all on private.mcp_tool_catalog_settings from public, anon, authenticated;
grant select, insert, update, delete on private.mcp_tool_catalog_settings to adport_backend;
create policy backend_catalog_settings on private.mcp_tool_catalog_settings
  to adport_backend using (true) with check (true);

create index mcp_tool_catalog_settings_project_idx on private.mcp_tool_catalog_settings (organization_id);
create index mcp_tool_catalog_settings_company_idx on private.mcp_tool_catalog_settings (organization_group_id);
create index mcp_tool_catalog_settings_user_idx on private.mcp_tool_catalog_settings (user_id);
create index mcp_tool_catalog_settings_client_idx on private.mcp_tool_catalog_settings (client_id);
create index mcp_tool_catalog_settings_key_idx on private.mcp_tool_catalog_settings (api_key_id);
