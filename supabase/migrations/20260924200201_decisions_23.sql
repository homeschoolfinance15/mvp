-- ============================================================================
-- Two decisions from the browser re-test
--
-- #8. An erased account is registered as "Deleted account 8F2A", not "Former
-- attendee 8F2A": most people who close an account never bought a ticket.
-- Only new erasures get the new label; rows already registered keep theirs.
--
-- #10. A connector invitation for an email that already has a login could
-- never be claimed: the claim creates the login. Refuse it up front, and say
-- what to do instead.
--
-- create or replace keeps each function's grants.
-- ============================================================================

create or replace function public.record_data_subject_erasure()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_pseudonym text;
begin
  v_pseudonym := 'Deleted account ' || upper(substr(replace(old.id::text, '-', ''), 1, 4));

  insert into public.data_subject_erasures
    (subject_id, pseudonym, retention_until, lawful_basis, synthetic)
  values (
    old.id,
    v_pseudonym,
    (now() + make_interval(years => public.erasure_retention_years()))::date,
    'legal_obligation',
    coalesce(lower(old.email) like '%.invalid', false)
  )
  on conflict (subject_id) do nothing;

  update public.event_orders     set erased_subject_id = old.id where profile_id = old.id;
  update public.event_attendance set erased_subject_id = old.id where profile_id = old.id;
  update public.peer_feedback    set erased_subject_id = old.id where author_id  = old.id;
  update public.event_feedback   set erased_subject_id = old.id where author_id  = old.id;

  return old;
end;
$$;

create or replace function public.create_connector_invitation(
  p_full_name text,
  p_email     text,
  p_capacity  integer default 10
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

  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'This email already has an account. Ask them to use a member code, or promote them separately.';
  end if;

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
