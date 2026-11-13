-- Business assets require explicit project grants beyond advertiser access.
create table private.reddit_catalog_access (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'reddit' check (provider = 'reddit'),
  account_id text not null check (length(account_id) between 1 and 256 and account_id ~ '^[A-Za-z0-9_-]+$'),
  business_id text not null check (business_id ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'),
  resource_kind text not null check (resource_kind in ('catalog', 'catalog_creation')),
  resource_id text not null check (length(resource_id) between 1 and 256 and resource_id ~ '^[A-Za-z0-9_-]+$'),
  access_mode text not null check (access_mode in ('none', 'read', 'write', 'create')),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  primary key (organization_id, provider, account_id, business_id, resource_kind, resource_id),
  foreign key (organization_id, provider, account_id)
    references public.organization_ad_accounts(organization_id, provider, account_id) on delete cascade,
  check ((resource_kind = 'catalog' and access_mode in ('none', 'read', 'write')) or
    (resource_kind = 'catalog_creation' and resource_id = business_id and access_mode in ('none', 'create')))
);
alter table private.reddit_catalog_access enable row level security;
revoke all on private.reddit_catalog_access from public, anon, authenticated;
grant select, insert, update on private.reddit_catalog_access to adport_backend;
create policy reddit_catalog_access_backend on private.reddit_catalog_access
  for all to adport_backend using (true) with check (true);
