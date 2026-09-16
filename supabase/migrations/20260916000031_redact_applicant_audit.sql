-- ============================================================================
-- Waitlist applicants and unclaimed invitations leave nothing behind
--
-- Deleting a waitlist entry removes the row and leaves the applicant's email,
-- phone, LinkedIn URL, home city, travel plans and every free-text answer they
-- gave sitting in activity_log for 548 days. log_waitlist_entries attaches
-- log_activity() with no skip list at all, so the payload is the entire row.
-- An unclaimed connector invitation is the same shape, and its payload also
-- carries the claim code.
--
-- Same bug 20260916000029 fixed for profiles, one table over, and older than
-- anything this build introduced.
--
-- ---------------------------------------------------------------------------
-- No tombstone, and no retention clock
--
-- "Redact, retain, expire" exists because Article 17(3)(b) carves out what a
-- legal obligation requires, and Companies Act s.388 requires six years of
-- accounting records. That is what justifies keeping an erased attendee's
-- orders.
--
-- An applicant has no orders. No payment, no ticket, no financial record,
-- nothing retained under any exemption — so Article 17 applies in full with
-- nothing carved out of it. A data_subject_erasures row with a 2033 date would
-- assert an obligation that does not exist, and put a retention clock on data
-- there is no right to retain at all. So: scrub, and keep nothing.
--
-- The label is generic for the same reason. A pseudonym exists to preserve
-- linkage across retained financial records; there are none here, so there is
-- nothing to link and a stable identifier would be a small step backwards.
--
-- ---------------------------------------------------------------------------
-- Why this replaces the whole payload instead of matching values
--
-- The brief expected redact_jsonb_values() and whole-value matching, as in
-- 20260916000029. Three reasons this is scoped and wholesale instead, and the
-- first is the one that matters:
--
--   1. A global value match would be actively WRONG here. Assignment does not
--      delete a waitlist row — it stamps assigned_at — so an applicant who
--      joined keeps both their waitlist entry and a live profile. If an admin
--      later deletes that entry, matching on their email across the log would
--      scrub the audit rows of a member who has asked for nothing. Scoping to
--      the entity's own rows makes that impossible.
--
--   2. Scoped means nothing unrelated is in reach, so the "Sample size"
--      hazard that made whole-value matching necessary for profiles does not
--      arise at all.
--
--   3. Wholesale is complete. Matching on name, email, phone and LinkedIn
--      would leave home_city, travel_destinations, current_project,
--      background, room_contribution and curation_notes — all personal data
--      about somebody who has asked to be gone — and the claim code on an
--      invitation, which is a credential.
--
-- The event survives exactly as before: action, entity, entity_id and
-- created_at are untouched, so "waitlist_entries.delete at 14:02" remains a
-- fact. Who it was stops being one.
--
-- ---------------------------------------------------------------------------
-- Triggers rather than a line in delete_waitlist_entry()
--
-- Checked rather than assumed, as asked: no cascade can reach either table —
-- every foreign key pointing at them is ON DELETE SET NULL — and neither has a
-- delete policy. delete_waitlist_entry() is the only application route, and
-- connector_invitations has no route at all. So a function-level scrub would
-- in fact cover the application today.
--
-- It stays a trigger because the paths that remain are the ones a function
-- cannot see: a service-role DELETE, a psql session, a future admin screen
-- that adds the delete policy that migration deliberately withheld. Same
-- argument as log_activity() itself, which is a trigger for exactly this.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The scrub
--
-- Idempotent on the `redacted` key, so a re-run and the backfill below cannot
-- stack labels or count the same row twice. Revoked from PUBLIC: Postgres
-- grants EXECUTE to PUBLIC by default and this rewrites audit rows.
-- ---------------------------------------------------------------------------

create or replace function public.redact_entity_audit_payload(
  p_entity    text,
  p_entity_id uuid,
  p_label     text
)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_rows int;
begin
  update public.activity_log
  set detail = jsonb_build_object('redacted', p_label)
  where entity = p_entity
    and entity_id = p_entity_id
    and detail is not null
    and not (detail ? 'redacted');

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.redact_entity_audit_payload(text, uuid, text) from public;

comment on function public.redact_entity_audit_payload(text, uuid, text) is
  'GDPR Art. 17. Replaces the audit payload for one entity''s rows with a generic label, keeping the event, the entity and the timestamp. For records held under no retention exemption — an applicant, an unclaimed invitation — where nothing may be kept.';

-- ---------------------------------------------------------------------------
-- 2. The two triggers
--
-- Named to sort after log_waitlist_entries and log_connector_invitations.
-- Postgres fires row triggers in name order, and the delete row has to exist
-- before it can be scrubbed — the same ordering trap 20260916000029 hit, where
-- a BEFORE DELETE scrub would have missed the fullest copy of the record.
-- ---------------------------------------------------------------------------

create or replace function public.redact_waitlist_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.redact_entity_audit_payload(
    'waitlist_entries', old.id, 'A withdrawn applicant'
  );
  return null;
end;
$$;

create trigger trg_redact_waitlist_audit
  after delete on public.waitlist_entries
  for each row execute function public.redact_waitlist_audit();

create or replace function public.redact_connector_invitation_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.redact_entity_audit_payload(
    'connector_invitations', old.id, 'A withdrawn invitation'
  );
  return null;
end;
$$;

create trigger trg_redact_connector_invitation_audit
  after delete on public.connector_invitations
  for each row execute function public.redact_connector_invitation_audit();

-- ---------------------------------------------------------------------------
-- 3. The rows already there
--
-- Only where the entity is gone. A live waitlist entry's audit rows stay
-- exactly as they are: that person has asked for nothing, and their
-- application is a record the admin screen is entitled to.
-- ---------------------------------------------------------------------------

do $$
declare
  v_waitlist    int;
  v_invitations int;
begin
  update public.activity_log a
  set detail = jsonb_build_object('redacted', 'A withdrawn applicant')
  where a.entity = 'waitlist_entries'
    and a.entity_id is not null
    and a.detail is not null
    and not (a.detail ? 'redacted')
    and not exists (
      select 1 from public.waitlist_entries w where w.id = a.entity_id
    );
  get diagnostics v_waitlist = row_count;

  update public.activity_log a
  set detail = jsonb_build_object('redacted', 'A withdrawn invitation')
  where a.entity = 'connector_invitations'
    and a.entity_id is not null
    and a.detail is not null
    and not (a.detail ? 'redacted')
    and not exists (
      select 1 from public.connector_invitations i where i.id = a.entity_id
    );
  get diagnostics v_invitations = row_count;

  insert into public.activity_log (actor_id, action, entity, detail)
  values (
    null,
    'activity_log.redact_backfill',
    'activity_log',
    jsonb_build_object(
      'waitlist_rows',    v_waitlist,
      'invitation_rows',  v_invitations,
      'note',             'Applicants and invitations whose row no longer exists. No retention exemption applies, so nothing is kept.'
    )
  );

  raise notice 'Applicant audit backfill: % waitlist rows, % invitation rows.',
    v_waitlist, v_invitations;
end;
$$;
