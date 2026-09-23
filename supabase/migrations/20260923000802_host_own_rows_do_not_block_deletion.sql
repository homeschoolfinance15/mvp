-- ============================================================================
-- A host's own place does not keep their event alive
--
-- Closing an account asks event_involves_others() whether anybody ELSE is on
-- an event the person hosts, and ignores the host's own registration and
-- attendance. guard_event_deletion() then counted every row, the host's
-- included, so a host who had booked a place at their own solo event was
-- refused with "that would erase other people's tickets" — about nobody.
--
-- Registrations and attendance now count only when they belong to somebody
-- other than the host. Orders still count whoever placed them: a paid order
-- is a financial record and is never deleted.
-- ============================================================================

create or replace function public.guard_event_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_direct boolean := auth.uid() is not null and pg_trigger_depth() = 1;
begin
  -- ORG-15. events_delete lets any host through; the creator decides.
  if v_direct and old.host_id <> auth.uid() and not public.is_admin() then
    raise exception 'Only the person who created this event, or an administrator, can delete it.';
  end if;

  if exists (select 1 from public.event_registrations r where r.event_id = old.id and r.profile_id <> old.host_id)
     or exists (select 1 from public.event_orders o where o.event_id = old.id)
     or exists (select 1 from public.event_attendance a where a.event_id = old.id and a.profile_id is distinct from old.host_id)
  then
    raise exception
      'This event has registrations, payments or attendance recorded against it, so it '
      'cannot be deleted — that would erase other people''s tickets and payment records. '
      'Cancel it instead: that stops sales, invalidates entry, tells everyone holding a '
      'place, and keeps the history.';
  end if;

  -- ORG-14.
  if v_direct and old.status = 'published' and (
       exists (select 1 from public.event_invites i where i.event_id = old.id)
       or exists (
         select 1 from public.event_messages m
          where m.event_id = old.id and m.status in ('queued', 'sent')
       )
     )
  then
    raise exception
      'People have been invited to or emailed about this event, so it cannot be deleted. '
      'Cancel it instead: that tells them it is off and keeps the history.';
  end if;

  return old;
end;
$$;
