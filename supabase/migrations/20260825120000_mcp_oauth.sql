create table private.mcp_oauth_clients (
  client_id text primary key,
  client_name text not null check (char_length(client_name) between 1 and 120),
  client_uri text,
  logo_uri text,
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  grant_types text[] not null default array['authorization_code', 'refresh_token']::text[]
    check (grant_types <@ array['authorization_code', 'refresh_token']::text[]),
  response_types text[] not null default array['code']::text[]
    check (response_types = array['code']::text[]),
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method = 'none'),
  created_at timestamptz not null default now()
);

create table private.mcp_oauth_authorization_codes (
  code_hash text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references private.mcp_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  scopes text[] not null check (cardinality(scopes) > 0 and scopes <@ array['tools:read', 'tools:write']::text[]),
  code_challenge text not null,
  resource text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);

create index mcp_oauth_authorization_codes_expiry_idx
  on private.mcp_oauth_authorization_codes (expires_at)
  where consumed_at is null;

create table private.mcp_oauth_refresh_tokens (
  token_hash text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references private.mcp_oauth_clients(client_id) on delete cascade,
  scopes text[] not null check (cardinality(scopes) > 0 and scopes <@ array['tools:read', 'tools:write']::text[]),
  resource text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index mcp_oauth_refresh_tokens_expiry_idx
  on private.mcp_oauth_refresh_tokens (expires_at)
  where consumed_at is null and revoked_at is null;

create table private.mcp_oauth_access_tokens (
  token_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references private.mcp_oauth_clients(client_id) on delete cascade,
  scopes text[] not null check (cardinality(scopes) > 0 and scopes <@ array['tools:read', 'tools:write']::text[]),
  resource text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index mcp_oauth_access_tokens_expiry_idx
  on private.mcp_oauth_access_tokens (expires_at)
  where revoked_at is null;

create or replace function private.purge_expired_mcp_oauth_records()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from private.mcp_oauth_authorization_codes where expires_at < now() - interval '1 day';
  delete from private.mcp_oauth_refresh_tokens where expires_at < now() - interval '1 day';
  delete from private.mcp_oauth_access_tokens where expires_at < now() - interval '1 day';
end;
$$;

revoke all on table private.mcp_oauth_clients from public, anon, authenticated;
revoke all on table private.mcp_oauth_authorization_codes from public, anon, authenticated;
revoke all on table private.mcp_oauth_refresh_tokens from public, anon, authenticated;
revoke all on table private.mcp_oauth_access_tokens from public, anon, authenticated;
revoke all on function private.purge_expired_mcp_oauth_records() from public, anon, authenticated;

grant select, insert, delete on private.mcp_oauth_clients to adport_backend;
grant select, insert, update, delete on private.mcp_oauth_authorization_codes to adport_backend;
grant select, insert, update, delete on private.mcp_oauth_refresh_tokens to adport_backend;
grant select, insert, update, delete on private.mcp_oauth_access_tokens to adport_backend;
grant execute on function private.purge_expired_mcp_oauth_records() to adport_backend;
