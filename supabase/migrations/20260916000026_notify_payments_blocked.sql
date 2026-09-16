-- ============================================================================
-- Telling an organiser their events have stopped selling
--
-- BUY-14 says to prevent new paid sales *and* show the organiser how to resolve
-- the problem. event_sale_readiness() answers the second half, but only to
-- somebody who opens the event dashboard. A connector who published a month ago
-- and has not looked since finds out from a confused attendee, which is not
-- showing them anything.
--
-- Stripe does tell the account holder when it restricts them. This is not a
-- second copy of that message: Stripe knows nothing about Amazing events, so it
-- cannot say "and these three dinners you are running have stopped selling".
-- Connecting their Stripe problem to their Amazing events is the part only we
-- can do, and it is the part the organiser actually needs.
--
-- On connectors rather than anywhere else because that is where the flag is
-- written — by payments2's account.updated handler, and equally by an admin
-- correcting a row by hand. A trigger fires for both; a line in the webhook
-- fires for one.
--
-- Two guards, and they are the same "is anything actually at stake" test the
-- late feedback request uses:
--
--   the transition only    true -> false. A repeated account.updated carrying
--                          the same false must not notify again, and the WHEN
--                          clause below means the function is not even entered
--                          for one.
--   something to break     at least one published event with an active paid
--                          ticket type routed to this connector. A connector
--                          with no paid events has lost nothing today and does
--                          not need an alarm about it.
--
-- Recipients are every host of each affected event, which is the connector
-- themselves — they created it, so it is routed to them — plus any cohosts, who
-- are running the same door and will field the same questions.
-- ============================================================================

create or replace function public.notify_payments_blocked()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_event uuid;
  v_host  uuid;
begin
  for v_event in
    select e.id
    from public.events e
    where e.payment_connector_id = new.id
      and e.status = 'published'
      and exists (
        select 1 from public.ticket_types t
         where t.event_id = e.id and t.is_active and t.price_cents > 0
      )
  loop
    for v_host in select h.profile_id from public.event_host_ids(v_event) h loop
      -- actor_id is null on purpose. Nobody at Amazing did this, and naming a
      -- person as the actor would be a small lie in a notice about money.
      insert into public.notifications (profile_id, kind, actor_id, event_id)
      values (v_host, 'event_payments_blocked', null, v_event);
    end loop;
  end loop;

  return null;
end;
$$;

comment on function public.notify_payments_blocked() is
  'BUY-14. When a connector loses the ability to take charges, tells the hosts of every published paid event routed to them. Fires on the transition into false only, and only when there is a live paid event to be affected.';

-- The WHEN clause is the first guard and it is free: connectors is updated for
-- invite capacity, hosting permission and every Stripe field, and none of those
-- should cost a function call.
create trigger trg_notify_payments_blocked
  after update on public.connectors
  for each row
  when (old.stripe_charges_enabled and not new.stripe_charges_enabled)
  execute function public.notify_payments_blocked();
