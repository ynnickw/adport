alter type public.cloud_plan add value if not exists 'premium' before 'agency';

create table public.organization_onboarding (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  current_step text not null default 'welcome'
    check (current_step in ('welcome', 'connect', 'accounts', 'agent', 'complete')),
  selected_agent text
    check (selected_agent is null or selected_agent in ('chatgpt', 'codex', 'claude-code', 'claude', 'cursor', 'vscode')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'support' check (kind in ('support', 'feedback', 'bug')),
  subject text not null check (char_length(subject) between 3 and 160),
  message text not null check (char_length(message) between 10 and 5000),
  page_path text check (page_path is null or (char_length(page_path) <= 500 and page_path ~ '^/')),
  status text not null default 'new' check (status in ('new', 'in_progress', 'resolved')),
  notification_status text not null default 'pending' check (notification_status in ('pending', 'sent', 'failed')),
  notification_error text,
  resend_email_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index feedback_organization_created_idx
  on public.feedback (organization_id, created_at desc);
create index feedback_status_created_idx
  on public.feedback (status, created_at desc);
create index feedback_created_by_idx
  on public.feedback (created_by, created_at desc);

create trigger organization_onboarding_set_updated_at
  before update on public.organization_onboarding
  for each row execute function private.set_updated_at();
create trigger feedback_set_updated_at
  before update on public.feedback
  for each row execute function private.set_updated_at();

create or replace function private.create_default_organization_onboarding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_onboarding (organization_id)
  values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

create trigger on_organization_created_onboarding
  after insert on public.organizations
  for each row execute function private.create_default_organization_onboarding();

-- Existing workspaces have already configured the product and must not be
-- forced through first-run onboarding after this migration deploys.
insert into public.organization_onboarding (organization_id, current_step, completed_at)
select id, 'complete', now() from public.organizations
on conflict (organization_id) do nothing;

alter table public.organization_onboarding enable row level security;
alter table public.feedback enable row level security;

create policy organization_onboarding_select_member
  on public.organization_onboarding for select to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organization_onboarding.organization_id
      and membership.user_id = (select auth.uid())
  ));

create policy feedback_select_creator
  on public.feedback for select to authenticated
  using (created_by = (select auth.uid()));

create policy feedback_insert_member
  on public.feedback for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = feedback.organization_id
        and membership.user_id = (select auth.uid())
    )
  );

create policy organization_onboarding_backend_all
  on public.organization_onboarding for all to adport_backend using (true) with check (true);
create policy feedback_backend_all
  on public.feedback for all to adport_backend using (true) with check (true);

grant select on public.organization_onboarding to authenticated;
grant select, insert on public.feedback to authenticated;
grant select, insert, update, delete on public.organization_onboarding, public.feedback to adport_backend;

revoke all on function private.create_default_organization_onboarding() from public, anon, authenticated;
