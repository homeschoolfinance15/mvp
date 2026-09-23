-- ---------------------------------------------------------------------------
-- redeem_code / lookup_code — capacity, exhausted codes, blank names
--
-- 20260916000002_event_accounts redefined redeem_code for ACC-06 from the
-- init body, and in doing so dropped the capacity check that
-- 20260902000002_capacity_on_join had added. Codes may add up to more than a
-- connector's capacity by design, so redemption is the only thing holding the
-- ceiling. It is back, with the connector row locked so two different codes
-- redeemed at once cannot both take the last place.
--
-- An exhausted code is marked status = 'exhausted', so the generic "no longer
-- active" check fired first and "fully used" was unreachable. The use check
-- now comes first, in both functions.
--
-- A new member must give a name. An event-only account being upgraded keeps
-- its existing name when none is given, as before.
-- ---------------------------------------------------------------------------

create or replace function public.redeem_code(p_code text, p_full_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_email        text;
  v_existing     public.profiles%rowtype;
  v_invitation   public.connector_invitations%rowtype;
  v_code         public.invite_codes%rowtype;
  v_connector    public.connectors%rowtype;
  v_connector_id uuid;
  v_new_code     varchar;
  v_joined       int;
begin
  if v_uid is null then
    raise exception 'You must be signed in to redeem a code.';
  end if;

  select * into v_existing from public.profiles where id = v_uid;

  -- Already in the network: there is nothing left to redeem. Only the
  -- event-only case carries on past here.
  if found and v_existing.network_member then
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
    if v_existing.id is not null then
      raise exception 'This account is already set up.';
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

  -- Locked: the capacity count below must hold until this join commits.
  select * into v_connector from public.connectors
  where id = v_code.connector_id for update;

  if v_code.status = 'exhausted' or v_code.use_count >= v_code.max_uses then
    raise exception 'This invitation code has been fully used.';
  end if;
  if v_code.status <> 'active' then
    raise exception 'This invitation code is no longer active.';
  end if;
  if v_connector.invite_status <> 'active' then
    raise exception 'This connector is not currently inviting.';
  end if;

  select count(*)::int into v_joined
  from public.connector_user_links where connector_id = v_connector.id;

  if v_joined >= v_connector.invite_capacity then
    raise exception 'This connector has reached their invitation limit.';
  end if;

  if v_existing.id is null then
    if coalesce(btrim(p_full_name), '') = '' then
      raise exception 'A name is required.';
    end if;
    insert into public.profiles (id, role, full_name, email, profile_status)
    values (v_uid, 'user', trim(p_full_name), v_email, 'active');
  else
    -- ACC-06. The same person, now let in properly. Their name is overwritten
    -- only if they gave one; their tickets and orders are untouched.
    perform set_config('amazing.redeeming_code', 'on', true);
    update public.profiles
    set network_member = true,
        full_name      = coalesce(nullif(trim(p_full_name), ''), full_name)
    where id = v_uid;
    perform set_config('amazing.redeeming_code', 'off', true);
  end if;

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

    if v_code.status = 'exhausted' or v_code.use_count >= v_code.max_uses then
      return jsonb_build_object('valid', false, 'kind', 'user_invite',
                                'reason', 'This invitation code has been fully used.');
    end if;
    if v_code.status <> 'active' then
      return jsonb_build_object('valid', false, 'kind', 'user_invite',
                                'reason', 'This invitation code is no longer active.');
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
