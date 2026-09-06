-- Administrative provisioning only. This is never a public demo switch.
create table private.synthetic_reviewer_workspaces (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  campaigns jsonb not null check (jsonb_typeof(campaigns) = 'array'),
  created_at timestamptz not null default now()
);
alter table private.synthetic_reviewer_workspaces enable row level security;
revoke all on private.synthetic_reviewer_workspaces from public, anon, authenticated;
grant select on private.synthetic_reviewer_workspaces to adport_backend;
grant update (campaigns) on private.synthetic_reviewer_workspaces to adport_backend;
create policy synthetic_reviewer_backend_read on private.synthetic_reviewer_workspaces
  for select to adport_backend using (true);
create policy synthetic_reviewer_backend_update on private.synthetic_reviewer_workspaces
  for update to adport_backend using (true) with check (true);
