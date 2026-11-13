-- Native resource credentials are independent of OAuth grant replacement.
-- Only backend code can read ciphertext; project deletion removes local copies.
create table private.provider_resource_credentials (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  resource_key text not null check (resource_key ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{0,63}$'),
  account_id text not null check (length(account_id) between 1 and 256),
  business_id text not null check (length(business_id) between 1 and 256),
  resource_id text not null check (length(resource_id) between 1 and 256),
  credential_id text not null check (length(credential_id) between 1 and 256),
  ciphertext text not null check (length(ciphertext) > 0),
  created_at timestamptz not null default now(),
  primary key (organization_id, resource_key)
);
alter table private.provider_resource_credentials enable row level security;
revoke all on private.provider_resource_credentials from public, anon, authenticated;
grant select, insert, delete on private.provider_resource_credentials to adport_backend;
create policy provider_resource_credentials_backend on private.provider_resource_credentials
  for all to adport_backend using (true) with check (true);
