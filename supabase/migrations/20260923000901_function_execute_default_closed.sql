-- ============================================================================
-- SEC-5. Functions are closed to the client roles unless named here.
--
-- Supabase grants EXECUTE on every new function in public to anon and
-- authenticated, and Postgres grants it to PUBLIC. So each internal helper
-- has been open until a later migration remembered to revoke it
-- (20260922000002 exists because three of them were not). This turns the
-- default round: nothing is callable from a browser unless it is granted
-- below, by name, to the roles that need it.
--
-- Who needs what, as read from the code and the database on 2026-09-23:
--
--   anon           lookup_code for /join and the landing page code box, and
--                  whatever the signed-out screens reach indirectly: the
--                  events_select and ticket_types_select policies, the
--                  event_public / event_availability / ticket_type_availability
--                  views, and the check constraints on waitlist_entries.
--                  Policies, views and check constraints call functions as
--                  the reader, not the owner, so those need the grant too.
--   authenticated  every supabase.rpc() in src, the rpc calls the edge
--                  functions make with the caller's token (asCaller), and
--                  every function named in a policy or view.
--   service_role   untouched; it keeps what it had.
--
-- Trigger functions need no grant: EXECUTE is checked when the trigger is
-- created, not when it fires. Security definer functions call their helpers
-- as the owner, so internal helpers (generate_code, queue_event_message,
-- expire_event_holds, erase_subject_data, ...) stay closed.
--
-- A new function after this one is closed until its migration grants it.
-- scripts/check-function-grants.mjs holds the anon list and fails when a
-- function is open to anon without being on it, or when src calls one that
-- authenticated cannot.
-- ============================================================================

-- The default, for everything created from here on. The PUBLIC grant is a
-- global default and cannot be revoked per schema, so it is revoked for the
-- migration role everywhere.
-- ponytail: this also closes functions postgres creates in other schemas,
-- e.g. a future `create extension` run by a migration; grant those by name.
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;

-- Everything that exists now.
revoke execute on all functions in schema public from public, anon, authenticated;

-- Signed-out screens, and everyone signed in.
grant execute on function
  public.lookup_code(text),
  public.is_admin(),
  public.hosts_event(uuid),
  public.has_event_booking(uuid),
  public.event_visible(uuid),
  public.event_host_ids(uuid),
  public.event_capacity_state(uuid),
  public.ranked_distinct(gathering_kind[]),
  public.tag_answer_ok(jsonb, integer),
  public.tag_answer_count(jsonb)
to anon, authenticated;

-- Signed in only. The functions refuse the wrong person themselves; this is
-- only about who may ask.
grant execute on function
  -- policy and view helpers
  public.attended_event(uuid, uuid),
  public.can_post(),
  public.connects_to(uuid),
  public.has_account(),
  public.is_member(),
  public.may_create_events(uuid),
  public.may_host_events(uuid),
  public.may_invite_to_event(uuid, uuid),
  public.my_circle_id(),
  public.my_connector_id(),
  public.onboarding_complete(uuid),
  -- accounts, codes and the network
  public.redeem_code(text, text),
  public.claim_waitlist_answers(text),
  public.create_invite_code(integer),
  public.set_invite_code_status(uuid, text),
  public.create_connector_invitation(text, text, integer),
  public.revoke_connector_invitation(uuid),
  public.set_connector_capacity(uuid, integer),
  public.reassign_connector_members(uuid, uuid, uuid[]),
  public.assign_waitlist_entry(uuid, uuid),
  public.set_waitlist_declined(uuid, boolean),
  public.delete_waitlist_entry(uuid),
  public.resolve_profile_report(uuid, report_status),
  public.mark_notifications_read(),
  public.export_my_data(),
  public.delete_my_account(text),
  public.delete_managed_profile(uuid, text),
  -- events
  public.create_event_account(text),
  public.event_sale_readiness(uuid),
  public.register_free(uuid, uuid),
  public.cancel_registration(uuid),
  public.check_in(text, uuid),
  public.mark_attended(uuid, uuid, text),
  public.retry_failed_recipients(uuid),
  public.submit_event_feedback(uuid, jsonb),
  public.submit_peer_feedback(uuid, uuid, jsonb),
  public.set_feedback_outcome(uuid, uuid, feedback_outcome)
to authenticated;

-- Both views filter on auth.uid(), so anon always read nothing from them, and
-- without attended_event it would now read an error instead. Say so plainly.
revoke select on public.event_participants, public.my_feedback_progress from anon;

-- Fails the migration if anything but the list above is open to anon, or if
-- one of the internal functions is open to anyone.
do $$
declare
  v_open text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_open
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and has_function_privilege('anon', p.oid, 'execute')
     and p.proname not in ('lookup_code', 'is_admin', 'hosts_event', 'has_event_booking',
                           'event_visible', 'event_host_ids', 'event_capacity_state',
                           'ranked_distinct', 'tag_answer_ok', 'tag_answer_count');
  if v_open is not null then
    raise exception 'open to anon without being listed: %', v_open;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_open
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('purge_activity_log_internal', 'redact_entity_audit_payload',
                       'run_retention_jobs', 'erase_subject_data', 'queue_personal_message')
     and has_function_privilege('authenticated', p.oid, 'execute');
  if v_open is not null then
    raise exception 'internal function open to authenticated: %', v_open;
  end if;
end $$;
