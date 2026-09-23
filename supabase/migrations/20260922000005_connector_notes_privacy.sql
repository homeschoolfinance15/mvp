-- ============================================================================
-- A connector's notes stay the connector's
--
-- 1. The audit log stops copying note text. 20260907000001 attached
--    log_activity('note'), but the column is note_text, so nothing was skipped:
--    every insert, edit and delete of a note — including one marked private —
--    put its full text in activity_log, which any admin reads on the Log page.
--    The skip list now names the real column, and the rows already written are
--    scrubbed. The event, its actor and its time survive; only the text goes,
--    the same treatment circle_messages.body and profile_reports.body get.
--
-- 2. A note can only ever be about somebody the connector invited. The insert
--    policy says so; the update policy did not, so a PATCH could re-point an
--    existing note at another circle's member.
--
-- 3. A note has a body and a ceiling, like every other free-text table.
-- ============================================================================

-- 1. ------------------------------------------------------------------------

drop trigger if exists log_connector_notes on public.connector_notes;

create trigger log_connector_notes
  after insert or update or delete on public.connector_notes
  for each row execute function public.log_activity('note_text');

-- One key covers both payload shapes: the flat row on insert and delete, and
-- the {column: {from, to}} diff on update, which is keyed by the column too.
-- An update row whose only change was the text is left with an empty diff;
-- it stays, because the edit happened.
--
-- activity_log is append-only and this is a deliberate exception, as in
-- 20260916000029: nothing about what happened changes, only text the log
-- should never have held.
update public.activity_log
set detail = detail - 'note_text'
where entity = 'connector_notes'
  and detail ? 'note_text';

-- 2. ------------------------------------------------------------------------

drop policy if exists connector_notes_update on public.connector_notes;

create policy connector_notes_update on public.connector_notes for update to authenticated
using (connector_id = public.my_connector_id())
with check (
  connector_id = public.my_connector_id()
  and exists (
    select 1 from public.connector_user_links l
    where l.connector_id = public.connector_notes.connector_id
      and l.user_profile_id = public.connector_notes.user_profile_id
  )
);

-- 3. ------------------------------------------------------------------------
--
-- NOT VALID: notes already written are left as they are; new and edited ones
-- are checked.

alter table public.connector_notes
  drop constraint if exists connector_notes_text_length;

alter table public.connector_notes
  add constraint connector_notes_text_length
  check (length(btrim(note_text)) > 0 and length(note_text) <= 2000)
  not valid;
