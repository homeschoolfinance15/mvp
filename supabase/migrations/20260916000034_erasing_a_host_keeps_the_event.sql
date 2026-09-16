-- ============================================================================
-- Erasing a host must not erase the event, its attendees or their money
--
-- ORG-15: "Event information is platform data, not data stored inside or owned
-- by the administrator's personal account. Replacing or adding an
-- administrator must not detach, duplicate, or erase event history."
--
-- It could. `events.host_id` is `on delete cascade` to profiles
-- (20260907000004:39), and every event-owned table is `on delete cascade` to
-- events. So deleting one host's profile took this path:
--
--   profiles -> events -> event_orders, event_registrations, event_tickets,
--               event_attendance, event_feedback, peer_feedback,
--               event_invites, event_messages, ticket_types, …
--
-- 20260916000016 went to real trouble to stop an *attendee* erasure taking the
-- money with it — `event_orders.profile_id` and `event_attendance.profile_id`
-- became `on delete set null` precisely so that "the money moved, and nothing
-- about somebody leaving makes it not have moved". The host route walked
-- straight past that: the orders were not detached from the person, they were
-- deleted outright along with the event they belonged to. One connector
-- closing their account would have taken every ticket their attendees had
-- bought, and DATA-PROTECTION.md's position — that a paid order survives an
-- erasure under Art. 17(3)(b) and Companies Act s.388 — with it.
--
-- 20260916000011 named this exact hole and declined to close it in a
-- migration, correctly: it listed two answers, "anonymise the person and keep
-- the record" or "refuse deletion while records exist", and said the choice
-- belongs to whoever decides what Amazing promises people.
--
-- This takes the second, as a guard, and deliberately not the first.
--
-- `host_id` is `not null` and read as a non-null profile id across the schema
-- and the UI — `events_insert`'s `host_id = auth.uid()`, `event_host_ids()`,
-- `may_host_events(host_id)` in `events_update`, and every screen that shows
-- who is hosting. Making it nullable is the better end state and matches the
-- audit log's precedent, but it is a wide change that wants its own migration
-- and its own pass over those readers. A guard stops the data loss today
-- without half-doing that.
--
-- ponytail: refuses, like the refund guard beside it, and names the way out in
-- the message rather than offering a quiet override. The upgrade path is
-- nullable host_id + `on delete set null` + an "account removed" host label;
-- do that and this guard can go.
-- ============================================================================

create or replace function public.guard_account_closure()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_events int;
begin
  -- Unchanged: money in flight (20260916000011).
  if exists (
    select 1
    from public.event_refunds r
    join public.event_orders o on o.id = r.order_id
    where o.profile_id = old.id
      and r.status in ('requested', 'processing')
  ) then
    raise exception
      'This account has a refund still in progress. It can be closed once the refund settles.';
  end if;

  -- New: an event with a history behind it.
  --
  -- Only events that somebody else is involved in. A host who made a draft
  -- nobody ever saw, or published something no one registered for, is not
  -- holding anybody's history and should not be trapped by it — erasure is a
  -- right, and a guard that refuses every host forever would be us keeping
  -- personal data because deleting it is inconvenient. The test is whether a
  -- third party has something at stake: a registration, an order, or a
  -- recorded attendance.
  select count(*) into v_events
  from public.events e
  where e.host_id = old.id
    and (
      exists (select 1 from public.event_registrations r where r.event_id = e.id)
      or exists (select 1 from public.event_orders o where o.event_id = e.id)
      or exists (select 1 from public.event_attendance a where a.event_id = e.id)
    );

  if v_events > 0 then
    -- The remedy has to be one that actually works. An earlier draft of this
    -- message offered "cancel them and settle any refunds", which does not:
    -- cancelling only sets `events.status = 'cancelled'`, and the
    -- registrations, orders and attendance rows survive on purpose, so the
    -- tests above still fire and still refuse. Sending an administrator round
    -- that loop is worse than refusing plainly.
    --
    -- Reassigning the host is the only thing that clears this today, and it
    -- has no UI — `events_update` permits an admin to set `host_id` to another
    -- admin or connector, but no screen does it. Said plainly rather than
    -- implied, so nobody hunts for a button that is not there.
    raise exception
      'This account hosts % event(s) that people have registered for, paid for or attended. '
      'Deleting it would delete those events and every ticket, payment and attendance record '
      'with them. Reassign those events to another host before deleting this account. '
      'Cancelling them does not release this: a cancelled event keeps its registrations, '
      'orders and attendance, which is what has to be preserved.',
      v_events;
  end if;

  return old;
end;
$$;

comment on function public.guard_account_closure() is
  '§9, ORG-15. Refuses to delete a profile while a refund is in flight, or while it hosts an event anybody has registered for, paid for or attended — events.host_id cascades, so that deletion would take the event and all of its records. Every caller, not just delete_my_account(): a cascade from auth.users fires this trigger too, so deleting the auth user fails with it.';

-- ---------------------------------------------------------------------------
-- What still gets past this, for whoever writes the next migration
--
-- A row-level BEFORE DELETE trigger covers every delete the application and
-- PostgREST can reach, including the cascade from auth.users. Three things
-- skip it, and only one is a live risk here:
--
--   TRUNCATE                         fires statement-level triggers only.
--   ALTER TABLE … DISABLE TRIGGER    this repo already does exactly that —
--                                    20260916000009:57 disables
--                                    trg_issue_ticket_on_confirm for the
--                                    legacy backfill. A future migration doing
--                                    bulk work on `profiles` the same way
--                                    would reopen this hole silently, which is
--                                    the reason this note exists.
--   session_replication_role=replica what `pg_restore --disable-triggers` and
--                                    logical replication apply use. A restore
--                                    into this schema does not fire the guard.
--
-- Trigger order is load-bearing and unchanged: same-timing triggers fire in
-- name order, and `trg_guard_account_closure` sorts before
-- `trg_record_data_subject_erasure`, so a refusal happens before any erasure
-- is stamped. This migration replaces the function, not the trigger, which is
-- what keeps that true.
--
-- Cohosts are deliberately not guarded: `event_hosts.profile_id` cascades to
-- the host row only (20260909000001:63), so removing a cohost never touches
-- the event.
-- ---------------------------------------------------------------------------
