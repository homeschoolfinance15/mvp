-- ============================================================================
-- The audit log stops naming people it has erased
--
-- 20260907000010 wrote the principle and only half-implemented it:
--
--   "actor_id is ON DELETE SET NULL on purpose: an erased person should stop
--    being identifiable in the log while the events they caused remain."
--
-- actor_id is nulled. The detail payload was never considered. log_activity()
-- skips only the long free-text columns, so a profiles.delete row carries the
-- whole record — email, full_name, linkedin_url — and 20260916000022's
-- redaction does not touch activity_log at all.
--
-- So today: somebody asks to be erased, their orders and attendance are
-- correctly pseudonymised, a tombstone is written, and their name and email sit
-- in the audit log in plain text for 548 days, readable by any admin. The
-- erasure is defeated by the record of the erasure.
--
-- The fix is the sentence that migration already wrote: the event survives,
-- the person stops being identifiable. Not the alternative of adding email and
-- full_name to log_activity()'s skip list, which would blind the audit trail
-- for every living member to fix a problem that only exists for erased ones.
--
-- ---------------------------------------------------------------------------
-- Two things this gets right that are easy to get wrong
--
-- WHEN. log_profiles is an AFTER DELETE trigger, so the profiles.delete row —
-- the very row carrying the fullest copy of the record — does not exist yet
-- when record_data_subject_erasure() runs BEFORE DELETE. Redacting there would
-- miss it entirely. This is therefore a second AFTER DELETE trigger, named so
-- that it sorts after log_profiles: Postgres fires row triggers in name order,
-- and 'trg_redact...' follows 'log_profiles'. OLD is still fully readable in
-- an AFTER DELETE trigger, which is what makes the needles available.
--
-- WHICH ROWS. Not only the rows whose entity_id is the subject. Their email
-- appears by value in other entities' payloads — a connector_invitations row
-- names the invitee's email, a waitlist_entries row names an applicant's — and
-- those are the same person's personal data sitting under a different entity.
-- So the match is on the values themselves, wherever they appear.
--
-- ---------------------------------------------------------------------------
-- Updating an append-only log, deliberately
--
-- activity_log has no update policy and no update grant, and its own header
-- calls it append-only. This is the exception and it is worth naming: nothing
-- here amends the record of what happened. action, entity, entity_id and
-- created_at are untouched, so every event and its ordering survive exactly.
-- What changes is identifying data the log should not have been holding past
-- an erasure request. Deleting the rows outright would be the alternative and
-- it is strictly worse — it destroys the evidence as well as the name.
--
-- The redaction is itself logged, because a scrub nobody can see is the same
-- problem one layer along.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Replacing whole values, never substrings
--
-- Exact, case-insensitive matches of a complete string value, walking objects
-- and arrays so it reaches both payload shapes log_activity() produces: the
-- flat row on insert and delete, and the {column: {from, to}} diff on update.
--
-- Deliberately not a text-level replace over detail::text. A member called Sam
-- would turn "Sample size" into "Former attendee 8F2A" + "ple size" somewhere
-- else in the log, and a corrupted audit trail is a worse outcome than the one
-- being fixed.
-- ---------------------------------------------------------------------------

create or replace function public.redact_jsonb_values(
  p_doc         jsonb,
  p_needles     text[],
  p_replacement text
)
returns jsonb
language plpgsql immutable
as $$
declare
  v_key text;
  v_val jsonb;
  v_out jsonb;
begin
  if p_doc is null then
    return null;
  end if;

  case jsonb_typeof(p_doc)
    when 'object' then
      v_out := '{}'::jsonb;
      for v_key, v_val in select * from jsonb_each(p_doc) loop
        v_out := v_out || jsonb_build_object(
          v_key, public.redact_jsonb_values(v_val, p_needles, p_replacement)
        );
      end loop;
      return v_out;

    when 'array' then
      return coalesce(
        (select jsonb_agg(public.redact_jsonb_values(e, p_needles, p_replacement))
           from jsonb_array_elements(p_doc) e),
        '[]'::jsonb
      );

    when 'string' then
      if exists (
        select 1 from unnest(p_needles) n
         where lower(n) = lower(p_doc #>> '{}')
      ) then
        return to_jsonb(p_replacement);
      end if;
      return p_doc;

    else
      return p_doc;
  end case;
end;
$$;

comment on function public.redact_jsonb_values(jsonb, text[], text) is
  'Replaces whole string values matching any needle, recursing through objects and arrays. Whole values only — a substring replace would corrupt unrelated text.';

-- ---------------------------------------------------------------------------
-- 2. The scrub
--
-- Runs after log_profiles has written the delete row, and reads the pseudonym
-- the BEFORE DELETE trigger already recorded, so an admin reading an old audit
-- entry sees the same label the financial records carry rather than a hole.
--
-- ponytail: the value match is a sequential scan of activity_log per erasure.
-- Erasures are rare and the table is small; if that ever stops being true, the
-- narrow fix is a functional index on detail, not a narrower match.
-- ---------------------------------------------------------------------------

create or replace function public.redact_activity_log_for_erasure()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_pseudonym text;
  v_needles   text[];
  v_patterns  text[];
  v_rows      int;
begin
  select pseudonym into v_pseudonym
  from public.data_subject_erasures where subject_id = old.id;

  -- No tombstone means the BEFORE DELETE trigger did not run — nothing to
  -- redact against, and inventing a label here would be worse than leaving it.
  if v_pseudonym is null then
    return null;
  end if;

  v_needles := array_remove(array[
    nullif(btrim(coalesce(old.email, '')), ''),
    nullif(btrim(coalesce(old.full_name, '')), ''),
    nullif(btrim(coalesce(old.linkedin_url, '')), '')
  ], null);

  if coalesce(array_length(v_needles, 1), 0) = 0 then
    return null;
  end if;

  select array_agg('%' || n || '%') into v_patterns from unnest(v_needles) n;

  update public.activity_log
  set detail = public.redact_jsonb_values(detail, v_needles, v_pseudonym)
  where detail is not null
    and (entity_id = old.id or detail::text ilike any (v_patterns));

  get diagnostics v_rows = row_count;

  -- Carries the pseudonym and a count, and no personal data of its own.
  insert into public.activity_log (actor_id, action, entity, entity_id, detail)
  values (
    null,
    'activity_log.redact',
    'activity_log',
    old.id,
    jsonb_build_object('rows_redacted', v_rows, 'pseudonym', v_pseudonym)
  );

  return null;
end;
$$;

comment on function public.redact_activity_log_for_erasure() is
  'GDPR Art. 17. Replaces an erased person''s name, email and profile link wherever they appear in activity_log.detail, under any entity, with the pseudonym from data_subject_erasures. The events and their ordering are untouched.';

-- After log_profiles, which is what the name buys: Postgres fires row triggers
-- in name order, and the profiles.delete row has to exist before it can be
-- scrubbed.
create trigger trg_redact_activity_log_for_erasure
  after delete on public.profiles
  for each row execute function public.redact_activity_log_for_erasure();

-- ---------------------------------------------------------------------------
-- 3. The rows already there
--
-- Every erasure recorded so far is a test fixture — confirmed twice, once from
-- the .invalid domains and once from the audit log's own profiles.delete rows —
-- so nothing here is a live exposure. It is still scrubbed, because leaving
-- known-identifiable payloads behind while shipping a trigger that prevents
-- new ones is the kind of half-measure this migration exists to undo.
--
-- The needles can only come from the payloads themselves now: the profiles
-- rows are gone, so there is no email to read except the one the log kept.
-- That is precisely why this is a problem and precisely why it is fixable.
-- ---------------------------------------------------------------------------

do $$
declare
  r          record;
  v_needles  text[];
  v_patterns text[];
begin
  for r in
    select e.subject_id, e.pseudonym
    from public.data_subject_erasures e
  loop
    select array_remove(array[
             nullif(btrim(coalesce(a.detail ->> 'email', '')), ''),
             nullif(btrim(coalesce(a.detail ->> 'full_name', '')), ''),
             nullif(btrim(coalesce(a.detail ->> 'linkedin_url', '')), '')
           ], null)
      into v_needles
    from public.activity_log a
    where a.entity = 'profiles'
      and a.entity_id = r.subject_id
      and a.detail ? 'email'
    limit 1;

    if coalesce(array_length(v_needles, 1), 0) = 0 then
      continue;
    end if;

    select array_agg('%' || n || '%') into v_patterns from unnest(v_needles) n;

    update public.activity_log
    set detail = public.redact_jsonb_values(detail, v_needles, r.pseudonym)
    where detail is not null
      and (entity_id = r.subject_id or detail::text ilike any (v_patterns));
  end loop;

  insert into public.activity_log (actor_id, action, entity, detail)
  values (null, 'activity_log.redact_backfill', 'activity_log',
          jsonb_build_object('note', 'One-off scrub of erasures recorded before 20260916000029.'));
end;
$$;
