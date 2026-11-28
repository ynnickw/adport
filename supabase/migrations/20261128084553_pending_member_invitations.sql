create table private.member_invitations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  organization_group_id uuid not null references public.organization_groups(id) on delete cascade,
  project_id uuid references public.organizations(id) on delete cascade,
  project_ids uuid[] not null default '{}',
  email text not null check (char_length(email) between 1 and 320 and email = lower(email)),
  role public.organization_role not null,
  invited_by uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid references auth.users(id) on delete cascade,
  previous_role public.organization_role,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  sent_at timestamptz,
  canceled_at timestamptz,
  accepted_at timestamptz,
  check (project_id is null or (role <> 'owner' and cardinality(project_ids) = 0)),
  check (previous_role is null or (role = 'owner' and project_id is null and recipient_user_id is not null)),
  check (sent_at is null or recipient_user_id is not null)
);

create unique index member_invitations_pending_email_idx
  on private.member_invitations (organization_group_id, project_id, email) nulls not distinct
  where accepted_at is null and canceled_at is null;

alter table private.member_invitations enable row level security;
revoke all on private.member_invitations from public, anon, authenticated;
grant select, insert, update on private.member_invitations to adport_backend;
create policy member_invitations_backend on private.member_invitations for all to adport_backend using (true) with check (true);
