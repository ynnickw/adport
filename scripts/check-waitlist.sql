-- Run against the local Adport database. Every fixture is rolled back.
begin;
set local role adport_backend;
insert into private.cloud_waitlist (email, consent_version)
values ('waitlist-database-check@example.invalid', 'fixture')
on conflict (email) do nothing;
insert into private.cloud_waitlist (email, consent_version)
values ('waitlist-database-check@example.invalid', 'fixture')
on conflict (email) do nothing;
do $$ begin
  if (select count(*) from private.cloud_waitlist where email = 'waitlist-database-check@example.invalid') <> 1 then
    raise exception 'Waitlist duplicate prevention failed';
  end if;
  begin
    insert into private.cloud_waitlist (email, consent_version) values ('Invalid@Example.invalid', 'fixture');
    raise exception 'Expected email normalization constraint';
  exception when check_violation then null;
  end;
end $$;
reset role;
do $$
declare role_name text; privilege_name text;
begin
  if not (select relrowsecurity from pg_class where oid = 'private.cloud_waitlist'::regclass) then
    raise exception 'Waitlist RLS is disabled';
  end if;
  foreach role_name in array array['anon', 'authenticated'] loop
    foreach privilege_name in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(role_name, 'private.cloud_waitlist', privilege_name) then
        raise exception 'Unexpected waitlist privilege for %: %', role_name, privilege_name;
      end if;
    end loop;
  end loop;
end $$;
rollback;
