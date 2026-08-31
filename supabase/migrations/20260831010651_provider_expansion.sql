-- Add provider identifiers only. Existing tenant RLS and grants are unchanged.
set local lock_timeout = '5s';
alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));

alter table private.provider_credentials drop constraint provider_credentials_provider_check;
alter table private.provider_credentials add constraint provider_credentials_provider_check
  check (provider in ('google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));

alter table private.oauth_transactions drop constraint oauth_transactions_provider_check;
alter table private.oauth_transactions add constraint oauth_transactions_provider_check
  check (provider in ('google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));

alter table public.organization_ad_accounts drop constraint organization_ad_accounts_provider_check;
alter table public.organization_ad_accounts add constraint organization_ad_accounts_provider_check
  check (provider in ('google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));
