-- Existing inventory remains intact. New OAuth grants require an explicit selection.
alter table public.connections add column account_selection_id uuid;

create table private.provider_account_selections (
  id uuid primary key,
  organization_id uuid not null,
  connection_id uuid not null unique,
  provider text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  ciphertext text not null,
  return_path text not null,
  expires_at timestamptz not null default now() + interval '30 minutes',
  foreign key (connection_id, organization_id, provider)
    references public.connections(id, organization_id, provider) on delete cascade
);
alter table private.provider_account_selections enable row level security;
revoke all on private.provider_account_selections from public, anon, authenticated;
grant select, insert, update, delete on private.provider_account_selections to adport_backend;
create policy provider_account_selections_backend_all on private.provider_account_selections
  for all to adport_backend using (true) with check (true);
create index provider_account_selections_expiry_idx on private.provider_account_selections(expires_at);
select cron.schedule('adport-account-selection-expiry', '*/10 * * * *',
  'delete from private.provider_account_selections where expires_at < now()');
