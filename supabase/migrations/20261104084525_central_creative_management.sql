begin;
alter table private.creative_media
  add column tags text[] not null default '{}',
  add column platforms text[] not null default '{}',
  add column metadata_version integer not null default 1 check (metadata_version > 0),
  add constraint creative_media_tag_count check (cardinality(tags) <= 24),
  add constraint creative_media_platforms check (platforms <@ array['google','meta','tiktok','apple','microsoft','reddit','snapchat','spotify','pinterest','linkedin','x']::text[]);
create index creative_media_created_idx on private.creative_media (organization_id, created_at desc, id desc) where status = 'ready' and deleted_at is null;
create table private.creative_media_distributions (
  id uuid primary key,
  organization_id uuid not null,
  media_id uuid not null references private.creative_media(id) on delete cascade,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  provider text not null,
  account_id text not null,
  tool text not null,
  status text not null check (status in ('STARTED','ACCEPTED','UNCONFIRMED')),
  resource_ids text[] not null default '{}',
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index creative_media_distributions_asset_idx on private.creative_media_distributions (organization_id, media_id, created_at desc);
alter table private.creative_media_distributions enable row level security;
revoke all on private.creative_media_distributions from public, anon, authenticated;
grant select, insert, update, delete on private.creative_media_distributions to adport_backend;
create policy creative_media_distributions_backend on private.creative_media_distributions for all to adport_backend using (true) with check (true);
commit;
