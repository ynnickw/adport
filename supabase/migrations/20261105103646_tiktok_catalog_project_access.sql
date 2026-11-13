-- Business Center assets require explicit project grants beyond advertiser access.
create table private.tiktok_catalog_access (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'tiktok' check (provider = 'tiktok'),
  account_id text not null check (account_id ~ '^[0-9]{1,30}$'),
  business_id text not null check (business_id ~ '^[0-9]{1,30}$'),
  resource_kind text not null check (resource_kind in ('catalog', 'catalog_creation')),
  resource_id text not null check (resource_id ~ '^[0-9]{1,30}$'),
  access_mode text not null check (access_mode in ('none', 'read', 'write', 'create')),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  primary key (organization_id, provider, account_id, business_id, resource_kind, resource_id),
  foreign key (organization_id, provider, account_id)
    references public.organization_ad_accounts(organization_id, provider, account_id) on delete cascade,
  check ((resource_kind = 'catalog' and access_mode in ('none', 'read', 'write')) or
    (resource_kind = 'catalog_creation' and resource_id = business_id and access_mode in ('none', 'create')))
);
alter table private.tiktok_catalog_access enable row level security;
revoke all on private.tiktok_catalog_access from public, anon, authenticated;
grant select, insert, update on private.tiktok_catalog_access to adport_backend;
create policy tiktok_catalog_access_backend on private.tiktok_catalog_access
  for all to adport_backend using (true) with check (true);
