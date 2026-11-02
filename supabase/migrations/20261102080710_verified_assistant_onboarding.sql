-- Authentication and discovery are not proof that an assistant can read ad data.
-- Only the hosted tool runtime writes this timestamp after a successful read.
alter table private.mcp_oauth_refresh_tokens add column verified_at timestamptz;
alter table public.api_keys add column verified_at timestamptz;
comment on column private.mcp_oauth_refresh_tokens.verified_at is 'First successful accounts_list or report read over MCP. Preserved on refresh rotation.';
comment on column public.api_keys.verified_at is 'First successful accounts_list or report read over MCP. Never inferred from last_used_at.';

alter table public.organization_onboarding add column skipped_at timestamptz;
-- Older skips stored the exit time in completed_at while retaining an unfinished step.
update public.organization_onboarding set skipped_at = completed_at, completed_at = null
  where current_step <> 'complete' and completed_at is not null;
