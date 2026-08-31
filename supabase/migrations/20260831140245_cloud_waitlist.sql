create table private.cloud_waitlist (
  email text primary key check (
    email = lower(btrim(email)) and char_length(email) between 3 and 254
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  created_at timestamptz not null default now(),
  consent_version text not null,
  source text not null default 'landing' check (source = 'landing')
);

alter table private.cloud_waitlist enable row level security;
revoke all on private.cloud_waitlist from public, anon, authenticated;
grant select, insert on private.cloud_waitlist to adport_backend;
create policy cloud_waitlist_backend_insert on private.cloud_waitlist
  for insert to adport_backend with check (true);
create policy cloud_waitlist_backend_select on private.cloud_waitlist
  for select to adport_backend using (true);
