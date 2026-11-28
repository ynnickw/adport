-- Keep only the current, re-encoded thumbnail. A null row value intentionally
-- hides a social sign-in photo, including after the next sign-in.
create table private.profile_photos (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  image_id uuid unique,
  image bytea,
  check ((image_id is null) = (image is null)),
  check (octet_length(image) between 1 and 65536)
);

alter table private.profile_photos enable row level security;
revoke all on private.profile_photos from public, anon, authenticated;
grant select, insert, update on private.profile_photos to adport_backend;
create policy profile_photos_backend on private.profile_photos for all to adport_backend using (true) with check (true);

create or replace function private.profile_avatar_url(target_user uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select case when photo.user_id is not null then '/api/profile/photo/' || photo.image_id::text
    else left(coalesce(nullif(auth_user.raw_user_meta_data ->> 'avatar_url', ''), auth_user.raw_user_meta_data ->> 'picture'), 2048)
    end
  from auth.users auth_user
  left join private.profile_photos photo on photo.user_id = auth_user.id
  where auth_user.id = target_user;
$$;

-- Signup creates the initial project and its organization before onboarding.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization_uuid uuid := gen_random_uuid();
  base_name text := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), nullif(split_part(new.email, '@', 1), ''), 'Member');
begin
  insert into public.profiles (user_id, display_name) values (new.id, left(base_name, 120));
  insert into public.organizations (id, name, slug, created_by)
    values (organization_uuid, 'General', 'org-' || organization_uuid::text, new.id);
  update public.organization_groups set name = 'My organization' where id = organization_uuid;
  insert into public.organization_memberships (organization_id, user_id, role)
    values (organization_uuid, new.id, 'owner');
  insert into public.organization_settings (organization_id) values (organization_uuid);
  return new;
end;
$$;
