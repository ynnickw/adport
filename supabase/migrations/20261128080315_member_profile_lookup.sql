create function private.profile_avatar_url(target_user uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select left(coalesce(nullif(raw_user_meta_data ->> 'avatar_url', ''), raw_user_meta_data ->> 'picture'), 2048)
  from auth.users where id = target_user;
$$;

create function private.invite_profile_matches(
  actor_user uuid, target_id uuid, project_scope boolean, search_term text, exact_email text
)
returns table (display_name text, email text, avatar_url text, already_has_access boolean)
language sql stable security definer set search_path = '' as $$
  with invite_scope as (
    select member.organization_group_id as group_id, null::uuid as project_id, true as can_browse_organization
    from public.organization_group_memberships member
    where not project_scope and member.organization_group_id = target_id
      and member.user_id = actor_user and member.role in ('owner', 'admin')
    union all
    select project.organization_group_id, project.id, company_member.role in ('owner', 'admin')
    from private.project_memberships access
    join public.organizations project on project.id = access.organization_id
    join public.organization_group_memberships company_member
      on company_member.organization_group_id = project.organization_group_id and company_member.user_id = actor_user
    where project_scope and access.organization_id = target_id
      and access.user_id = actor_user and access.role in ('owner', 'admin')
  ),
  candidates as (
    select member.user_id
    from invite_scope scope
    join public.organization_group_memberships member on member.organization_group_id = scope.group_id
    where scope.can_browse_organization
    union
    select access.user_id
    from invite_scope scope
    join private.project_memberships access on access.organization_id = scope.project_id
    where not scope.can_browse_organization
    union
    -- Accounts outside the visible team can only be found by a full email address.
    select private.find_auth_user_id(exact_email) from invite_scope where exact_email is not null
  )
  select profile.display_name, auth_user.email::text, private.profile_avatar_url(profile.user_id),
    case when scope.project_id is null then exists (
      select 1 from public.organization_group_memberships member
      where member.organization_group_id = scope.group_id and member.user_id = profile.user_id
    ) else exists (
      select 1 from private.project_memberships access
      where access.organization_id = scope.project_id and access.user_id = profile.user_id
    ) end
  from invite_scope scope
  cross join candidates
  join public.profiles profile on profile.user_id = candidates.user_id
  join auth.users auth_user on auth_user.id = profile.user_id
  where nullif(auth_user.email, '') is not null and char_length(search_term) between 2 and 320
    and (strpos(lower(profile.display_name), lower(search_term)) > 0
      or strpos(lower(auth_user.email), lower(search_term)) > 0)
  order by (lower(auth_user.email) is not distinct from exact_email) desc, profile.display_name, auth_user.email
  limit 6;
$$;

revoke all on function private.profile_avatar_url(uuid), private.invite_profile_matches(uuid, uuid, boolean, text, text)
  from public, anon, authenticated;
grant execute on function private.profile_avatar_url(uuid), private.invite_profile_matches(uuid, uuid, boolean, text, text)
  to adport_backend;
