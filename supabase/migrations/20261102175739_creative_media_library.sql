-- Media stays private and immutable. Only the backend can reserve/finalize a
-- project-scoped object; advertising uploads still use the policy engine.
create table private.creative_media (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  name text not null check (length(name) between 1 and 240),
  object_path text not null unique,
  content_type text not null,
  byte_length bigint not null check (byte_length between 1 and 104857600),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'uploading' check (status in ('uploading', 'ready', 'failed')),
  width integer check (width > 0),
  height integer check (height > 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  finalized_at timestamptz
);
create index creative_media_project_id_idx on private.creative_media (organization_id, id desc);
alter table private.creative_media enable row level security;
revoke all on private.creative_media from public, anon, authenticated;
grant select, insert, update, delete on private.creative_media to adport_backend;
create policy creative_media_backend on private.creative_media for all to adport_backend using (true) with check (true);

-- Signed upload grants use upsert=false and authorize one random object path.
-- No anonymous or authenticated direct Storage policies are granted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('creative-media', 'creative-media', false, 104857600,
  array['image/png','image/jpeg','image/webp','image/heic','image/gif',
    'video/mp4','video/quicktime','video/webm','audio/mpeg','audio/wav','audio/ogg']);
