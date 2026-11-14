-- Read-only GA4 and Search Console grants use the existing tenant-isolated vault.
set local lock_timeout = '5s';
alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check check (provider in ('ga4', 'gsc', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));

alter table private.provider_credentials drop constraint provider_credentials_provider_check;
alter table private.provider_credentials add constraint provider_credentials_provider_check check (provider in ('ga4', 'gsc', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));

alter table private.oauth_transactions drop constraint oauth_transactions_provider_check;
alter table private.oauth_transactions add constraint oauth_transactions_provider_check check (provider in ('ga4', 'gsc', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));

alter table public.organization_ad_accounts drop constraint organization_ad_accounts_provider_check;
alter table public.organization_ad_accounts add constraint organization_ad_accounts_provider_check check (provider in ('ga4', 'gsc', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));

do $migration$
begin
  if to_regclass('private.mcp_tool_catalog_settings') is not null then
    alter table private.mcp_tool_catalog_settings drop constraint if exists mcp_tool_catalog_settings_providers_check;
    alter table private.mcp_tool_catalog_settings add constraint mcp_tool_catalog_settings_providers_check
      check (providers <@ array['ga4', 'gsc', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x']::text[]);
  end if;
end
$migration$;

create or replace function private.provider_uses_ad_account_slot(provider text)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select provider is null or provider not in ('gtm', 'ga4', 'gsc');
$$;
revoke all on function private.provider_uses_ad_account_slot(text) from public, anon, authenticated;
grant execute on function private.provider_uses_ad_account_slot(text) to adport_backend;
