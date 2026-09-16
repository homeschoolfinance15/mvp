-- ============================================================================
-- Carrying the old RSVPs forward
--
-- event_invitations held both directions in one row: a host's invitation and a
-- guest's answer, distinguished by a status column. The new schema splits
-- those into two tables with two lifetimes, so the existing rows have to be
-- split the same way:
--
--   status = 'going'     -> a confirmed, free event_registrations row, with a
--                           ticket, so the person still has a place and can
--                           still be checked in at the door
--   status = 'invited'   -> an event_invites row: they were asked and have not
--                           answered
--   status = 'declined'  -> nothing. They said no; there is nothing to carry.
--
-- The old table is kept exactly as it is. It is not dropped, not emptied and
-- not altered — this migration only reads it. Nothing new writes to it, and
-- the rows stay as the record of what the platform used to know.
--
-- QLT-07 is the rule that shapes the rest of this file, and it is a rule about
-- honesty rather than about data. A legacy RSVP proves that somebody said they
-- were coming. It does not prove they paid, because there was nothing to pay,
-- and it does not prove they turned up, because nobody was scanning tickets at
-- the door. So:
--
--   - no event_orders row. A free registration has no order, and inventing a
--     zero-amount one would put a payment record against a person who never
--     made a payment.
--   - no event_attendance row. Attendance is an observation, and nobody
--     observed these. Manufacturing them would hand every legacy attendee a
--     feedback form about people they may never have met (FDB-06), and would
--     put fabricated rows in the one table whose entire value is that its
--     rows were witnessed.
--
-- Everything is `on conflict do nothing`, so re-running this file is a no-op
-- rather than a second copy of somebody's place.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Quiet the triggers that assume a live registration
--
-- issue_ticket_on_confirm() does two things on a confirmed registration: it
-- writes the ticket, and it tells every host that somebody has just signed up.
-- The first is wanted here. The second is not — running it over years of
-- history would put a bell notification in every host's account for every RSVP
-- they have ever received, all dated today. So the trigger is disabled for the
-- backfill and the tickets are written explicitly in section 2.
--
-- The capacity trigger stays on deliberately. Legacy events have no capacity,
-- so it has nothing to refuse, and leaving it enabled means the backfill is
-- held to the same rule as everything else rather than being trusted.
-- ---------------------------------------------------------------------------

alter table public.event_registrations disable trigger trg_issue_ticket_on_confirm;

-- ---------------------------------------------------------------------------
-- 2. 'going' becomes a confirmed free registration, with a ticket
--
-- ticket_type_id is null: these events had nothing on sale, and null is what
-- the new schema means by "free entry, no options" rather than a ticket type
-- invented retrospectively.
--
-- confirmed_at is the RSVP's own timestamp where it has one. The person
-- confirmed their place when they said yes, not when this migration ran, and
-- anything sorted by that column would otherwise show years of history
-- arriving in the same second.
-- ---------------------------------------------------------------------------

insert into public.event_registrations
  (event_id, profile_id, ticket_type_id, status, confirmed_at, created_at)
select
  i.event_id,
  i.profile_id,
  null,
  'confirmed',
  coalesce(i.responded_at, i.created_at),
  i.created_at
from public.event_invitations i
where i.status = 'going'
on conflict do nothing;

-- BUY-10. One ticket each, with a real random code, exactly as a registration
-- made today would get. A legacy attendee turning up to a rescheduled event
-- has a ticket that scans.
insert into public.event_tickets (registration_id, event_id, profile_id, code, created_at)
select
  r.id,
  r.event_id,
  r.profile_id,
  encode(extensions.gen_random_bytes(16), 'hex'),
  r.created_at
from public.event_registrations r
join public.event_invitations i
  on i.event_id = r.event_id and i.profile_id = r.profile_id and i.status = 'going'
where not exists (
  select 1 from public.event_tickets t where t.registration_id = r.id
)
on conflict do nothing;

alter table public.event_registrations enable trigger trg_issue_ticket_on_confirm;

-- ---------------------------------------------------------------------------
-- 3. 'invited' becomes an event_invites row
--
-- invited_by is the event's creator, which is the closest true answer
-- available: the old table recorded that somebody was invited but never who
-- did the inviting, and events.host_id is the one person who certainly could
-- have.
--
-- send_status is 'sent'. These invitations were acted on by the old platform
-- and the person has been sitting on the guest list ever since; marking them
-- 'queued' would hand the new mailer a backlog of invitations to years-old
-- events and send every one of them.
--
-- via_connector_id is null. ORG-08A wants to know which community made
-- somebody reachable, and for these rows nothing recorded it. Null is the
-- honest answer; guessing from connector_user_links would be a plausible
-- invention rather than a fact.
-- ---------------------------------------------------------------------------

insert into public.event_invites
  (event_id, profile_id, invited_by, via_connector_id, send_status, sent_at, created_at)
select
  i.event_id,
  i.profile_id,
  e.host_id,
  null,
  'sent',
  i.created_at,
  i.created_at
from public.event_invitations i
join public.events e on e.id = i.event_id
where i.status = 'invited'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 4. What this migration deliberately did not write
--
-- Left here as a comment rather than as code, because the absence is the
-- requirement and the next person to read this file will wonder whether it was
-- an oversight.
--
--   event_orders      — QLT-07. No money changed hands. A zero-amount order
--                       would make every legacy attendee look like a customer.
--   event_attendance  — QLT-07. Nobody was scanned in. Writing attendance we
--                       did not observe would open feedback forms (FDB-06)
--                       about meetings that may never have happened.
--   feedback_subjects — follows from the above: no attendance, no subjects.
--
-- event_invitations itself is untouched and stays readable. Its rows are the
-- provenance for everything above.
-- ---------------------------------------------------------------------------

comment on table public.event_invitations is
  'Deprecated. The original RSVP table, kept for provenance and no longer written to. Its rows were carried into event_registrations and event_invites by 20260916000009. See CONTRACT.md §3.';
