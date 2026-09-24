-- ============================================================================
-- What members raise arrives on the Raised screen without a refresh
--
-- The panel an admin and a connector read watches profile_reports live, but
-- the table was never added to the publication, so a new report — or one
-- another admin closed — stayed out of sight until the page was reloaded.
-- Its select policy still decides who is sent a change: the subject of a
-- report is never told.
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
         and tablename = 'profile_reports'
     ) then
    alter publication supabase_realtime add table public.profile_reports;
  end if;
end
$$;
