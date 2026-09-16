-- ============================================================================
-- Three races and a warning
--
--   A  two 'cancelled' messages could exist for one event, so an attendee got
--      two cancellation emails
--   B  a pending registration with no hold expiry consumed a place forever
--   C  two devices scanning the same ticket at once reported a service error
--      instead of "already checked in"
--   D  a note about where the paid-sales gate is, and is not, evaluated
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. One cancellation message per event, enforced by the schema
--
-- reschedule_event_messages() queues a 'cancelled' message when an event is
-- called off, and the editor screen was invoking the mailer for another. While
-- 'cancelled' was an unresolvable kind the second row was a harmless phantom —
-- claimed, no recipients, stamped sent. Making it resolvable turned that
-- phantom into a real second email to every attendee.
--
-- The client invoke is going away, which fixes it once. This index is what
-- stops it coming back: reminders have event_messages_live_reminder_idx and
-- feedback_open has event_messages_live_feedback_idx, and 'cancelled' had
-- nothing, which is the only reason two rows could coexist at all. With it, a
-- second producer fails loudly on insert instead of quietly mailing everybody
-- twice.
--
-- The existing duplicates have to go first or the index cannot be built. The
-- earliest row per event survives, which is the SQL one: the trigger fires
-- inside the transaction that cancelled the event, before any client could
-- have invoked anything. Only unsent rows are touched — a message that has
-- already gone out is history and stays as it is.
-- ---------------------------------------------------------------------------

with ranked as (
  select id, row_number() over (partition by event_id order by created_at, id) as n
  from public.event_messages
  where kind = 'cancelled' and status = 'scheduled'
)
update public.event_messages m
set status = 'cancelled',
    error  = 'Superseded: one cancellation message per event (20260916000021).'
from ranked r
where m.id = r.id and r.n > 1;

create unique index event_messages_live_cancelled_idx
  on public.event_messages (event_id)
  where kind = 'cancelled' and status = 'scheduled';

-- ---------------------------------------------------------------------------
-- B. A hold with no expiry is not a hold — BUY-06
--
-- Both places that count a taken seat read
--
--     r.status = 'pending' and (r.hold_expires_at is null or ... > now())
--
-- so a pending row with a null expiry counted as taken. expire_event_holds()
-- requires `hold_expires_at is not null`, so it was never swept either. The
-- seat was gone permanently, which is precisely what BUY-06 forbids.
--
-- Fixed by counting rather than by policy, because that closes the hole
-- however such a row arrives rather than only through the door somebody
-- thought of, and because it inverts the failure: a stray row now leaves a
-- place sellable instead of destroying it. Overselling by one is recoverable
-- at a door; a seat that can never be sold again is not recoverable at all.
--
-- Checked before committing to it, as asked. Nothing legitimate writes a
-- pending registration without an expiry:
--
--   stripe-checkout  sets hold_expires_at on the insert (index.ts:382) and on
--                    the update that reuses an existing hold (:366)
--   stripe-webhook   writes hold_expires_at = null only in the same statement
--                    that moves the row to 'confirmed' (:271-280) or to
--                    'expired' (:352), and neither is counted as a pending hold
--   register_free()  inserts straight to 'confirmed' and never sets one
--
-- The sweep is widened to match. Without it the place is sellable again but
-- the person holding the phantom row still cannot register, because the
-- partial unique index on (event_id, profile_id) still sees a live row — half
-- a fix, and the visible half is the one nobody would notice was missing.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_event_capacity()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_event public.events%rowtype;
  v_taken int;
  v_cap   int;
begin
  -- Only a row that takes a place is interesting. Cancelling and expiring give
  -- one back, and nothing needs locking to give something back.
  if new.status not in ('pending', 'confirmed') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('pending', 'confirmed') then
    return new;
  end if;

  select * into v_event from public.events where id = new.event_id for update;

  if not found then
    raise exception 'That event no longer exists.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'This event has been cancelled.';
  end if;
  if v_event.status <> 'published' then
    raise exception 'This event is not open for registration.';
  end if;
  if v_event.registration_closed then
    raise exception 'Registration for this event is closed.';
  end if;

  if v_event.capacity is not null then
    -- BUY-06. A pending row with no expiry is not a hold and takes nothing.
    select count(*) into v_taken
      from public.event_registrations r
     where r.event_id = new.event_id
       and r.id <> new.id
       and (r.status = 'confirmed'
            or (r.status = 'pending' and r.hold_expires_at > now()));

    if v_taken >= v_event.capacity then
      raise exception 'This event is sold out.';
    end if;
  end if;

  -- A ticket option may also cap itself, which is a smaller question and needs
  -- no lock of its own: the event lock above already serialises everybody
  -- competing for this event.
  if new.ticket_type_id is not null then
    select t.quantity into v_cap from public.ticket_types t where t.id = new.ticket_type_id;

    if v_cap is not null then
      select count(*) into v_taken
        from public.event_registrations r
       where r.ticket_type_id = new.ticket_type_id
         and r.id <> new.id
         and (r.status = 'confirmed'
              or (r.status = 'pending' and r.hold_expires_at > now()));

      if v_taken >= v_cap then
        raise exception 'That ticket option is sold out.';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.event_capacity_state(p_event uuid)
returns table (capacity int, confirmed int, remaining int, state text)
language sql stable security definer set search_path = public
as $$
  select
    e.capacity,
    c.confirmed,
    case when e.capacity is null then null
         else greatest(e.capacity - c.taken, 0) end,
    case
      when e.status = 'cancelled'                                then 'cancelled'
      when coalesce(e.ends_at, e.starts_at) < now()              then 'finished'
      when e.status <> 'published'                               then 'closed'
      when e.registration_closed                                 then 'closed'
      when e.capacity is not null and c.taken >= e.capacity      then 'sold_out'
      else 'open'
    end
  from public.events e
  cross join lateral (
    select
      count(*) filter (where r.status = 'confirmed')::int as confirmed,
      -- BUY-06. Same rule as the capacity trigger: no expiry, no hold.
      count(*) filter (
        where r.status = 'confirmed'
           or (r.status = 'pending' and r.hold_expires_at > now())
      )::int as taken
    from public.event_registrations r
    where r.event_id = e.id
  ) c
  where e.id = p_event;
$$;

create or replace function public.expire_event_holds(p_event uuid default null)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_count int;
begin
  update public.event_registrations
  set status = 'expired'
  where status = 'pending'
    -- A null expiry is swept too. It counts for nothing against capacity now,
    -- but while it sits there the live-registration index stops that person
    -- ever registering again.
    and (hold_expires_at is null or hold_expires_at <= now())
    and (p_event is null or event_id = p_event);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.expire_event_holds(uuid) is
  'BUY-06. Releases checkout holds whose twenty minutes are up, and pending rows that never carried an expiry at all. Safe for anyone to call at any time.';

-- ---------------------------------------------------------------------------
-- C. Two scanners, one ticket — ATT-02
--
-- check_in() read event_attendance and then inserted, with nothing in between.
-- Two stewards scanning the same ticket in the same instant both passed the
-- exists() check, and the second lost the unique constraint and raised — which
-- the door renders as a service problem.
--
-- ATT-03 was never in danger: the constraint is what guarantees one arrival,
-- and it did its job. The damage is what the second steward is told. §11 says
-- the subsequent scan reports "already checked in", and "we couldn't tell" is
-- the one answer that leaves somebody at a door not knowing whether to let a
-- person in.
--
-- The separate exists() check is gone rather than kept as a fast path. The
-- insert is now the only thing that decides, so there is one answer instead of
-- two that can disagree, and no window between them.
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
  'ATT-02/03. Scans a ticket at the door and answers ok | already | wrong_event | invalid | cancelled. Two devices scanning at once record one arrival and the loser is told "already", not "error".';

-- ---------------------------------------------------------------------------
-- D. Where the paid-sales gate is, and is not, evaluated
--
-- No code. A warning, recorded where somebody trimming a check would find it.
-- ---------------------------------------------------------------------------

comment on function public.may_sell_paid_events(uuid) is
  '§7.3. Whether paid tickets may go on sale against that payment account. Null connector means Amazing''s own Stripe. Free events never ask this. NOTE: enforce_event_lifecycle() evaluates this only on the transition into published — adding a paid ticket type to an already-published free event does not re-run it. That is not a hole today because stripe-checkout re-checks charges_enabled at every checkout and is the only road to a card, but it does mean the SQL layer is not independently sufficient here. Do not remove the edge-function check as redundant without adding a trigger on ticket_types first.';
