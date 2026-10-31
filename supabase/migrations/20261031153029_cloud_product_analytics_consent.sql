-- Analytics is optional, user scoped, and unavailable through the public API.
create table private.product_analytics_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null,
  notice_version integer not null default 1 check (notice_version = 1),
  updated_at timestamptz not null default now()
);
alter table private.product_analytics_preferences enable row level security;
create policy backend_analytics_preferences on private.product_analytics_preferences
  for all to adport_backend using (true) with check (true);
revoke all on private.product_analytics_preferences from public, anon, authenticated;
grant select, insert, update, delete on private.product_analytics_preferences to adport_backend;
