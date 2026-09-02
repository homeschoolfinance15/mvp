-- Allow administrators to delete connectors or members, and connectors to
-- delete only members they directly invited. Deleting the auth user is the
-- source of truth: existing foreign keys cascade through profiles, links,
-- notes, codes, and search documents so no sign-in-only account is left behind.
create or replace function public.delete_managed_profile(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id            uuid := auth.uid();
  v_actor_role          public.app_role;
  v_actor_connector_id  uuid;
  v_target_role         public.app_role;
  v_target_connector_id uuid;
  v_member_ids          uuid[] := array[]::uuid[];
  v_deleted_count       int := 1;
begin
  if v_actor_id is null then
    raise exception 'You must be signed in to delete a profile.';
  end if;
  if p_profile_id is null then
    raise exception 'A profile is required.';
  end if;
  if p_profile_id = v_actor_id then
    raise exception 'You cannot delete your own profile.';
  end if;

  select role into v_actor_role
  from public.profiles
  where id = v_actor_id;

  if not found then
    raise exception 'Your signed-in account has no profile.';
  end if;

  select role into v_target_role
  from public.profiles
  where id = p_profile_id
  for update;

  if not found then
    raise exception 'That profile no longer exists.';
  end if;

  if v_actor_role = 'admin' then
    if v_target_role = 'admin' then
      raise exception 'Administrators cannot delete other administrator profiles.';
    end if;

    -- A connector owns the accounts they invited. Remove that subtree with the
    -- connector so members are not left with valid logins but no membership.
    if v_target_role = 'connector' then
      select id into v_target_connector_id
      from public.connectors
      where profile_id = p_profile_id
      for update;

      if v_target_connector_id is not null then
        select coalesce(array_agg(user_profile_id), array[]::uuid[])
        into v_member_ids
        from public.connector_user_links
        where connector_id = v_target_connector_id;

        v_deleted_count := 1 + cardinality(v_member_ids);

        if cardinality(v_member_ids) > 0 then
          delete from auth.users where id = any(v_member_ids);
        end if;
      end if;
    end if;
  elsif v_actor_role = 'connector' then
    v_actor_connector_id := public.my_connector_id();

    if v_target_role <> 'user'
       or v_actor_connector_id is null
       or not exists (
         select 1
         from public.connector_user_links
         where connector_id = v_actor_connector_id
           and user_profile_id = p_profile_id
       ) then
      raise exception 'You can only delete members you invited.';
    end if;
  else
    raise exception 'You do not have permission to delete profiles.';
  end if;

  delete from auth.users where id = p_profile_id;

  if not found then
    raise exception 'That account no longer exists.';
  end if;

  return jsonb_build_object(
    'profile_id', p_profile_id,
    'deleted_profiles', v_deleted_count
  );
end;
$$;

revoke all on function public.delete_managed_profile(uuid) from public;
revoke all on function public.delete_managed_profile(uuid) from anon;
grant execute on function public.delete_managed_profile(uuid) to authenticated;
