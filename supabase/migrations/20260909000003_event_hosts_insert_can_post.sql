-- ============================================================================
-- event_hosts_insert, restated
--
-- 20260909000001 was applied to production while it was still being edited,
-- so which version of this one policy landed there is not knowable from here.
-- Recreating it settles that: the statement below is the intended definition
-- and is a no-op if production already has it.
--
-- The guard being restored is can_post(). hosts_event() answers "do you run
-- this event" and may_host_events() answers "may they host at all"; neither
-- asks whether the caller is still in good standing, so a suspended host
-- could otherwise still hand out hosting rights.
-- ============================================================================

drop policy if exists event_hosts_insert on public.event_hosts;

create policy event_hosts_insert on public.event_hosts for insert to authenticated
with check (
  public.can_post()
  and (public.hosts_event(event_id) or public.is_admin())
  and public.may_host_events(profile_id)
);
