-- ============================================================================
-- Actually running the retention jobs
--
-- Both purge functions have been correct and unreachable since the day they
-- were written. They gate on is_admin(), a scheduler has no identity —
-- auth.uid() is null for the service role and for pg_cron alike — so the gate
-- that makes them safe by hand is the thing that stops them running on their
-- own. Article 5(1)(e) is not satisfied by a function nobody can call.
--
-- Two doors onto one body, the shape event_sale_readiness() already uses:
--
--   purge_*_internal()   the work, no gate, revoked from everybody
--   purge_*()            the admin door, gate unchanged, for a human
--   run_retention_jobs() the scheduler door, revoked from everybody, which
--                        means the cron job's own role and nothing else
--
-- Splitting the gate from the work is the point. The existing admin functions
-- keep their exact signatures, their exact refusal messages and their exact
-- audit action strings, so anything reading the log for 'activity_log.purge'
-- keeps working.
--
-- Safe to schedule today because neither job can delete anything yet: the
-- oldest audit row is eight days old against a 548-day threshold, and the
-- oldest erasure is today against seven years. That is the right way round —
-- months of watching a scheduled job log zero before it ever removes a row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Telling a test tombstone from a real one
--
-- Every acceptance run creates users and deletes them in a `finally`, and each
-- deletion correctly fires the erasure trigger. That is the trigger working;
-- suppressing it under test would mean the tests stop exercising the thing
-- they exist to exercise. So the register tolerates them, and gets a way to
-- tell them apart.
--
-- The marker is the email domain, and it is reliable rather than a heuristic:
-- all three suites use .invalid, which RFC 2606 reserves permanently and which
-- no resolver will ever answer. A real person cannot hold one.
--
-- A boolean, not the domain itself. Keeping "the domain of the erased person's
-- email" would retain a fragment of exactly the personal data this table exists
-- to have destroyed.
-- ---------------------------------------------------------------------------

alter table public.data_subject_erasures
  add column synthetic boolean not null default false;

comment on column public.data_subject_erasures.synthetic is
  'True when the erased account was a test fixture, identified at erasure time by an RFC 2606 .invalid email domain. Retention obligations are about real records; these carry none and are swept weekly.';

-- Every row in this table today was made by an acceptance-suite teardown, as
-- confirmed by the team lead against a production database holding one real
-- profile. Marking rather than deleting: a flag is reversible and a delete is
-- not, and these will be swept by the scheduled job in a week anyway.
update public.data_subject_erasures set synthetic = true;

create or replace function public.record_data_subject_erasure()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_pseudonym text;
begin
  v_pseudonym := 'Former attendee ' || upper(substr(replace(old.id::text, '-', ''), 1, 4));

  insert into public.data_subject_erasures
    (subject_id, pseudonym, retention_until, lawful_basis, synthetic)
  values (
    old.id,
    v_pseudonym,
    (now() + make_interval(years => public.erasure_retention_years()))::date,
    'legal_obligation',
    coalesce(lower(old.email) like '%.invalid', false)
  )
  on conflict (subject_id) do nothing;

  update public.event_orders     set erased_subject_id = old.id where profile_id = old.id;
  update public.event_attendance set erased_subject_id = old.id where profile_id = old.id;
  update public.peer_feedback    set erased_subject_id = old.id where author_id  = old.id;
  update public.event_feedback   set erased_subject_id = old.id where author_id  = old.id;

  return old;
end;
$$;

comment on function public.record_data_subject_erasure() is
  'GDPR Art. 17(3)/4(5). Redacts a departing person to a stable pseudonym and stamps the retained rows with the id that links them, before the foreign keys null the reference. Flags a test fixture by its .invalid email domain.';

-- ---------------------------------------------------------------------------
-- 2. The work, without the gate
--
-- Revoked from PUBLIC, which is not the default: Postgres grants EXECUTE on a
-- new function to PUBLIC unless told otherwise, and an ungated delete that
-- anybody holding a session can call is worse than no scheduler at all.
-- ---------------------------------------------------------------------------

create or replace function public.purge_activity_log_internal(p_keep_days int)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  -- A safety rule rather than an authorisation rule, so it belongs here where
  -- both doors inherit it.
  if p_keep_days < 30 then
    raise exception 'Refusing to keep less than 30 days of audit history.';
  end if;

  delete from public.activity_log
  where created_at < now() - make_interval(days => p_keep_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.purge_activity_log_internal(int) from public;

create or replace function public.purge_expired_erasures_internal()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_subjects int;
begin
  delete from public.event_orders o
   using public.data_subject_erasures e
   where o.erased_subject_id = e.subject_id and e.retention_until <= current_date;

  delete from public.event_attendance a
   using public.data_subject_erasures e
   where a.erased_subject_id = e.subject_id and e.retention_until <= current_date;

  delete from public.peer_feedback f
   using public.data_subject_erasures e
   where f.erased_subject_id = e.subject_id and e.retention_until <= current_date;

  delete from public.event_feedback f
   using public.data_subject_erasures e
   where f.erased_subject_id = e.subject_id and e.retention_until <= current_date;

  delete from public.data_subject_erasures where retention_until <= current_date;
  get diagnostics v_subjects = row_count;

  return v_subjects;
end;
$$;

revoke execute on function public.purge_expired_erasures_internal() from public;

-- Test tombstones are not a retention question. Nothing is retained under an
-- exemption for a subject that never existed, so the seven years do not apply
-- and they are swept once they are old enough to be certainly finished with.
--
-- ponytail: a week, which is long enough that an interrupted suite's rows are
-- still there to look at the next morning and short enough that they never
-- accumulate. Not configurable; make it so if anybody ever cares.
create or replace function public.purge_synthetic_erasures_internal()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from public.data_subject_erasures
  where synthetic and erased_at < now() - interval '7 days';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.purge_synthetic_erasures_internal() from public;

-- ---------------------------------------------------------------------------
-- 3. The admin door, unchanged in every way that shows
--
-- Same signatures, same refusals, same audit action strings.
-- ---------------------------------------------------------------------------

create or replace function public.purge_activity_log(p_keep_days int default 548)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can purge the activity log.';
  end if;

  v_deleted := public.purge_activity_log_internal(p_keep_days);

  -- The purge is itself an audited event. A log that can be silently trimmed
  -- is not evidence of anything.
  insert into public.activity_log (actor_id, action, entity, detail)
  values (
    auth.uid(),
    'activity_log.purge',
    'activity_log',
    jsonb_build_object('kept_days', p_keep_days, 'rows_deleted', v_deleted)
  );

  return v_deleted;
end;
$$;

create or replace function public.purge_expired_erasures()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_subjects int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can purge expired records.';
  end if;

  v_subjects := public.purge_expired_erasures_internal();

  insert into public.activity_log (actor_id, action, entity, detail)
  values (auth.uid(), 'data_subject_erasures.purge', 'data_subject_erasures',
          jsonb_build_object('subjects_purged', v_subjects));

  return v_subjects;
end;
$$;

comment on function public.purge_expired_erasures() is
  'GDPR Art. 5(1)(e). Destroys retained records whose retention period has ended. The admin door; run_retention_jobs() is the scheduled one, and both do the same work.';

-- ---------------------------------------------------------------------------
-- 4. The scheduler door
--
-- One entry point rather than three cron jobs, so there is one thing to check
-- is registered and one row in cron.job_run_details to read.
--
-- It logs unconditionally, including a run that deleted nothing, which is the
-- point for the next eighteen months: a job that logs zero every week is
-- visibly working, and its absence from the log is visibly not. A retention
-- job that deletes silently is worse than one that does not run, and in 2033
-- somebody will want to know why forty rows went.
--
-- actor_id is null and stays null. No person did this.
-- ---------------------------------------------------------------------------

create or replace function public.run_retention_jobs()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_audit     int;
  v_expired   int;
  v_synthetic int;
  v_detail    jsonb;
begin
  v_expired   := public.purge_expired_erasures_internal();
  v_synthetic := public.purge_synthetic_erasures_internal();
  -- Last, so that the rows the two above just wrote are not candidates in the
  -- same run. They would not be — they are seconds old against 548 days — but
  -- ordering it this way means that stays true if the threshold ever changes.
  v_audit     := public.purge_activity_log_internal(548);

  v_detail := jsonb_build_object(
    'audit_rows_deleted',    v_audit,
    'subjects_purged',       v_expired,
    'test_tombstones_swept', v_synthetic,
    'kept_days',             548
  );

  insert into public.activity_log (actor_id, action, entity, detail)
  values (null, 'retention.scheduled_run', 'activity_log', v_detail);

  return v_detail;
end;
$$;

comment on function public.run_retention_jobs() is
  'GDPR Art. 5(1)(e). The scheduled retention sweep: expired erasures, test tombstones, then the audit log. Executable by nobody — the cron job runs as its owner. Logs every run including the ones that delete nothing.';

revoke execute on function public.run_retention_jobs() from public;

-- ---------------------------------------------------------------------------
-- 5. The schedule
--
-- Weekly, Sunday, 03:17. Off-peak, and an odd minute rather than the top of
-- the hour where everything else in the world is already firing.
--
-- Wrapped the same way 20260916000008 wraps its pg_cron attempt: a project
-- where this role cannot create the extension logs a notice and migrates
-- cleanly rather than failing the push, and the notice carries the exact
-- statement to run from the dashboard instead.
--
-- The job runs as whoever schedules it, which is the migration role, which is
-- why the revokes above do not lock it out.
-- ---------------------------------------------------------------------------

do $$
begin
  create extension if not exists pg_cron;

  begin
    perform cron.unschedule('amazing-retention');
  exception when others then
    null;  -- nothing to unschedule on a first run
  end;

  perform cron.schedule('amazing-retention', '17 3 * * 0', 'select public.run_retention_jobs();');
  raise notice 'retention sweep scheduled: amazing-retention, Sundays at 03:17.';

exception when others then
  raise notice 'retention sweep NOT scheduled (%). Enable pg_cron from the dashboard, then run: select cron.schedule(''amazing-retention'', ''17 3 * * 0'', ''select public.run_retention_jobs();'');', sqlerrm;
end;
$$;
