-- Persist checkout attempts before calling Stripe so a crash or concurrent
-- request reuses the same idempotency key and exact parameters.
create table private.billing_checkout_attempts (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  plan public.cloud_plan not null check (plan in ('operator', 'premium', 'agency')),
  interval text not null check (interval in ('monthly', 'annual')),
  parameters jsonb not null,
  session_id text,
  created_at timestamptz not null default now()
);
revoke all on private.billing_checkout_attempts from public, anon, authenticated;
grant select, insert, update, delete on private.billing_checkout_attempts to adport_backend;

alter table public.organization_subscriptions
  add column cancel_at timestamptz,
  add column canceled_at timestamptz,
  add column cancellation_reason text,
  add column last_synced_at timestamptz,
  add column last_reconciliation_attempt_at timestamptz;

alter table public.organization_subscriptions drop constraint organization_subscriptions_status_check;
alter table public.organization_subscriptions add constraint organization_subscriptions_status_check
  check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'unpaid', 'paused', 'incomplete_expired'));

create index organization_subscriptions_reconcile_idx on public.organization_subscriptions (last_reconciliation_attempt_at nulls first)
  where billing_provider = 'stripe';
