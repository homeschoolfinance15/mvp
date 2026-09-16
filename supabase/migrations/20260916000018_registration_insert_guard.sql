-- ============================================================================
-- event_registrations_insert — restoring the guard that migration 12 dropped
--
-- 20260916000012 recreated this policy to add the BUY-01 onboarding gate, and
-- in doing so dropped two clauses it had not meant to touch. The result was
-- live on production and exploitable:
--
--   POST /rest/v1/event_registrations
--        {event_id, profile_id: <self>, status: "confirmed"}   -> 201
--
--   TICKETS ISSUED: 1     ORDERS (money): 0     check_in() -> "ok"
--
-- A valid, scannable, admittable ticket to a £150 event, for free, in one
-- request — and it consumes a real place against capacity, so it also
-- displaces somebody who paid.
--
-- The chain, all of it working exactly as designed:
--
--   * the policy let a caller write their own row at any status
--   * enforce_event_capacity() accepts a 'confirmed' insert; it asks about the
--     event's status, registration_closed and capacity, and never about price
--     or about event_orders — correctly, that is not its job
--   * issue_ticket_on_confirm() fires after insert on status = 'confirmed'
--     and writes a real event_tickets row with a valid random code
--   * check_in() admits it: the ticket is not revoked and the registration
--     says confirmed
--
-- Nothing in that chain is wrong. The policy was the only thing standing
-- between a session and a free ticket, which is exactly what the original
-- comment in 20260916000004 said it was:
--
--   "The status clause on the self branch is load-bearing: 'confirmed' is a
--    statement that the money is settled, and issue_ticket_on_confirm() turns
--    it into a ticket. Without it, `POST /event_registrations
--    {status: 'confirmed'}` is a free ticket to a paid event, which is BUY-04
--    undone by one request."
--
-- The danger was understood, written down, and removed anyway by a later
-- migration that was about something else. That is the ordinary way a guard
-- dies, and it is why the check script now asserts the *absence of a ticket*
-- rather than only the refusal.
--
-- 20260916000012's onboarding gate was right and is kept. It moves onto the
-- self branch, because BUY-01 is about the person registering themselves: a
-- host registering a guest must not be blocked because that guest has not
-- finished their own onboarding (ORG-09).
--
-- event_registrations_update was checked and is intact —
-- `hosts_event(event_id) or is_admin()`, so an attendee still cannot move
-- their own row to 'confirmed'. That is the same exploit by a different verb
-- and it was not affected.
-- ============================================================================

drop policy if exists event_registrations_insert on public.event_registrations;

create policy event_registrations_insert on public.event_registrations for insert to authenticated
with check (
  public.has_account()
  and (
    -- For yourself: you may hold a place, never confirm one. Only
    -- register_free() and the Stripe webhook may write 'confirmed', and both
    -- are SECURITY DEFINER and know whether the money is settled.
    (
      profile_id = auth.uid()
      and status = 'pending'
      and public.onboarding_complete(auth.uid())
    )
    -- For a guest, if you run the event (ORG-09 support path) or are an
    -- administrator. No onboarding check here: it is not their registration.
    or public.hosts_event(event_id)
    or public.is_admin()
  )
);

comment on policy event_registrations_insert on public.event_registrations is
  'BUY-01, BUY-03, BUY-04. A caller may hold their own place and never confirm it; only register_free() and the webhook confirm. Hosts and admins may register a guest (ORG-09).';
