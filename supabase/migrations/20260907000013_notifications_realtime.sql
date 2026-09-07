-- ============================================================================
-- Notifications arrive without a refresh
--
-- The same publication line the circle chat uses. A bell that only updates
-- when you change page is a bell you learn to ignore, and Supabase Realtime
-- is already in the stack, so this costs one line rather than a polling loop.
--
-- The select policy still decides what reaches a subscriber, so nobody is
-- pushed somebody else's notification.
--
-- Guarded, because the publication exists on Supabase and not on a plain
-- Postgres.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;
