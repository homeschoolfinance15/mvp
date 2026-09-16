-- ============================================================================
-- Event platform — types, and nothing else
--
-- This file is deliberately one thing. Postgres will not let a transaction
-- use an enum value that the same transaction added, and the Supabase CLI
-- wraps every migration file in its own transaction. So the moment a table,
-- a policy or a seed in this file referenced 'event_registered', the whole
-- migration would fail with "unsafe use of new value of enum type".
--
-- Everything that uses these types therefore lives in 20260916000002 onward.
-- If you are about to add a column here: don't. Add the type here and the
-- column in the next file.
--
-- Which things are enums and which are text + check is not arbitrary. The six
-- below are the state machines CONTRACT.md §3 names, and they are mirrored in
-- src/lib/events.ts, so a typo in either place should be a hard error. The
-- looser vocabularies — a message kind, an invite's send status, whether an
-- attendance was scanned or typed in — are check constraints instead, because
-- those lists grow, and growing a check constraint does not need a migration
-- that nothing else may share.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The state machines
-- ---------------------------------------------------------------------------

-- Finished is not here on purpose: an event that has ended is a fact about
-- ends_at and the clock, not a row somebody has to remember to update.
create type event_status as enum ('draft', 'published', 'cancelled');

-- 'pending' is a place held while a payment completes (BUY-06); 'expired' is
-- that hold lapsing. Both are distinct from a person cancelling (BUY-08),
-- because only one of the three is something the attendee decided.
create type registration_status as enum ('pending', 'confirmed', 'cancelled', 'expired');

create type order_status as enum (
  'pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'cancelled'
);

-- 'needs_attention' is the state a refund lands in when Stripe said something
-- we did not plan for. It is a human's queue, not a failure: BUY-09 cares
-- that money is never quietly lost, and "failed" invites a silent retry.
create type refund_status as enum (
  'requested', 'processing', 'completed', 'failed', 'needs_attention'
);

-- 'skipped' is a reminder whose moment passed before the dispatcher reached
-- it — EML-06 says a late reminder is worse than no reminder.
create type message_status as enum (
  'scheduled', 'queued', 'sent', 'failed', 'cancelled', 'skipped'
);

-- FDB-05. Four distinguishable states, because "I have not got to them yet",
-- "I chose not to answer" and "we never actually met" are three different
-- facts about a respondent and none of them is an unfavourable review.
create type feedback_outcome as enum ('pending', 'skipped', 'did_not_meet', 'submitted');

-- ATT-02. Every outcome a scan can have. A door is a bad place to work out
-- what an error meant, so the function hands back one of exactly five words
-- and the screen has a sentence ready for each.
create type check_in_result as enum ('ok', 'already', 'wrong_event', 'invalid', 'cancelled');

-- ---------------------------------------------------------------------------
-- 2. New notification kinds
--
-- One statement each, and 'if not exists' so re-running against a partially
-- migrated project is not a wall.
-- ---------------------------------------------------------------------------

alter type notification_kind add value if not exists 'event_registered';
alter type notification_kind add value if not exists 'event_updated';
alter type notification_kind add value if not exists 'event_cancelled';
alter type notification_kind add value if not exists 'feedback_open';
