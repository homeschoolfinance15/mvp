-- ============================================================================
-- Two policies that were the wrong width
--
-- 1. QLT-08 — a booking must not lose its event
--
-- events_select read `status in ('published','cancelled') or hosts_event(id)
-- or is_admin()`. Every word of that is about whether the event is on public
-- display, and none of it is about whether the person asking has already paid
-- to attend it.
--
-- So a host pulling a published event back to draft — to fix a venue, to stop
-- sales for an afternoon, by accident — instantly removed the event row from
-- every attendee who held a confirmed registration. Their booking survived;
-- the thing it points at vanished, and /events/mine showed a registration
-- attached to nothing.
--
-- QLT-08: "Removing an event from ordinary browsing or closing a host account
-- must not silently erase customers' outstanding bookings, purchases, or
-- refund information." A draft is exactly "removed from ordinary browsing",
-- and this is exactly that erasure.
--
-- The fix is one more clause: if you have a registration or an order on that
-- event, you can read it, whatever the host has since done to its status.
-- Cancelled and expired registrations count too — somebody whose place is
-- gone but whose refund is still moving needs to see what the event was, and
-- that is the same sentence in QLT-08.
--
-- It goes into event_visible() as well as into the policy, which is what fixes
-- ticket_types in the same breath: a ticket view reads the ticket type it was
-- bought from, ticket_types_select is `event_visible(event_id)`, and it had
-- the identical hole. event_public and event_availability inherit it too.
--
-- The other event tables were checked and do not have this shape.
-- event_orders, event_refunds, event_tickets, event_registrations and
-- event_attendance all gate on who owns the row — `profile_id = auth.uid()`,
-- or the order's owner — and never on the event's status, so nothing there
-- changes when an event goes back to draft. That is the property worth
-- keeping: a row about a person should ask about that person.
--
-- 2. BUY-01 — the onboarding gate, on the table as well as in the function
--
-- register_free() refuses an unfinished profile as of 20260916000010. That
-- covers the front door and not the side one: event_registrations_insert let
-- anybody with a session write their own row directly. The policy is where
-- the rule holds for every caller, so it goes there too.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Do I already have something riding on this event
--
-- SECURITY DEFINER, which is what keeps it out of trouble. A policy on events
-- that queried event_registrations directly would evaluate that table's own
-- policies inside the events policy, and those call hosts_event(), which reads
-- events. It would work, because hosts_event() is a definer function and skips
-- RLS, but it is a loop waiting for somebody to make one of those functions
-- ordinary. One definer function, asked once, has no such edge.
--
-- Orders are consulted as well as registrations because registration_id on an
-- order is `on delete set null`: a paid order can outlive the registration it
-- was for, and the person who paid still gets to see what they paid for.
-- ---------------------------------------------------------------------------

create or replace function public.has_event_booking(p_event uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.event_registrations r
     where r.event_id = p_event and r.profile_id = auth.uid()
  ) or exists (
    select 1 from public.event_orders o
     where o.event_id = p_event and o.profile_id = auth.uid()
  );
$$;

comment on function public.has_event_booking(uuid) is
  'QLT-08. Whether the caller has a registration or an order on that event, in any state. What keeps a customer''s booking readable after a host unpublishes the event.';

-- ---------------------------------------------------------------------------
-- 2. event_visible, widened
--
-- Same sentence as before plus the booking clause. Still the one definition
-- that ticket_types, event_public and event_availability all read, so they
-- cannot disagree with the events policy about what somebody may see.
-- ---------------------------------------------------------------------------

create or replace function public.event_visible(p_event uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.events e
     where e.id = p_event
       and (e.status in ('published', 'cancelled')
            or public.hosts_event(e.id)
            or public.is_admin()
            or public.has_event_booking(e.id))
  );
$$;

comment on function public.event_visible(uuid) is
  'EVT-01, ORG-02, QLT-08. Whether the caller may see that event: it is published or cancelled, they run it, they are an admin, or they have a booking on it.';

drop policy events_select on public.events;
create policy events_select on public.events for select to anon, authenticated
using (
  status in ('published', 'cancelled')
  or public.hosts_event(id)
  or public.is_admin()
  or public.has_event_booking(id)
);

-- ---------------------------------------------------------------------------
-- 3. BUY-01 on the table
-- ---------------------------------------------------------------------------

drop policy event_registrations_insert on public.event_registrations;
create policy event_registrations_insert on public.event_registrations for insert to authenticated
with check (
  public.has_account()
  and public.onboarding_complete(auth.uid())
  and profile_id = auth.uid()
);

-- ---------------------------------------------------------------------------
-- 4. Grants
--
-- anon evaluates events_select too, and a policy that cannot execute its own
-- gate raises rather than quietly returning false. An anonymous caller has no
-- auth.uid() and so never has a booking, but it still has to be able to ask.
-- ---------------------------------------------------------------------------

grant execute on function public.has_event_booking(uuid) to anon, authenticated;
