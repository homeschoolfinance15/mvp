-- ============================================================================
-- An event with a history behind it is cancelled, not deleted
--
-- 20260916000034 closed the profiles route into this: deleting a host's
-- profile cascaded through `events.host_id` and took every order, ticket and
-- attendance record with it. It did not close the direct one.
--
-- `events_delete` is `using (hosts_event(id) or is_admin())` and `delete` is
-- granted on the table, so any host of an event can DELETE it straight over
-- PostgREST. Nothing in the product does — `EventEditor` cancels, it never
-- deletes — but the policy permits it, and every event-owned table is
-- `on delete cascade`, so one request destroys the registrations, orders,
-- refunds, tickets, attendance and feedback under it. Same loss as 34, one
-- door along, and 34's guard does not see it because no profile is being
-- deleted.
--
-- QLT-08 and ORG-15 both land on this: event information is platform data,
-- and a record that somebody paid for is not the host's to remove.
--
-- Unlike the profiles guard, the remedy here is the right one and already
-- exists. Cancelling is what calling an event off *means* in this product: it
-- stops sales, invalidates entry, notifies everybody holding a place, cancels
-- the unsent queue and keeps the operational history (ORG-11). Deletion was
-- never the supported way to do it; it was just reachable.
--
-- Same test as 34, deliberately: only refuse when a third party has something
-- at stake. A draft nobody ever saw, or a published event nobody registered
-- for, is the host's own and stays deletable — a guard that refused every
-- event would make the tidy-up of a typo impossible and teach people to work
-- around it.
-- ============================================================================

create or replace function public.guard_event_deletion()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from public.event_registrations r where r.event_id = old.id)
     or exists (select 1 from public.event_orders o where o.event_id = old.id)
     or exists (select 1 from public.event_attendance a where a.event_id = old.id)
  then
    raise exception
      'This event has registrations, payments or attendance recorded against it, so it '
      'cannot be deleted — that would erase other people''s tickets and payment records. '
      'Cancel it instead: that stops sales, invalidates entry, tells everyone holding a '
      'place, and keeps the history.';
  end if;

  return old;
end;
$$;

comment on function public.guard_event_deletion() is
  'ORG-15, QLT-08. Refuses to delete an event anybody has registered for, paid for or attended — every event-owned table cascades from events, so the delete would take their records with it. Cancelling is the supported route and keeps the history. Guards the table, so it covers a direct PostgREST delete as well as the UI.';

create trigger trg_guard_event_deletion
  before delete on public.events
  for each row execute function public.guard_event_deletion();

-- The same bypasses noted on 20260916000034 apply here: TRUNCATE,
-- `ALTER TABLE … DISABLE TRIGGER`, and `session_replication_role = 'replica'`.
-- The second is the one to watch, because this repo already uses that pattern
-- for a backfill (20260916000009:57).
--
-- Note this fires on the cascade from `profiles` too, so the two guards
-- overlap on that path — 34 refuses first, at the profile, which is where the
-- better message is. Overlapping is the point: neither depends on the other
-- still existing.
