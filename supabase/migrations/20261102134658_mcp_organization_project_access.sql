-- Null preserves existing single-project grants. Only explicit new consent sets this.
alter table private.mcp_oauth_authorization_codes
  add column organization_group_id uuid references public.organization_groups(id) on delete cascade;
alter table private.mcp_oauth_refresh_tokens
  add column organization_group_id uuid references public.organization_groups(id) on delete cascade;
alter table private.mcp_oauth_access_tokens
  add column organization_group_id uuid references public.organization_groups(id) on delete cascade;

create index mcp_oauth_authorization_codes_group_idx on private.mcp_oauth_authorization_codes (organization_group_id) where organization_group_id is not null;
create index mcp_oauth_refresh_tokens_group_idx on private.mcp_oauth_refresh_tokens (organization_group_id) where organization_group_id is not null;
create index mcp_oauth_access_tokens_group_idx on private.mcp_oauth_access_tokens (organization_group_id) where organization_group_id is not null;
