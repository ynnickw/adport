alter table public.organizations add column logo_path text;
alter table public.organization_groups add column logo_path text;

-- Private objects are served only through authenticated, membership-checked
-- cloud routes. No direct anon/authenticated Storage policies are granted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('workspace-logos', 'workspace-logos', false, 2097152, array['image/png']);
