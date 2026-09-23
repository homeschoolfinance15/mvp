-- ============================================================================
-- What an attendee can do, and when
--
-- ATT-4 / ORG-23. The feedback screen already waits until the event has ended
-- plus the organiser's feedback_opens_after_minutes, and says nothing on a
-- cancelled event — but the three feedback functions from 20260922000010 did
-- not, so anybody checked in could post answers during the evening itself, or
-- about an event that never happened. The rule now lives in the functions.
-- Same arithmetic as the screen: end time, falling back to start time when
-- the host left the end open.
--
-- ATT-7. cancel_registration let an attendee cancel their own place after the
-- event was over, which revokes the ticket, moves them into "Cancelled" and
-- rewrites what happened. Once it has ended only a host or an administrator
-- may change the booking (the same line Eventbrite and Luma draw: attendee
-- self-cancel closes when the event does).
--
-- ATT-11. event_public was "everything on the row" — host_id, the two payment
-- recipient ids, payment_locked_at and cancelled_by went to anyone with the
-- link. It now names the columns a page displays and nothing else. A drop and
-- create, because create or replace cannot remove a column; nothing depends on
-- the view, and the grant is restated below. The same ids were still one
-- request away on the events table itself, so an anonymous visitor now gets
-- the view's display columns there too (section 4).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ATT-4 / ORG-23 — feedback opens when the organiser said it would
-- ---------------------------------------------------------------------------

create or replace function public.require_feedback_open(p_event uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare
  v_event public.events%rowtype;
begin
  select * into v_event from public.events where id = p_event;
  if not found then
    raise exception 'We could not find that event.' using errcode = 'P0002';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'This event was cancelled, so there is no feedback to give.' using errcode = '42501';
  end if;
  if now() < coalesce(v_event.ends_at, v_event.starts_at)
             + make_interval(mins => v_event.feedback_opens_after_minutes) then
    raise exception 'Feedback for this event is not open yet.' using errcode = '42501';
  end if;
end;
$$;

-- Internal: called by the three functions below, which run as the owner.
revoke execute on function public.require_feedback_open(uuid) from public, anon, authenticated;

create or replace function public.submit_event_feedback(p_event uuid, p_answers jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.attended_event(p_event, auth.uid()) then
    raise exception 'Only people who attended this event can give feedback on it.' using errcode = '42501';
  end if;
  perform public.require_feedback_open(p_event);

  insert into public.event_feedback (event_id, author_id, question_id, answer_scale, answer_text, submitted_at)
  select p_event, auth.uid(), a.question_id, a.answer_scale, nullif(btrim(a.answer_text), ''), now()
  from jsonb_to_recordset(coalesce(p_answers, '[]'::jsonb))
       as a(question_id uuid, answer_scale int, answer_text text)
  on conflict (event_id, author_id, question_id) do update
    set answer_scale = excluded.answer_scale,
        answer_text  = excluded.answer_text,
        submitted_at = excluded.submitted_at;
end;
$$;

create or replace function public.submit_peer_feedback(p_event uuid, p_subject uuid, p_answers jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or p_subject = auth.uid()
     or not public.attended_event(p_event, auth.uid())
     or not public.attended_event(p_event, p_subject) then
    raise exception 'You can only give feedback on someone else who attended this event with you.' using errcode = '42501';
  end if;
  perform public.require_feedback_open(p_event);

  -- trg_mark_feedback_submitted moves the subject to 'submitted' on both the
  -- insert and the update half of this.
  insert into public.peer_feedback (event_id, author_id, subject_id, question_id, answer_text, answer_choice, submitted_at)
  select p_event, auth.uid(), p_subject, a.question_id, nullif(btrim(a.answer_text), ''), a.answer_choice, now()
  from jsonb_to_recordset(coalesce(p_answers, '[]'::jsonb))
       as a(question_id uuid, answer_text text, answer_choice text)
  on conflict (event_id, author_id, subject_id, question_id) do update
    set answer_text   = excluded.answer_text,
        answer_choice = excluded.answer_choice,
        submitted_at  = excluded.submitted_at;
end;
$$;

create or replace function public.set_feedback_outcome(p_event uuid, p_subject uuid, p_outcome feedback_outcome)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or p_subject = auth.uid()
     or not public.attended_event(p_event, auth.uid())
     or not public.attended_event(p_event, p_subject) then
    raise exception 'You can only give feedback on someone else who attended this event with you.' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome = 'pending' then
    raise exception 'Choose what happened with this person.' using errcode = '22023';
  end if;
  perform public.require_feedback_open(p_event);

  insert into public.feedback_subjects (event_id, author_id, subject_id, outcome)
  values (p_event, auth.uid(), p_subject, p_outcome)
  on conflict (event_id, author_id, subject_id)
  do update set outcome = excluded.outcome, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. ATT-7 — an attendee's own cancel closes when the event ends
-- ---------------------------------------------------------------------------

create or replace function public.cancel_registration(p_registration uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.event_registrations%rowtype;
  v_staff boolean;
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_row from public.event_registrations where id = p_registration;
  if not found then
    raise exception 'We could not find that registration.';
  end if;

  v_staff := public.hosts_event(v_row.event_id) or public.is_admin();
  if not (v_row.profile_id = v_me or v_staff) then
    raise exception 'That is not your registration.';
  end if;

  -- Cancelling twice is not an error, it is the same outcome.
  if v_row.status in ('cancelled', 'expired') then
    return;
  end if;

  if not v_staff and exists (
    select 1 from public.events e
    where e.id = v_row.event_id and coalesce(e.ends_at, e.starts_at) < now()
  ) then
    raise exception 'This event has ended, so your place can no longer be cancelled. Contact the host if something needs changing.'
      using errcode = '42501';
  end if;

  update public.event_registrations
  set status       = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_me
  where id = p_registration;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. ATT-11 — event_public carries what a page shows
--
-- security_invoker stays off and the WHERE gate is unchanged; see
-- 20260916000003 §6 for why.
-- ---------------------------------------------------------------------------

drop view public.event_public;

create view public.event_public
with (security_invoker = off) as
select
  e.id,
  e.title,
  e.description,
  e.location,
  e.starts_at,
  e.ends_at,
  e.cover_path,
  e.status,
  e.slug,
  e.timezone,
  e.venue_name,
  e.address,
  e.attendee_instructions,
  e.refund_terms,
  e.capacity,
  e.registration_closed,
  e.currency,
  e.cancelled_at,
  e.feedback_opens_after_minutes,
  (
    select coalesce(array_agg(p.full_name order by p.full_name), '{}'::text[])
    from public.event_host_ids(e.id) h
    join public.profiles p on p.id = h.profile_id
  ) as host_names
from public.events e
where public.event_visible(e.id);

comment on view public.event_public is
  'EVT-01, ATT-11. An event as an anonymous visitor sees it: display columns plus host names. No email address, no profile id, no payment recipient.';

grant select on public.event_public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. ATT-11 — the events table keeps the same secret from a visitor
--
-- events_select still lets anon read a published row, and the table grant was
-- every column, so /rest/v1/events?select=host_id,payment_recipient_id
-- answered what the view no longer does. A visitor has no booking and hosts
-- nothing, so every page they reach reads event_public; the table only needs
-- the display columns (the script checks select id, slug and status). A
-- signed-in member keeps the full grant: hosts and admins select * on their
-- own events, and a column grant cannot tell them apart from anyone else.
-- ---------------------------------------------------------------------------

revoke select on public.events from anon;
grant select (
  id, title, description, location, starts_at, ends_at, cover_path, status,
  slug, timezone, venue_name, address, attendee_instructions, refund_terms,
  capacity, registration_closed, currency, cancelled_at,
  feedback_opens_after_minutes
) on public.events to anon;
