-- ---------------------------------------------------------------------------
-- Connector claim codes: expiry, revocation, one pending per email, upgrade
-- in place; and an admin-settable connector capacity.
--
-- ACC-10, ADM-13. A claim code used to be good forever. It now lapses 30
-- days after it is created (Slack's workspace-invite expiry), an admin can
-- revoke one nobody has claimed yet, and an email may hold only one live
-- invitation at a time, so there is never a question of which code is the
-- real one. Re-issuing is creating again once the old one is revoked or has
-- lapsed. Revoked rows are kept, not deleted, so the code is refused as
-- "withdrawn" rather than "not recognised".
--
-- ACC-11. An event-only account can claim a connector invitation and is
-- upgraded in place — the same profile row, so its tickets, orders and
-- feedback stay. That is a role change, which protect_profile_fields pins
-- (20260923000101). redeem_code is the one caller allowed through, and says
-- so with its own transaction-local setting; PostgREST cannot call
-- set_config(), so no client can raise it.
--
-- ADM-11. Capacity can change after creation, never below the number who
-- have already joined and never below one.
-- ---------------------------------------------------------------------------

-- 1. Columns and checks -------------------------------------------------------

alter table public.connector_invitations
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz;

-- Existing invitations get the same 30 days, counted from when they were made.
update public.connector_invitations
set expires_at = created_at + interval '30 days'
where expires_at is null;

alter table public.connector_invitations
  alter column expires_at set default now() + interval '30 days',
  alter column expires_at set not null;

alter table public.connector_invitations
  drop constraint if exists connector_invitations_capacity_positive,
  add constraint connector_invitations_capacity_positive check (invite_capacity >= 1);

alter table public.connectors
  drop constraint if exists connectors_capacity_positive,
  add constraint connectors_capacity_positive check (invite_capacity >= 1);

-- 2. protect_profile_fields ---------------------------------------------------
--
-- 20260923000101's body, plus the one exemption: role may change while
-- amazing.claiming_connector is on, which only redeem_code sets.

create or replace function public.protect_profile_fields()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(current_setting('amazing.claiming_connector', true), '') <> 'on' then
    new.role := old.role;
  end if;
  if public.is_admin() then
    return new;
  end if;
  new.id             := old.id;
  new.profile_status := old.profile_status;
  new.created_at     := old.created_at;
  if coalesce(current_setting('amazing.redeeming_code', true), '') <> 'on' then
    new.network_member := old.network_member;
  end if;
  return new;
end;
$$;

-- 3. create_connector_invitation -------------------------------------------------

create or replace function public.create_connector_invitation(
  p_full_name text,
  p_email     text,
  p_capacity  int default 10
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_code  varchar;
  v_id    uuid;
  v_email text := lower(trim(p_email));
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can create a connector.';
  end if;
  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'A name is required.';
  end if;
  if coalesce(v_email, '') = '' then
    raise exception 'An email is required.';
  end if;
  if coalesce(p_capacity, 10) < 1 then
    raise exception 'Capacity must be at least 1.';
  end if;

  -- Two admins creating the same person at once must not both get through.
  perform pg_advisory_xact_lock(hashtext('connector_invitation:' || v_email));

  if exists (
    select 1 from public.connector_invitations
    where lower(email) = v_email
      and claimed_at is null and revoked_at is null and expires_at > now()
  ) then
    raise exception 'There is already a pending invitation for this email — revoke it first.';
  end if;

  loop
    v_code := public.generate_code('AMZ');
    exit when not exists (
      select 1 from public.connector_invitations where claim_code = v_code
      union all
      select 1 from public.invite_codes where code = v_code
    );
  end loop;

  insert into public.connector_invitations
    (full_name, email, invite_capacity, claim_code, created_by)
  values
    (trim(p_full_name), v_email, coalesce(p_capacity, 10), v_code, auth.uid())
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'claim_code', v_code);
end;
$$;

-- 4. revoke_connector_invitation ---------------------------------------------------

create or replace function public.revoke_connector_invitation(p_invitation_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_invitation public.connector_invitations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can revoke an invitation.';
  end if;

  select * into v_invitation from public.connector_invitations
  where id = p_invitation_id for update;

  if not found then
    raise exception 'That invitation no longer exists.';
  end if;
  if v_invitation.claimed_at is not null then
    raise exception 'This invitation has already been claimed. Change the connector''s status instead.';
  end if;
  if v_invitation.revoked_at is not null then
    raise exception 'This invitation has already been revoked.';
  end if;

  update public.connector_invitations set revoked_at = now() where id = p_invitation_id;
end;
$$;

-- 5. set_connector_capacity ----------------------------------------------------------

create or replace function public.set_connector_capacity(p_connector_id uuid, p_capacity int)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_joined int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change a connector''s capacity.';
  end if;
  if p_capacity is null or p_capacity < 1 then
    raise exception 'Capacity must be at least 1.';
  end if;

  -- The same lock redeem_code takes, so nobody joins between the count and
  -- the update.
  perform 1 from public.connectors where id = p_connector_id for update;
  if not found then
    raise exception 'That connector no longer exists.';
  end if;

  select count(*)::int into v_joined
  from public.connector_user_links where connector_id = p_connector_id;

  if p_capacity < v_joined then
    raise exception '% % already joined through this connector, so capacity cannot go below %.',
      v_joined, case when v_joined = 1 then 'person has' else 'people have' end, v_joined;
  end if;

  update public.connectors set invite_capacity = p_capacity where id = p_connector_id;
end;
$$;

-- 5b. The same floor for a direct table write ---------------------------------------
--
-- Admins may update connectors through the table as well (status), so the
-- floor has to live on the table, not only in the RPC above. A trigger
-- rather than a CHECK because it counts another table. It fires only when
-- capacity goes down; raising it, or any other column, is never refused.

create or replace function public.connector_capacity_floor()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_joined int;
begin
  select count(*)::int into v_joined
  from public.connector_user_links where connector_id = new.id;

  if new.invite_capacity < v_joined then
    raise exception '% % already joined through this connector, so capacity cannot go below %.',
      v_joined, case when v_joined = 1 then 'person has' else 'people have' end, v_joined;
  end if;
  return new;
end;
$$;

drop trigger if exists connectors_capacity_floor on public.connectors;
create trigger connectors_capacity_floor
  before update of invite_capacity on public.connectors
  for each row
  when (new.invite_capacity < old.invite_capacity)
  execute function public.connector_capacity_floor();

-- 6. redeem_code ------------------------------------------------------------------------
--
-- 20260922000001's body. Path A now refuses revoked and lapsed codes, and
-- upgrades an event-only profile instead of refusing it.

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
    if v_invitation.revoked_at is not null then
      raise exception 'This claim code has been withdrawn. Ask whoever sent it for a new one.';
    end if;
    if v_invitation.expires_at <= now() then
      raise exception 'This claim code expired on %. Ask whoever sent it for a new one.',
        to_char(v_invitation.expires_at, 'FMDD Mon YYYY');
    end if;

    if v_existing.id is null then
      insert into public.profiles (id, role, full_name, email, profile_status)
      values (
        v_uid, 'connector',
        coalesce(nullif(trim(p_full_name), ''), v_invitation.full_name),
        v_email, 'active'
      );
    else
      -- ACC-11. The event-only account becomes the connector: same row, so
      -- its tickets and orders are untouched.
      perform set_config('amazing.redeeming_code', 'on', true);
      perform set_config('amazing.claiming_connector', 'on', true);
      update public.profiles
      set role           = 'connector',
          network_member = true,
          full_name      = coalesce(nullif(trim(p_full_name), ''), full_name)
      where id = v_uid;
      perform set_config('amazing.claiming_connector', 'off', true);
      perform set_config('amazing.redeeming_code', 'off', true);
    end if;

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

-- 7. lookup_code ------------------------------------------------------------------------

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
    if v_invitation.revoked_at is not null then
      return jsonb_build_object('valid', false, 'kind', 'connector_claim',
                                'reason', 'This claim code has been withdrawn. Ask whoever sent it for a new one.');
    end if;
    if v_invitation.expires_at <= now() then
      return jsonb_build_object('valid', false, 'kind', 'connector_claim',
                                'reason', format('This claim code expired on %s. Ask whoever sent it for a new one.',
                                                 to_char(v_invitation.expires_at, 'FMDD Mon YYYY')));
    end if;
    return jsonb_build_object(
      'valid', true,
      'kind', 'connector_claim',
      'full_name', v_invitation.full_name,
      'email', v_invitation.email,
      'invite_capacity', v_invitation.invite_capacity,
      'expires_at', v_invitation.expires_at
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

-- 8. Grants -----------------------------------------------------------------------------

revoke execute on function public.revoke_connector_invitation(uuid)  from public, anon;
revoke execute on function public.set_connector_capacity(uuid, int)  from public, anon;
grant  execute on function public.revoke_connector_invitation(uuid)  to authenticated;
grant  execute on function public.set_connector_capacity(uuid, int)  to authenticated;
