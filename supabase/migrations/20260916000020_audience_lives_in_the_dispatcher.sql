-- ============================================================================
-- Removing a trap: event_message_audience()
--
-- It was written in 20260916000008 as the one definition of "who should get
-- this message", on the reasoning that the edge function should not be able to
-- drift away from the database's answer. The dispatcher was then built with
-- its own resolver in supabase/functions/_shared/audience.ts, which is the
-- better place for it — the audience is per kind, and feedback_open has to be
-- resolved from event_attendance rather than from registrations (FDB-06),
-- which is a branch that belongs next to the sending logic.
--
-- So the SQL function has no callers. Confirmed across supabase/migrations,
-- supabase/functions, src and scripts: its own definition and nothing else.
--
-- Dead code is not the problem. The problem is its shape. It answers
-- "everybody with a live registration", which is correct for reminder, invite,
-- update and cancelled, and wrong for feedback_open — it would email a
-- feedback request to everybody who booked and did not turn up, and land them
-- on a form they are not eligible to submit. The next person needing an
-- audience in SQL would find it, read a comment citing EML-07, and use it.
--
-- Two ways out: teach it the per-kind branch, or remove it. Removing it is
-- right, because a second implementation of audience resolution is what this
-- whole class of bug is made of, and the one in TypeScript is the one the
-- dispatcher actually runs.
--
-- Dropping an uncalled function is not a destructive schema change: no table,
-- no column, no row. The EXECUTE grant to service_role goes with it.
--
-- The signpost does not go on the function, for the obvious reason that there
-- will not be one. It goes on the table, where somebody looking for the
-- audience rule would actually look — \d+ event_messages, or any schema dump.
-- ============================================================================

drop function if exists public.event_message_audience(uuid);

comment on table public.event_messages is
  'EML-08. The send queue. Everything is scheduled here first and one dispatcher takes rows out; nothing sends an email and records it afterwards. Audience resolution is NOT in this schema — it lives in supabase/functions/_shared/audience.ts, per kind, because feedback_open resolves from event_attendance (FDB-06) while reminders resolve from registrations. Do not add a second resolver here.';

comment on table public.event_message_recipients is
  'EML-05/06/08. One row per person per message: one email each, no duplicate copies, and a retry that touches only what failed. A message queued with no rows here is resolvable only for the broadcast kinds (reminder, invite, update, cancelled, feedback_open); the per-person kinds (confirmation, payment, refund, attendee_cancelled, cohost) fail loudly instead, because the identity of the one intended recipient lives nowhere else. queue_personal_message() writes both rows together for exactly that reason.';
