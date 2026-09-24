-- ============================================================================
-- Connector invitations arrive and leave without a refresh
--
-- The connectors page watches connectors, their members and profiles live,
-- but the "Awaiting claim" list was left out of the publication, so a code
-- created or revoked by another admin stayed stale — a revoked code could
-- still be copied or emailed. Its select policy still decides who is sent
-- a change.
--
-- Guarded twice: the publication exists on Supabase and not on a plain
-- Postgres, and adding a table already in it is an error.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'connector_invitations'
     ) then
    alter publication supabase_realtime add table public.connector_invitations;
  end if;
end
$$;
