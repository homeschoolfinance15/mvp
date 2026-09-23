-- ---------------------------------------------------------------------------
-- A cancelled event admits nobody, and a reinstated guest can get in
--
-- ORG-5. Cancelling an event left every ticket scanning "ok": check_in()
-- looked at the ticket and the registration but never at the event, so the
-- door recorded arrivals for a night the organiser had been told no longer
-- admits anybody. The event's own status is now part of the "cancelled"
-- answer, checked after wrong_event so a ticket for another event is still
-- called what it is.
--
-- ORG-24. A registration cancelled and then confirmed again kept its original,
-- revoked ticket (on conflict do nothing), so the guest was confirmed and
-- turned away. The same ticket is kept — its code may already be in their
-- inbox — and simply made valid again.
-- ---------------------------------------------------------------------------

create or replace function public.check_in(p_ticket_code text, p_event uuid)
returns check_in_result
language plpgsql security definer set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_ticket public.event_tickets%rowtype;
  v_reg    public.event_registrations%rowtype;
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;
  if not (public.hosts_event(p_event) or public.is_admin()) then
    raise exception 'Only a host can check people in.';
  end if;

  select * into v_ticket from public.event_tickets
   where code = btrim(lower(p_ticket_code));
  if not found then
    return 'invalid';
  end if;

  if v_ticket.event_id <> p_event then
    return 'wrong_event';
  end if;

  select * into v_reg from public.event_registrations where id = v_ticket.registration_id;
  if v_ticket.revoked_at is not null
     or v_reg.status is distinct from 'confirmed'
     or exists (select 1 from public.events e where e.id = p_event and e.status = 'cancelled')
  then
    return 'cancelled';
  end if;

  -- ATT-03 and the race. The unique constraint decides, and losing it is an
  -- ordinary outcome at a door rather than an error: somebody else scanned
  -- this ticket first, possibly a tenth of a second ago on another phone.
  insert into public.event_attendance
    (event_id, profile_id, method, ticket_id, recorded_by)
  values
    (p_event, v_ticket.profile_id, 'scan', v_ticket.id, v_me)
  on conflict (event_id, profile_id) do nothing;

  if not found then
    return 'already';
  end if;

  return 'ok';
end;
$$;

comment on function public.check_in(text, uuid) is
  'ATT-02/03. Scans a ticket at the door and answers ok | already | wrong_event | invalid | cancelled. A cancelled event answers cancelled for every one of its tickets. Two devices scanning at once record one arrival and the loser is told "already", not "error".';

create or replace function public.issue_ticket_on_confirm()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_host uuid;
begin
  if new.status <> 'confirmed' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'confirmed' then
    return null;
  end if;

  -- ORG-24. A reinstated registration keeps its one ticket, made valid again.
  insert into public.event_tickets (registration_id, event_id, profile_id, code)
  values (
    new.id, new.event_id, new.profile_id,
    encode(extensions.gen_random_bytes(16), 'hex')
  )
  on conflict (registration_id) do update set revoked_at = null;

  -- The same shape as the RSVP notice this replaces: every host hears, and
  -- nobody hears about themselves.
  for v_host in select h.profile_id from public.event_host_ids(new.event_id) h loop
    if v_host <> new.profile_id then
      insert into public.notifications (profile_id, kind, actor_id, event_id)
      values (v_host, 'event_registered', new.profile_id, new.event_id);
    end if;
  end loop;

  return null;
end;
$$;
