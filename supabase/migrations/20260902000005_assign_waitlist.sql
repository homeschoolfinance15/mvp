-- ============================================================================
-- Waitlist assignment
--
-- An admin vets someone who arrived through the public page and hands them to
-- a connector: mint an invitation code out of that connector's remaining
-- capacity and stamp the entry so it stops reading as unhandled.
--
-- create_invite_code() mints for my_connector_id(), so an admin — who has no
-- connector row — cannot call it. This is the admin-side counterpart.
-- ============================================================================

alter table public.waitlist_entries
  add column assigned_at           timestamptz,
  add column assigned_connector_id uuid references public.connectors (id)   on delete set null,
  add column assigned_code_id      uuid references public.invite_codes (id) on delete set null;

create or replace function public.assign_waitlist_entry(
  p_entry_id     uuid,
  p_connector_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_assigned timestamptz;
  v_status   connector_status;
  v_code     varchar;
  v_id       uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can assign a waitlist entry.';
  end if;

  -- Lock the row so two admins cannot assign the same person twice.
  select assigned_at into v_assigned
  from public.waitlist_entries
  where id = p_entry_id
  for update;

  if not found then
    raise exception 'That waitlist entry no longer exists.';
  end if;
  if v_assigned is not null then
    raise exception 'That person has already been assigned a connector.';
  end if;

  select invite_status into v_status from public.connectors where id = p_connector_id;
  if v_status is null then
    raise exception 'That connector does not exist.';
  end if;
  if v_status <> 'active' then
    raise exception 'That connector''s inviting privileges are currently %.', v_status;
  end if;

  if public.connector_available_capacity(p_connector_id) <= 0 then
    raise exception 'That connector has no invitations left to allocate.';
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
  values (p_connector_id, v_code, 'active', 1, 0)
  returning id into v_id;

  update public.waitlist_entries
  set assigned_at           = now(),
      assigned_connector_id = p_connector_id,
      assigned_code_id      = v_id
  where id = p_entry_id;

  return jsonb_build_object('code', v_code, 'invite_code_id', v_id);
end;
$$;

grant execute on function public.assign_waitlist_entry(uuid, uuid) to authenticated;
