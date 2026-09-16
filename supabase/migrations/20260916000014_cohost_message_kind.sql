-- ============================================================================
-- 'cohost' is a message kind again
--
-- The old event-email function told somebody they had been added as a cohost.
-- The queue rewrite in 20260916000008 built its kind list from EML-01's table,
-- which does not enumerate that message, so the kind quietly disappeared and
-- adding a cohost stopped telling them.
--
-- That is QLT-06 — existing behaviour deleted by the rebuild rather than by a
-- decision — and ORG-05 is why it matters rather than being a nicety: being
-- made a cohost is a real grant of power. They can edit the event, invite
-- people, scan tickets at the door and issue refunds. Finding that out by
-- accident is not acceptable, and finding it out never is worse.
--
-- The mailer already sends it. The database was refusing it on insert, so the
-- correct code failed against the wrong constraint.
--
-- Dropping and re-adding a CHECK is not a data rewrite and stays inside the
-- additive-only rule: no table goes, no column goes, and no row changes. The
-- re-add revalidates the existing rows, all of which already satisfy the wider
-- list because it is a superset of the old one.
-- ============================================================================

alter table public.event_messages
  drop constraint if exists event_messages_kind_known;

alter table public.event_messages
  add constraint event_messages_kind_known check (kind in (
    'confirmation', 'payment', 'reminder', 'invite', 'update',
    'cancelled', 'attendee_cancelled', 'refund', 'feedback_open',
    -- ORG-05, QLT-06. Not in EML-01's table because that table lists what the
    -- event platform adds; this one predates it.
    'cohost'
  ));

-- ---------------------------------------------------------------------------
-- Everywhere else a kind is named — checked, and deliberately unchanged
--
-- This constraint is the only place the full vocabulary is written down. The
-- other four references are all narrower on purpose, and widening any of them
-- would be wrong:
--
--   event_messages_live_feedback_idx  predicate on 'feedback_open' alone. It
--                                     exists to stop two feedback invitations
--                                     being scheduled for one event.
--   schedule_event_messages()         handles ('reminder', 'feedback_open') —
--                                     the two kinds derived from the event's
--                                     own times. A cohost notice is not on a
--                                     schedule; it happens when somebody is
--                                     added.
--   stamp_details_notified()          'update' alone, EML-08.
--   queue_event_message()             the allowlist of kinds a *host* may
--                                     queue by hand: update, reminder, invite,
--                                     cancelled, feedback_open. 'cohost' stays
--                                     out of it. The message is a consequence
--                                     of adding a cohost, not a button, and a
--                                     host who could queue one by hand could
--                                     tell somebody they have powers they have
--                                     not been given.
--
-- event_message_recipients carries no kind column at all, so there is no
-- second list there to drift from this one.
-- ---------------------------------------------------------------------------
