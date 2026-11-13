-- Survives project deletion so private objects can be removed after every
-- outstanding signed upload grant has expired (Supabase grants last 2 hours).
create table private.creative_media_cleanup (
  project_id uuid primary key,
  not_before timestamptz not null default now() + interval '3 hours'
);
alter table private.creative_media_cleanup enable row level security;
revoke all on private.creative_media_cleanup from public, anon, authenticated;
grant select, delete on private.creative_media_cleanup to adport_backend;
create policy creative_media_cleanup_backend on private.creative_media_cleanup for all to adport_backend using (true) with check (true);

create function private.queue_creative_media_cleanup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from private.creative_media where organization_id = old.id) then
    insert into private.creative_media_cleanup (project_id) values (old.id) on conflict do nothing;
  end if;
  return old;
end;
$$;
revoke all on function private.queue_creative_media_cleanup() from public, anon, authenticated;
create trigger queue_creative_media_cleanup before delete on public.organizations
  for each row execute function private.queue_creative_media_cleanup();
