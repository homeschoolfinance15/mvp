-- ============================================================================
-- Grant service_role access to the application schema.
--
-- The initial migration granted privileges explicitly to anon and authenticated
-- but never to service_role, and Supabase's default privileges did not cover
-- tables created by the migration role. The result was that the backend key
-- could authenticate but got "permission denied" on every table — which would
-- break any server-side route, scheduled job, or edge function added later.
--
-- service_role bypasses row level security by design; these grants are what
-- make that bypass reachable in the first place.
-- ============================================================================

grant usage on schema public to service_role;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Cover anything added by later migrations without needing a repeat of this.
alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant all privileges on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;
