create type public.cloud_plan as enum ('reader', 'operator', 'agency', 'enterprise');

create table public.organization_subscriptions (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plan public.cloud_plan not null default 'reader',
  status text not null default 'active'
    check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'unpaid')),
  billing_provider text check (billing_provider is null or billing_provider = 'stripe'),
  provider_customer_id text unique,
  provider_subscription_id text unique,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_ad_accounts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  provider text not null check (provider in ('google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit')),
  account_id text not null,
  name text not null,
  currency text,
  status text,
  enabled boolean not null default false,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (organization_id, provider, account_id),
  foreign key (connection_id, organization_id, provider)
    references public.connections(id, organization_id, provider) on delete cascade
);

create table public.findings (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null,
  provider text not null,
  status text not null check (status in ('open', 'dismissed', 'applied')),
  severity text not null check (severity in ('critical', 'warn', 'info')),
  finding jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id)
);

create index findings_org_status_severity_idx
  on public.findings (organization_id, status, severity, updated_at desc);

create index organization_ad_accounts_enabled_idx
  on public.organization_ad_accounts (organization_id, enabled, provider, account_id);

create table private.billing_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

create trigger organization_subscriptions_set_updated_at
  before update on public.organization_subscriptions
  for each row execute function private.set_updated_at();

create or replace function private.create_default_organization_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_subscriptions (organization_id)
  values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

create trigger on_organization_created_subscription
  after insert on public.organizations
  for each row execute function private.create_default_organization_subscription();

insert into public.organization_subscriptions (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

alter table public.organization_settings alter column data_retention_days set default 30;
update public.organization_settings setting
set data_retention_days = least(setting.data_retention_days, 30)
from public.organization_subscriptions subscription
where subscription.organization_id = setting.organization_id
  and subscription.plan = 'reader';

alter table public.organization_subscriptions enable row level security;
alter table public.organization_ad_accounts enable row level security;
alter table public.findings enable row level security;

create policy organization_subscriptions_select_member
  on public.organization_subscriptions for select to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organization_subscriptions.organization_id
      and membership.user_id = (select auth.uid())
  ));

create policy organization_ad_accounts_select_member
  on public.organization_ad_accounts for select to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organization_ad_accounts.organization_id
      and membership.user_id = (select auth.uid())
  ));

create policy findings_select_member on public.findings for select to authenticated
  using (exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = findings.organization_id
      and membership.user_id = (select auth.uid())
  ));

create policy organization_subscriptions_backend_all
  on public.organization_subscriptions for all to adport_backend using (true) with check (true);
create policy organization_ad_accounts_backend_all
  on public.organization_ad_accounts for all to adport_backend using (true) with check (true);
create policy findings_backend_all
  on public.findings for all to adport_backend using (true) with check (true);

grant select on public.organization_subscriptions, public.organization_ad_accounts, public.findings to authenticated;
grant select, insert, update, delete on public.organization_subscriptions, public.organization_ad_accounts, public.findings to adport_backend;
grant select, insert, update, delete on private.billing_events to adport_backend;

revoke all on private.billing_events from public, anon, authenticated;
revoke all on function private.create_default_organization_subscription() from public, anon, authenticated;

create or replace function private.apply_data_retention()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.audit_events event
  using public.organization_settings setting
  where event.organization_id = setting.organization_id
    and event.created_at < now() - make_interval(days => setting.data_retention_days);

  delete from public.pending_operations operation
  using public.organization_settings setting
  where operation.organization_id = setting.organization_id
    and coalesce(operation.consumed_at, operation.expires_at)
      < now() - make_interval(days => setting.data_retention_days);

  delete from public.findings finding
  using public.organization_settings setting
  where finding.organization_id = setting.organization_id
    and finding.updated_at < now() - make_interval(days => setting.data_retention_days);

  delete from public.deletion_requests request
  using public.organization_settings setting
  where request.organization_id = setting.organization_id
    and request.requested_at < now() - make_interval(days => setting.data_retention_days);

  delete from private.oauth_transactions where expires_at < now() - interval '1 day';
  delete from private.rate_limit_buckets where window_start < now() - interval '1 hour';
  delete from private.billing_events where processed_at < now() - interval '400 days';
end;
$$;

alter table public.audit_events drop constraint if exists audit_events_event_check;
alter table public.audit_events add constraint audit_events_event_check check (event in (
  'validated', 'applied', 'rejected', 'note', 'connected', 'revoked',
  'api_key_created', 'api_key_revoked', 'member_invited', 'member_role_updated',
  'member_removed', 'settings_updated', 'deletion_requested', 'subscription_updated',
  'account_access_updated'
));
