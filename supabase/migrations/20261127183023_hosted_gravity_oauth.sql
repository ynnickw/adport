alter table private.oauth_transactions drop constraint oauth_transactions_provider_check;
alter table private.oauth_transactions add constraint oauth_transactions_provider_check
  check (provider in ('gravity', 'matomo', 'ga4', 'gsc', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));
