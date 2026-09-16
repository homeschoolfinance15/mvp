-- ============================================================================
-- The roster, the event-level feedback outcome, and words for a refusal
--
-- Four gaps the UI workstreams found by building against the schema, all of
-- them things CONTRACT.md §3 does not pin down because none of them is
-- visible until somebody tries to draw a screen.
--
--   1. event_participants — a door needs the name of the person in front of
--      it, and a feedback form needs the faces of the people it is asking
--      about. member_directory cannot serve either: it is gated on
--      is_member(), so an event-only account can neither read it nor appear
--      in it (ACC-05). That is correct and it is exactly why a second,
--      event-scoped roster has to exist.
--
--   2. my_feedback_progress gained no way to say "this author has already
--      sent the event-level form". FDB-07 and FDB-13 both need a sent form to
--      look different from an unsent one after a refresh, and the answers
--      themselves are admin-only, so the author cannot find out by reading
--      them back.
--
--   3. The answer tables had an insert policy and no update policy, while the
--      file that created them described the author correcting an answer "which
--      the unique constraint turns into an upsert". It does not: ON CONFLICT
--      DO UPDATE needs an update policy as well, so every retry over a bad
--      connection failed instead of overwriting.
--
--   4. register_free() refused with one sentence and the state in brackets.
--      ORG-03A is explicit that selling out and an organiser closing sales
--      early are different facts that an attendee reads differently, and
--      "Registration is not open for this event (sold_out)" is neither of
--      them in plain English.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. event_participants
--
-- Who is expected and who actually arrived, with a name and a face.
--
-- Built from registrations rather than only from attendance, because a door
-- needs the list before anybody has been scanned, and `attended` is the column
-- that distinguishes the two. Somebody marked present by hand without ever
-- holding a registration appears too — mark_attended() is exactly for the case
-- where the registration is the thing that went wrong. And so does everybody
-- hosting it, ticket or no ticket, which is what lets the check-in screen put
-- a name to event_attendance.recorded_by (ATT-02).
--
-- The gate is the part worth reading twice. Hosts and admins see every row for
-- their event. Anybody else sees rows only for an event they themselves
-- attended, and only rows for people who also attended — so a guest list is
-- never readable by somebody who merely bought a ticket, and never at all
-- before the event has happened. That gate is in the WHERE, not in the
-- client, because a view that trusts its caller to filter is not a gate.
-- ---------------------------------------------------------------------------

create view public.event_participants
with (security_invoker = off) as
select
  x.event_id,
  x.profile_id,
  p.full_name,
  p.avatar_path,
  x.attended,
  -- Whether this row's person is a host, not whether the caller is. Anding the
  -- two would have made every host look like an ordinary guest to everybody
  -- except another host, and there is nothing to protect here: host names are
  -- already in event_public, which anon can read.
  x.is_host
from (
  select
    r.event_id,
    r.profile_id,
    exists (
      select 1 from public.event_attendance a
       where a.event_id = r.event_id and a.profile_id = r.profile_id
    ) as attended,
    exists (
      select 1 from public.event_host_ids(r.event_id) h
       where h.profile_id = r.profile_id
    ) as is_host
  from public.event_registrations r
  where r.status in ('pending', 'confirmed')

  union

  -- Recorded at the door with no live registration behind them (ATT-04).
  select a.event_id, a.profile_id, true, exists (
    select 1 from public.event_host_ids(a.event_id) h
     where h.profile_id = a.profile_id
  )
  from public.event_attendance a

  union

  -- ATT-02. Everybody who runs the event, whether or not they bought a ticket
  -- or has been scanned. Staff working a door they did not buy a ticket for is
  -- the ordinary case, and without this branch a cohost is in neither of the
  -- two above — so resolving event_attendance.recorded_by to a name misses,
  -- and "Arrived at 19:42 by Sarah" silently degrades to "Arrived at 19:42".
  -- The "by whom" is the half of ATT-02 that settles an argument at a door.
  --
  -- `attended` is recomputed here with the same exists() as the first branch
  -- rather than hardcoded false, and that is load-bearing. UNION dedupes whole
  -- tuples: a host who did register and did arrive yields (e, p, true, true)
  -- from the branches above, and a hardcoded false here would yield
  -- (e, p, false, true) — a different tuple, so not collapsed, and the same
  -- person would appear twice with contradictory arrival states. Computed the
  -- same way, every overlap is an identical tuple and dedupes to one row.
  select e.id, h.profile_id, exists (
    select 1 from public.event_attendance a
     where a.event_id = e.id and a.profile_id = h.profile_id
  ), true
  from public.events e
  cross join lateral public.event_host_ids(e.id) h
) x
join public.profiles p on p.id = x.profile_id
where public.hosts_event(x.event_id)
   or public.is_admin()
   or (x.attended and public.attended_event(x.event_id, auth.uid()));

comment on view public.event_participants is
  'ATT-02, FDB-01/06. Names and faces for one event: who is expected, who arrived, and everybody running it whether or not they hold a ticket. Hosts see the whole list; an attendee sees only people who also attended, and only for events they attended themselves.';

-- ---------------------------------------------------------------------------
-- 2. my_feedback_progress, with the event-level form in it
--
-- One extra row per event, with subject_id null, carrying whether the author
-- has sent the two questions about the event itself. It is derived from an
-- exists() over event_feedback rather than stored, so there is no second
-- place for it to be wrong, and it returns a state rather than an answer —
-- FDB-12 survives because there is still no column here to reach for.
--
-- The peer rows are unchanged.
-- ---------------------------------------------------------------------------

create or replace view public.my_feedback_progress
with (security_invoker = off) as
-- The people.
select
  a.event_id,
  auth.uid()   as author_id,
  a.profile_id as subject_id,
  -- text, matching what 20260916000007 declares. The union below contributes a
  -- null text for the event-level row, and a view cannot change a column's
  -- type when it is replaced.
  p.full_name::text as subject_name,
  coalesce(s.outcome, 'pending'::feedback_outcome) as outcome
from public.event_attendance a
join public.profiles p on p.id = a.profile_id
left join public.feedback_subjects s
       on s.event_id  = a.event_id
      and s.author_id = auth.uid()
      and s.subject_id = a.profile_id
where a.profile_id <> auth.uid()
  and public.attended_event(a.event_id, auth.uid())

union all

-- The event itself. subject_id is null, which is what marks this row as being
-- about the event rather than about a person.
select distinct
  a.event_id,
  auth.uid() as author_id,
  null::uuid as subject_id,
  null::text as subject_name,
  case
    when exists (
      select 1 from public.event_feedback f
       where f.event_id = a.event_id and f.author_id = auth.uid()
    ) then 'submitted'::feedback_outcome
    else 'pending'::feedback_outcome
  end
from public.event_attendance a
where a.profile_id = auth.uid();

comment on view public.my_feedback_progress is
  'FDB-05/07. Who an author still has to write about and what they decided, plus one row per event with subject_id null for the event-level form. Outcomes only — never answer text, theirs or anybody else''s.';

-- ---------------------------------------------------------------------------
-- 3. Correcting an answer
--
-- An update policy on each answer table, restricted to the author's own rows.
-- This is what makes `on conflict do update` work, and a double tap or a
-- retry on a flaky connection is the ordinary case rather than the exotic one.
--
-- It does mean an author can revise an answer after submitting it. That is the
-- deliberate trade: the alternative is a respondent whose form silently failed
-- and who has no way to try again, and FDB-13 cares more about the form being
-- completable than about an answer being frozen the instant it lands. Select
-- stays admin-only, so nobody — including the author — can read back what is
-- being revised.
-- ---------------------------------------------------------------------------

create policy peer_feedback_update on public.peer_feedback for update to authenticated
using (author_id = auth.uid())
with check (
  author_id = auth.uid()
  and author_id <> subject_id
  and public.attended_event(event_id, auth.uid())
  and public.attended_event(event_id, subject_id)
);

create policy event_feedback_update on public.event_feedback for update to authenticated
using (author_id = auth.uid())
with check (
  author_id = auth.uid()
  and public.attended_event(event_id, auth.uid())
);

-- The trigger that moves a subject to 'submitted' fired only on insert, so an
-- answer that arrived as the update half of an upsert left the subject sitting
-- at 'pending' forever.
create trigger trg_mark_feedback_submitted_update
  after update on public.peer_feedback
  for each row execute function public.mark_feedback_submitted();

-- ---------------------------------------------------------------------------
-- 4. ORG-03A — a refusal that says which refusal it is
--
-- Same function, same guarantees, same capacity lock underneath. The only
-- change is that the four ways an event can be shut now produce four
-- sentences, because the attendee reading them wants very different things
-- from each: a sold-out event might free a place, a closed one will not, a
-- cancelled one is not happening and a finished one already did.
-- ---------------------------------------------------------------------------

create or replace function public.register_free(p_event uuid, p_ticket_type uuid default null)
returns public.event_registrations
language plpgsql security definer set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_event public.events%rowtype;
  v_type  public.ticket_types%rowtype;
  v_state text;
  v_row   public.event_registrations%rowtype;
begin
  if v_me is null then
    raise exception 'You must be signed in to register.';
  end if;
  if not public.has_account() then
    raise exception 'Your account cannot register for events.';
  end if;

  -- BUY-01. Onboarding is required before registration, for free and paid
  -- events alike. The route guard cannot be the enforcement point: this
  -- function is reachable over the API by anybody holding a session, and
  -- /events/checkout is deliberately not wrapped in a guard so that an
  -- anonymous visitor can still reach the public event page.
  if not public.onboarding_complete(v_me) then
    raise exception 'Please finish setting up your profile before registering.';
  end if;

  perform public.expire_event_holds(p_event);

  select * into v_event from public.events where id = p_event;
  if not found or not public.event_visible(p_event) then
    raise exception 'We could not find that event.';
  end if;

  if p_ticket_type is not null then
    select * into v_type from public.ticket_types
     where id = p_ticket_type and event_id = p_event and is_active;
    if not found then
      raise exception 'That ticket is not available for this event.';
    end if;
    if v_type.price_cents > 0 then
      raise exception 'That ticket has to be paid for.';
    end if;
  elsif exists (select 1 from public.ticket_types t
                 where t.event_id = p_event and t.is_active) then
    select * into v_type from public.ticket_types
     where event_id = p_event and is_active and price_cents = 0
     order by position, created_at
     limit 1;
    if not found then
      raise exception 'This event has no free tickets.';
    end if;
  end if;

  if exists (select 1 from public.event_registrations r
              where r.event_id = p_event and r.profile_id = v_me
                and r.status in ('pending', 'confirmed'))
  then
    raise exception 'You are already registered for this event.';
  end if;

  select s.state into v_state from public.event_capacity_state(p_event) s;

  -- ORG-03A. Four states, four sentences, shown to the attendee as written.
  if v_state = 'sold_out' then
    raise exception 'This event is sold out.';
  elsif v_state = 'closed' then
    raise exception 'Registration for this event is closed.';
  elsif v_state = 'cancelled' then
    raise exception 'This event has been cancelled.';
  elsif v_state = 'finished' then
    raise exception 'This event has finished.';
  elsif v_state is distinct from 'open' then
    raise exception 'Registration is not open for this event.';
  end if;

  -- The capacity trigger is what actually decides, under the event row lock.
  -- The check above is the courteous answer; this insert is the true one, and
  -- it raises 'This event is sold out.' from the trigger if somebody took the
  -- last place between the two.
  insert into public.event_registrations
    (event_id, profile_id, ticket_type_id, status, confirmed_at, terms_snapshot)
  values
    (p_event, v_me, v_type.id, 'confirmed', now(), v_event.refund_terms)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.register_free(uuid, uuid) is
  'BUY-02, ORG-03A. Takes a free place under the capacity lock. Every refusal is a plain sentence the attendee can be shown unaltered.';

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

grant select on public.event_participants to authenticated;
grant update on public.peer_feedback      to authenticated;
grant update on public.event_feedback     to authenticated;
