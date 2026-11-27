-- Matomo app registration and PKCE stay in the existing encrypted transaction.
alter table private.oauth_transactions drop constraint oauth_transactions_provider_check;
alter table private.oauth_transactions add constraint oauth_transactions_provider_check
  check (provider in ('matomo', 'ga4', 'gsc', 'gtm', 'google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'));
