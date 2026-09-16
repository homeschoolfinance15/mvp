-- ============================================================================
-- The messages nothing was producing
--
-- The queue was built and three of the things that should fill it never did.
-- EML-01 says these go out "automatically when the relevant action or
-- scheduled time occurs" and EML-11 says the organiser must not have to keep
-- the dashboard open. An email queued by the browser that called
-- register_free() satisfies neither: close the tab at the wrong moment and the
-- attendee has a ticket, no confirmation, and nothing anywhere recording that
-- one was owed.
--
-- So these are triggers, for the same reason log_activity() is a trigger:
-- a trigger cannot be forgotten at a call site, and it still fires for a change
-- made straight against the database. Three producers:
--
--   confirmation         a registration reaches 'confirmed' with no order
--   attendee_cancelled   a registration reaches 'cancelled'
--   feedback_open        a late attendance correction, added to an initial
--                        request that has already gone (FDB-06)
--
-- Reminders and the scheduling of feedback_open are deliberately NOT here.
-- schedule_event_messages() already owns those rows, and EML-06 needs exactly
-- one producer per message: a second writer collides with
-- event_messages_live_reminder_idx and fails.
--
-- ---------------------------------------------------------------------------
-- Why not queue_event_message() and event_message_audience()
--
-- Both were built for a different job and neither fits, which is worth saying
-- plainly rather than bending them:
--
--   queue_event_message()    refuses anybody who is not a host of the event,
--                            and restricts the kind to the five a host sends
--                            by hand. An attendee registering for something is
--                            neither a host nor sending anything. Both guards
--                            are correct for what that function is — the
--                            deliberate act in ORG-10 — and wrong here.
--
--   event_message_audience() answers "everybody with a live registration",
--                            which is the audience for a broadcast. A
--                            confirmation goes to exactly one person.
--
-- Hence queue_personal_message() below, which writes the message and its single
-- recipient row together. That pairing is load-bearing: the dispatcher
-- materialises an audience for a claimed message that has none, so a personal
-- message that arrived without its recipient row would be broadcast to the
-- whole event. One person's confirmation, sent to two hundred people.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. One message, one recipient
--
-- EML-05 is satisfied by construction: one row per person means one Resend
-- message per person, and nobody appears in anybody else's headers.
--
-- Somebody with no email address, or whose profile has been suspended or
-- removed, produces no message at all rather than a message with nobody in it
-- — a queue row that can never be delivered is a permanent 'scheduled' entry
-- the organiser has to interpret.
-- ---------------------------------------------------------------------------

create or replace function public.queue_personal_message(
  p_event   uuid,
  p_kind    text,
  p_profile uuid
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_email text;
  v_id    uuid;
begin
  select p.email::text into v_email
  from public.profiles p
  where p.id = p_profile
    and p.profile_status not in ('suspended', 'removed')
    and coalesce(btrim(p.email), '') <> '';

  if v_email is null then
    return null;
  end if;

  insert into public.event_messages (event_id, kind, scheduled_for, status, audience_count)
  values (p_event, p_kind, now(), 'scheduled', 1)
  returning id into v_id;

  insert into public.event_message_recipients (message_id, profile_id, email, status)
  values (v_id, p_profile, v_email, 'scheduled');

  return v_id;
end;
$$;

comment on function public.queue_personal_message(uuid, text, uuid) is
  'EML-01/05. Queues one message for one person, with its recipient row written in the same statement so the dispatcher never mistakes it for a broadcast.';

-- ---------------------------------------------------------------------------
-- 2. Registration confirmed, and registration cancelled
--
-- EML-01 rows 1 and 6.
--
-- The test for "is this a paid purchase" is deliberately NOT `an order exists
-- and it is paid`. It is `an order exists and it has not died`.
--
-- The webhook settles the order and confirms the registration in the same
-- transaction, but an AFTER ROW trigger fires at the end of its own statement.
-- If the registration is updated before the order, this trigger runs while the
-- order still reads 'pending' — and a rule keyed on 'paid' would queue a
-- confirmation for a purchase that is about to produce a payment email. Two
-- emails for one ticket, dependent on statement order inside somebody else's
-- function, which is not a thing this trigger should be able to see.
--
-- Keying on "an order exists at all" is immune to that ordering. Excluding
-- 'failed' and 'cancelled' is what stops it over-suppressing: an abandoned or
-- refused checkout leaves a dead order behind, and if that registration is
-- later confirmed for free it should still get its confirmation.
--
-- A free registration has no order at all and always gets this email. EML-01
-- row 2 explicitly permits payment and ticket confirmation to be one message,
-- which is what a paid purchase gets instead.
--
-- Cancellation is queued whoever did it. A host cancelling somebody's place is
-- precisely when that person most needs telling, and EML-01 row 6 names the
-- attendee as the recipient rather than naming who acted.
--
-- 'expired' is not a cancellation and gets no email: a checkout hold lapsing is
-- not something the attendee decided, and telling them their place is gone when
-- they never completed a purchase would be confusing rather than helpful.
-- ---------------------------------------------------------------------------

create or replace function public.queue_registration_emails()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'confirmed'
     and (tg_op = 'INSERT' or old.status is distinct from 'confirmed')
  then
    if not exists (
      select 1 from public.event_orders o
       where o.registration_id = new.id
         and o.status not in ('failed', 'cancelled')
    ) then
      perform public.queue_personal_message(new.event_id, 'confirmation', new.profile_id);
    end if;

  elsif new.status = 'cancelled'
        and tg_op = 'UPDATE'
        and old.status in ('pending', 'confirmed')
  then
    perform public.queue_personal_message(new.event_id, 'attendee_cancelled', new.profile_id);
  end if;

  return null;
end;
$$;

comment on function public.queue_registration_emails() is
  'EML-01. Queues the free-RSVP confirmation and the cancellation notice. A paid registration is covered by the combined payment email instead.';

create trigger trg_queue_registration_emails
  after insert or update on public.event_registrations
  for each row execute function public.queue_registration_emails();

-- ---------------------------------------------------------------------------
-- 3. FDB-06 — a corrected check-in still gets asked for feedback
--
-- "Include them in the initial feedback email if it has not yet been sent. If
-- feedback has already opened, make the feedback link available and send their
-- initial request without duplicating an earlier send."
--
-- Three cases, and only the third does anything:
--
--   no feedback_open message yet     nothing to join; schedule_event_messages()
--                                    will create one and they will be in it
--   one is still 'scheduled'         they will be in the audience when it goes
--   the last one has been sent       add them to it as a new recipient and
--                                    re-open the message
--
-- Re-opening sends only to them. The dispatcher works per recipient row and
-- the unique index on (message_id, profile_id) is what makes that safe — the
-- people who already received it cannot receive it twice, which is EML-06's
-- no-duplicate-copies rule doing the work here rather than a second rule.
--
-- The "is one still scheduled" test is not only about correctness, it is what
-- keeps this from raising: event_messages_live_feedback_idx is unique on
-- (event_id) where kind = 'feedback_open' and status = 'scheduled', so
-- re-opening a sent message while another sits scheduled would violate it.
--
-- A trigger on event_attendance rather than a line inside mark_attended(),
-- because the same thing is true of an arrival recorded any other way, and
-- because ATT-06 corrections made directly in SQL deserve the same behaviour.
-- ---------------------------------------------------------------------------

create or replace function public.add_late_feedback_recipient(
  p_event   uuid,
  p_profile uuid
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_message uuid;
  v_email   text;
begin
  if exists (
    select 1 from public.event_messages m
     where m.event_id = p_event and m.kind = 'feedback_open' and m.status = 'scheduled'
  ) then
    return;
  end if;

  select m.id into v_message
  from public.event_messages m
  where m.event_id = p_event and m.kind = 'feedback_open' and m.sent_at is not null
  order by m.sent_at desc
  limit 1;

  if v_message is null then
    return;
  end if;

  select p.email::text into v_email
  from public.profiles p
  where p.id = p_profile
    and p.profile_status not in ('suspended', 'removed')
    and coalesce(btrim(p.email), '') <> '';

  if v_email is null then
    return;
  end if;

  insert into public.event_message_recipients (message_id, profile_id, email, status)
  values (v_message, p_profile, v_email, 'scheduled')
  on conflict (message_id, profile_id) do nothing;

  if found then
    update public.event_messages
    set status = 'scheduled', scheduled_for = now()
    where id = v_message;
  end if;
end;
$$;

comment on function public.add_late_feedback_recipient(uuid, uuid) is
  'FDB-06. A guest whose check-in was corrected after the initial feedback request went out is added to it, and it is re-opened for them alone. Nobody who already received it receives it twice.';

-- The call is wrapped so that it can never cost an attendance record. ATT-06 is
-- the requirement under this trigger and a refused correction is the worse
-- failure by a long way: somebody who was in the room stays marked absent and
-- loses their feedback eligibility with it. A missed late email is recoverable
-- by the organiser sending again; a refused correction is not recoverable by
-- anybody standing at a door.
create or replace function public.queue_late_feedback_on_attendance()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  begin
    perform public.add_late_feedback_recipient(new.event_id, new.profile_id);
  exception when others then
    raise notice 'Late feedback request not queued for % on % (%)',
      new.profile_id, new.event_id, sqlerrm;
  end;
  return null;
end;
$$;

comment on function public.queue_late_feedback_on_attendance() is
  'ATT-06, FDB-06. Attendance is the fact that must survive; the late email is best effort and degrades to a notice.';

create trigger trg_queue_late_feedback_on_attendance
  after insert on public.event_attendance
  for each row execute function public.queue_late_feedback_on_attendance();

-- ---------------------------------------------------------------------------
-- 4. Grants
--
-- None of these are callable from a client. They run as triggers, and the only
-- one with a plain signature is there for the wrapper above and for a host
-- tool that does not exist yet.
-- ---------------------------------------------------------------------------

grant execute on function public.add_late_feedback_recipient(uuid, uuid) to service_role;
