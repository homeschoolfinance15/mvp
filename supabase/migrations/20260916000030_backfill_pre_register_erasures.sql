-- ============================================================================
-- The deletions that predate the register
--
-- 20260916000029 scrubbed 46 of 116. The other 70 were deleted before
-- data_subject_erasures existed, so they have no tombstone — and that backfill
-- keyed off the tombstone for both halves of what it needed: the pseudonym to
-- substitute, and the needles to search for. With no register entry there was
-- nothing to work from, so it correctly did nothing.
--
-- The result is a database where the property the suite asserts is false:
-- audit rows still hold the email addresses of people whose profiles are gone.
-- Every one is a fixture, verified twice over, so there is no live exposure —
-- but an assertion that is untrue of the database it runs against is the kind
-- of gap that gets explained away in six months rather than fixed.
--
-- ---------------------------------------------------------------------------
-- A reconstructed pseudonym, not a generic label
--
-- The brief expected a generic label, on the reasoning that there is no
-- register entry to be consistent with. There does not have to be one: the
-- pseudonym is a pure function of the subject id —
--
--     'Former attendee ' || upper(substr(replace(id::text, '-', ''), 1, 4))
--
-- — and activity_log.entity_id on a profiles row *is* that id. So every one of
-- these gets exactly the label the live trigger would have given it, and the
-- register ends up complete and consistent rather than holding two classes of
-- entry that have to be explained to each other.
--
-- The needles still come from the payload, because the profiles are gone and
-- the log is the only place their details survive. That is precisely the
-- problem being fixed, and precisely what makes it fixable.
--
-- erased_at is the audit row's own created_at rather than now(): these people
-- were erased when they were erased, and stamping today would put seven years
-- of retention on a deletion that happened last week.
--
-- ---------------------------------------------------------------------------
-- These tombstones are expected to disappear, and that is not data loss
--
-- Every one of them is synthetic — .invalid domains, as before — and
-- run_retention_jobs() sweeps synthetic tombstones older than seven days. So
-- the Sunday after this lands, most of these register rows go. That is the
-- correct outcome and it is worth writing down so it does not read as a bug
-- later: the tombstone's job here is to key this scrub and to make the register
-- briefly complete. Once the payloads are redacted the scrub never needs doing
-- again, and a test fixture has no retention obligation to record.
-- ============================================================================

do $$
declare
  r           record;
  v_pseudonym text;
  v_needles   text[];
  v_patterns  text[];
  v_subjects  int := 0;
  v_rows      int := 0;
  v_touched   int;
begin
  for r in
    -- The earliest deletion row per subject that the register does not know
    -- about. The loop's query is a snapshot, so the tombstones written inside
    -- it do not shrink it underneath us.
    select distinct on (a.entity_id)
           a.entity_id as subject_id,
           a.created_at,
           a.detail
    from public.activity_log a
    where a.entity = 'profiles'
      and a.action = 'profiles.delete'
      and a.entity_id is not null
      and a.detail is not null
      and not exists (
        select 1 from public.data_subject_erasures e where e.subject_id = a.entity_id
      )
    order by a.entity_id, a.created_at
  loop
    v_pseudonym := 'Former attendee '
                   || upper(substr(replace(r.subject_id::text, '-', ''), 1, 4));

    insert into public.data_subject_erasures
      (subject_id, pseudonym, erased_at, retention_until, lawful_basis, synthetic)
    values (
      r.subject_id,
      v_pseudonym,
      r.created_at,
      (r.created_at + make_interval(years => public.erasure_retention_years()))::date,
      'legal_obligation',
      coalesce(lower(r.detail ->> 'email') like '%.invalid', false)
    )
    on conflict (subject_id) do nothing;

    v_subjects := v_subjects + 1;

    v_needles := array_remove(array[
      nullif(btrim(coalesce(r.detail ->> 'email', '')), ''),
      nullif(btrim(coalesce(r.detail ->> 'full_name', '')), ''),
      nullif(btrim(coalesce(r.detail ->> 'linkedin_url', '')), '')
    ], null);

    -- A deletion row that carried no identifying values still earns its
    -- tombstone, so the register is complete, but there is nothing to scrub.
    if coalesce(array_length(v_needles, 1), 0) = 0 then
      continue;
    end if;

    select array_agg('%' || n || '%') into v_patterns from unnest(v_needles) n;

    -- Same reach as the trigger: this subject's own rows, plus anywhere their
    -- details appear by value under another entity — a connector_invitations
    -- payload naming the invitee, a waitlist_entries one naming an applicant.
    update public.activity_log
    set detail = public.redact_jsonb_values(detail, v_needles, v_pseudonym)
    where detail is not null
      and (entity_id = r.subject_id or detail::text ilike any (v_patterns));

    get diagnostics v_touched = row_count;
    v_rows := v_rows + v_touched;
  end loop;

  insert into public.activity_log (actor_id, action, entity, detail)
  values (
    null,
    'activity_log.redact_backfill',
    'activity_log',
    jsonb_build_object(
      'subjects_registered', v_subjects,
      'rows_redacted',       v_rows,
      'note',                'Deletions predating data_subject_erasures; pseudonyms reconstructed from subject id.'
    )
  );

  raise notice 'Pre-register erasures: % subjects registered, % audit rows redacted.',
    v_subjects, v_rows;
end;
$$;
