-- Matomo sites use the existing credential vault, account selection and reporting profiles.
set local lock_timeout = '5s';
alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check check (provider in ('ga4', 'gsc', 'matomo', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x', 'openai'));
alter table private.provider_credentials drop constraint provider_credentials_provider_check;
alter table private.provider_credentials add constraint provider_credentials_provider_check check (provider in ('ga4', 'gsc', 'matomo', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x', 'openai'));
alter table public.organization_ad_accounts drop constraint organization_ad_accounts_provider_check;
alter table public.organization_ad_accounts add constraint organization_ad_accounts_provider_check check (provider in ('ga4', 'gsc', 'matomo', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x', 'openai'));
alter table private.mcp_tool_catalog_settings drop constraint mcp_tool_catalog_settings_providers_check;
alter table private.mcp_tool_catalog_settings add constraint mcp_tool_catalog_settings_providers_check check (providers <@ array['ga4', 'gsc', 'matomo', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x', 'openai']::text[]);

create or replace function private.provider_uses_ad_account_slot(provider text)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select provider is null or provider not in ('gtm', 'ga4', 'gsc', 'matomo');
$$;
revoke all on function private.provider_uses_ad_account_slot(text) from public, anon, authenticated;
grant execute on function private.provider_uses_ad_account_slot(text) to adport_backend;
