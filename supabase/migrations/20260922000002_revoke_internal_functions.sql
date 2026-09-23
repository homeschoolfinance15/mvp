-- SEC-2, SEC-3, SEC-4. Internal functions stay internal.
--
-- The earlier migrations revoke these from PUBLIC, but Supabase's default
-- privileges grant EXECUTE to anon and authenticated by name, so the revoke
-- from PUBLIC left both in place. Anyone with the publishable key could trim
-- or overwrite the audit trail, trigger retention runs, and queue platform
-- emails. Every legitimate caller is a security definer function owned by
-- postgres (the triggers, the purge wrappers, pg_cron), so they keep working.

revoke execute on function public.purge_activity_log_internal(integer)       from public, anon, authenticated;
revoke execute on function public.purge_expired_erasures_internal()          from public, anon, authenticated;
revoke execute on function public.purge_synthetic_erasures_internal()        from public, anon, authenticated;
revoke execute on function public.run_retention_jobs()                       from public, anon, authenticated;
revoke execute on function public.redact_entity_audit_payload(text, uuid, text) from public, anon, authenticated;
revoke execute on function public.queue_personal_message(uuid, text, uuid)   from public, anon, authenticated;
revoke execute on function public.add_late_feedback_recipient(uuid, uuid)    from public, anon, authenticated;

grant execute on function public.purge_activity_log_internal(integer)       to service_role;
grant execute on function public.purge_expired_erasures_internal()          to service_role;
grant execute on function public.purge_synthetic_erasures_internal()        to service_role;
grant execute on function public.run_retention_jobs()                       to service_role;
grant execute on function public.redact_entity_audit_payload(text, uuid, text) to service_role;
grant execute on function public.queue_personal_message(uuid, text, uuid)   to service_role;
grant execute on function public.add_late_feedback_recipient(uuid, uuid)    to service_role;

-- Fails the migration if any of them is still reachable from a client.
do $$
declare f regprocedure;
begin
  foreach f in array array[
    'public.purge_activity_log_internal(integer)',
    'public.purge_expired_erasures_internal()',
    'public.purge_synthetic_erasures_internal()',
    'public.run_retention_jobs()',
    'public.redact_entity_audit_payload(text, uuid, text)',
    'public.queue_personal_message(uuid, text, uuid)',
    'public.add_late_feedback_recipient(uuid, uuid)'
  ]::regprocedure[] loop
    if has_function_privilege('anon', f, 'execute')
       or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is still executable by a client role', f;
    end if;
  end loop;
end $$;
