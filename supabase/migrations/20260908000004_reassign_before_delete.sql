-- ============================================================================
-- A connector leaving must not take their members with them
--
-- delete_managed_profile deleted every member beneath a connector along with
-- the connector: one press, and four people's accounts, posts, notes and
-- memberships were gone. The confirm dialog said so in one line, which is not
-- the same as the system refusing to do something irreversible and wrong.
--
-- Members belong to the network, not to the person who happened to invite
-- them. So:
--
--   1. Deleting a connector who still has members is now refused outright.
--   2. Members are moved to another connector first, all of them or a chosen
--      few, and only an empty connector can be deleted.
--
-- The refusal lives in the function rather than the browser, so it holds for
-- every caller — the admin screen, a script, or a future connector-side
-- button that has not been written yet.
-- ============================================================================

create or replace function public.reassign_connector_members(
  p_from_connector uuid,
  p_to_connector   uuid,
  -- Null means everybody under the old connector.
  p_profile_ids    uuid[] default null
)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_status   connector_status;
  v_moving   int;
  v_capacity int;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can move members between connectors.';
  end if;
  if p_from_connector = p_to_connector then
    raise exception 'That is the same connector.';
  end if;

  select invite_status into v_status from public.connectors where id = p_to_connector;
  if v_status is null then
    raise exception 'That connector does not exist.';
  end if;
  if v_status <> 'active' then
    raise exception 'That connector''s inviting privileges are currently %.', v_status;
  end if;

  select count(*) into v_moving
  from public.connector_user_links
  where connector_id = p_from_connector
    and (p_profile_ids is null or user_profile_id = any(p_profile_ids));

  if v_moving = 0 then
    return 0;
  end if;

  -- Capacity is what a connector may hold, so arriving members count against
  -- it exactly as invited ones do.
  v_capacity := public.connector_available_capacity(p_to_connector);
  if v_capacity < v_moving then
    raise exception
      'That connector has room for % more, and % would be moved.', v_capacity, v_moving;
  end if;

  -- Somebody already linked to the destination keeps that link rather than
  -- tripping the (connector_id, user_profile_id) unique constraint.
  delete from public.connector_user_links l
  where l.connector_id = p_from_connector
    and (p_profile_ids is null or l.user_profile_id = any(p_profile_ids))
    and exists (
      select 1 from public.connector_user_links t
      where t.connector_id = p_to_connector
        and t.user_profile_id = l.user_profile_id
    );

  -- The invite code stays pointed at the code they actually redeemed. It is
  -- ON DELETE SET NULL, so it survives the old connector being removed.
  update public.connector_user_links
  set connector_id = p_to_connector
  where connector_id = p_from_connector
    and (p_profile_ids is null or user_profile_id = any(p_profile_ids));

  insert into public.activity_log (actor_id, action, entity, entity_id, detail)
  values (
    auth.uid(),
    'connector_user_links.reassign',
    'connectors',
    p_from_connector,
    jsonb_build_object('to_connector', p_to_connector, 'members_moved', v_moving)
  );

  return v_moving;
end;
$$;

grant execute on function public.reassign_connector_members(uuid, uuid, uuid[]) to authenticated;

comment on function public.reassign_connector_members(uuid, uuid, uuid[]) is
  'Admin only. Moves members from one connector to another, all of them or a chosen few.';

-- ---------------------------------------------------------------------------
-- The deletion itself, with the cascade taken out
-- ---------------------------------------------------------------------------

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
  v_member_count        int;
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

    -- The change. A connector with members left is not deletable: those
    -- accounts are people, and where they sit is a decision somebody has to
    -- make deliberately.
    if v_target_role = 'connector' then
      select id into v_target_connector_id
      from public.connectors
      where profile_id = p_profile_id
      for update;

      if v_target_connector_id is not null then
        select count(*) into v_member_count
        from public.connector_user_links
        where connector_id = v_target_connector_id;

        if v_member_count > 0 then
          raise exception
            'That connector still has % member(s). Move them to another connector first.',
            v_member_count;
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
    'deleted_profiles', 1
  );
end;
$$;

comment on function public.delete_managed_profile(uuid) is
  'Deletes one account. A connector holding members is refused: move them first with reassign_connector_members.';
