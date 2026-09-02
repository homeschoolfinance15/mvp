-- ============================================================================
-- Invitation capacity counts people who joined, not codes issued.
--
-- The original model reserved capacity against every live code's unused uses.
-- Because a connector's first code is minted with max_uses = invite_capacity,
-- that reserved the whole budget immediately and made it impossible to ever
-- create a second code. Enforcing the limit at redemption instead lets a
-- connector shape their codes however they like while the ceiling still holds.
-- ============================================================================

create or replace function public.connector_available_capacity(p_connector_id uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select greatest(
    0,
    (select invite_capacity from public.connectors where id = p_connector_id)
    - (select count(*)::int from public.connector_user_links
       where connector_id = p_connector_id)
  );
$$;

-- Codes may now be minted freely up to the remaining headroom; several codes
-- may sum to more than capacity, and redemption is what actually rations it.
create or replace function public.create_invite_code(p_max_uses int default 1)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_connector_id uuid := public.my_connector_id();
  v_status       connector_status;
  v_remaining    int;
  v_uses         int := greatest(coalesce(p_max_uses, 1), 1);
  v_code         varchar;
  v_id           uuid;
begin
  if v_connector_id is null then
    raise exception 'Only a connector can create invitation codes.';
  end if;

  select invite_status into v_status from public.connectors where id = v_connector_id;
  if v_status <> 'active' then
    raise exception 'Your inviting privileges are currently %.', v_status;
  end if;

  v_remaining := public.connector_available_capacity(v_connector_id);
  if v_remaining <= 0 then
    raise exception 'You have reached your invitation limit.';
  end if;
  if v_uses > v_remaining then
    raise exception 'You have only % invitation(s) remaining.', v_remaining;
  end if;

  loop
    v_code := public.generate_code('AMZ');
    exit when not exists (
      select 1 from public.invite_codes where code = v_code
      union all
      select 1 from public.connector_invitations where claim_code = v_code
    );
  end loop;

  insert into public.invite_codes (connector_id, code, status, max_uses, use_count)
  values (v_connector_id, v_code, 'active', v_uses, 0)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'code', v_code, 'max_uses', v_uses);
end;
$$;

-- Re-activating a code no longer has to fit a reservation budget.
create or replace function public.set_invite_code_status(p_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_connector_id uuid := public.my_connector_id();
  v_code         public.invite_codes%rowtype;
  v_target       invite_status := p_status::invite_status;
begin
  if v_connector_id is null then
    raise exception 'Only a connector can change an invitation code.';
  end if;
  if v_target not in ('active', 'disabled') then
    raise exception 'A code can only be set to active or disabled.';
  end if;

  select * into v_code from public.invite_codes
  where id = p_id and connector_id = v_connector_id
  for update;

  if not found then
    raise exception 'That invitation code is not yours.';
  end if;
  if v_code.use_count >= v_code.max_uses then
    raise exception 'That invitation code has already been fully used.';
  end if;

  update public.invite_codes set status = v_target where id = p_id;
  return jsonb_build_object('id', p_id, 'status', v_target);
end;
$$;

-- Redemption is now where capacity is actually enforced.
create or replace function public.redeem_code(p_code text, p_full_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_email        text;
  v_invitation   public.connector_invitations%rowtype;
  v_code         public.invite_codes%rowtype;
  v_connector    public.connectors%rowtype;
  v_connector_id uuid;
  v_joined       int;
  v_new_code     varchar;
begin
  if v_uid is null then
    raise exception 'You must be signed in to redeem a code.';
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'This account is already set up.';
  end if;

  select email into v_email from auth.users where id = v_uid;

  -- Path A: a connector claiming the account an admin created for them.
  select * into v_invitation
  from public.connector_invitations
  where upper(claim_code) = upper(trim(p_code))
  for update;

  if found then
    if v_invitation.claimed_at is not null then
      raise exception 'This claim code has already been used.';
    end if;

    insert into public.profiles (id, role, full_name, email, profile_status)
    values (
      v_uid, 'connector',
      coalesce(nullif(trim(p_full_name), ''), v_invitation.full_name),
      v_email, 'active'
    );

    insert into public.connectors (profile_id, invite_status, invite_capacity)
    values (v_uid, 'active', v_invitation.invite_capacity)
    returning id into v_connector_id;

    loop
      v_new_code := public.generate_code('AMZ');
      exit when not exists (select 1 from public.invite_codes where code = v_new_code);
    end loop;

    insert into public.invite_codes (connector_id, code, status, max_uses, use_count)
    values (v_connector_id, v_new_code, 'active',
            greatest(v_invitation.invite_capacity, 1), 0);

    update public.connector_invitations
    set claimed_at = now(), claimed_by = v_uid
    where id = v_invitation.id;

    return jsonb_build_object('role', 'connector',
                              'connector_id', v_connector_id,
                              'invite_code', v_new_code);
  end if;

  -- Path B: a member joining on a connector's invite code.
  select * into v_code
  from public.invite_codes
  where upper(code) = upper(trim(p_code))
  for update;

  if not found then
    raise exception 'We don''t recognise that code.';
  end if;

  select * into v_connector from public.connectors
  where id = v_code.connector_id for update;

  if v_code.status <> 'active' then
    raise exception 'This invitation code is no longer active.';
  end if;
  if v_code.use_count >= v_code.max_uses then
    raise exception 'This invitation code has been fully used.';
  end if;
  if v_connector.invite_status <> 'active' then
    raise exception 'This connector is not currently inviting.';
  end if;

  select count(*)::int into v_joined
  from public.connector_user_links where connector_id = v_connector.id;

  if v_joined >= v_connector.invite_capacity then
    raise exception 'This connector has reached their invitation limit.';
  end if;

  insert into public.profiles (id, role, full_name, email, profile_status)
  values (v_uid, 'user', trim(p_full_name), v_email, 'active');

  insert into public.connector_user_links (connector_id, user_profile_id, invite_code_id)
  values (v_code.connector_id, v_uid, v_code.id);

  update public.invite_codes
  set use_count = use_count + 1,
      status = case
                 when use_count + 1 >= max_uses then 'exhausted'::invite_status
                 else status
               end
  where id = v_code.id;

  return jsonb_build_object('role', 'user', 'connector_id', v_code.connector_id);
end;
$$;

-- lookup_code should also refuse a code whose connector is already full,
-- rather than letting someone fill in a signup form that cannot succeed.
create or replace function public.lookup_code(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_invitation     public.connector_invitations%rowtype;
  v_code           public.invite_codes%rowtype;
  v_connector      public.connectors%rowtype;
  v_connector_name text;
  v_joined         int;
begin
  if p_code is null or trim(p_code) = '' then
    return jsonb_build_object('valid', false, 'kind', 'invalid',
                              'reason', 'Enter your invitation code.');
  end if;

  select * into v_invitation
  from public.connector_invitations
  where upper(claim_code) = upper(trim(p_code));

  if found then
    if v_invitation.claimed_at is not null then
      return jsonb_build_object('valid', false, 'kind', 'connector_claim',
                                'reason', 'This claim code has already been used.');
    end if;
    return jsonb_build_object(
      'valid', true,
      'kind', 'connector_claim',
      'full_name', v_invitation.full_name,
      'email', v_invitation.email,
      'invite_capacity', v_invitation.invite_capacity
    );
  end if;

  select * into v_code
  from public.invite_codes
  where upper(code) = upper(trim(p_code));

  if found then
    select * into v_connector from public.connectors where id = v_code.connector_id;

    if v_code.status <> 'active' then
      return jsonb_build_object('valid', false, 'kind', 'user_invite',
                                'reason', 'This invitation code is no longer active.');
    end if;
    if v_code.use_count >= v_code.max_uses then
      return jsonb_build_object('valid', false, 'kind', 'user_invite',
                                'reason', 'This invitation code has been fully used.');
    end if;
    if v_connector.invite_status <> 'active' then
      return jsonb_build_object('valid', false, 'kind', 'user_invite',
                                'reason', 'This connector is not currently inviting.');
    end if;

    select count(*)::int into v_joined
    from public.connector_user_links where connector_id = v_connector.id;

    if v_joined >= v_connector.invite_capacity then
      return jsonb_build_object('valid', false, 'kind', 'user_invite',
                                'reason', 'This connector has reached their invitation limit.');
    end if;

    select p.full_name into v_connector_name
    from public.profiles p where p.id = v_connector.profile_id;

    return jsonb_build_object(
      'valid', true,
      'kind', 'user_invite',
      'connector_name', v_connector_name,
      'remaining', v_code.max_uses - v_code.use_count
    );
  end if;

  return jsonb_build_object('valid', false, 'kind', 'invalid',
                            'reason', 'We don''t recognise that code.');
end;
$$;
