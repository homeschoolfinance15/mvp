-- ============================================================================
-- Closing an account erases the person, not the payment
--
-- 20260907000010 already settled this question for the audit log: "actor_id is
-- ON DELETE SET NULL on purpose: an erased person should stop being
-- identifiable in the log while the events they caused remain." An order is
-- the same question and gets the same answer.
--
-- The concrete harm, which is what makes this a correctness fix rather than a
-- retention preference: if a completed order vanishes when somebody closes
-- their account, that event's reported ticket sales change retroactively.
-- ORG-13 requires results to come from actual payment records, and an
-- organiser opening their event in March to find that February's revenue
-- figure has quietly dropped — because an attendee deleted themselves — is
-- exactly the practical harm §9 is naming when it says closing an account must
-- not make payments unmanageable. The money moved. Nothing about somebody
-- leaving makes it not have moved.
--
-- Attendance is the same shape for the same reason: historical attendance
-- totals should not silently drop. Nulls do not collide in a unique index, so
-- the `(event_id, profile_id)` guarantee on event_attendance is unaffected —
-- several erased attendees can sit in one event without fighting over it.
--
-- What deliberately still cascades:
--
--   event_tickets         a ticket belonging to nobody admits nobody
--   event_registrations   a place held by nobody should go back in the pool
--
-- Those are litter, not history. The fact that the ticket was bought survives
-- in the order.
--
--   peer_feedback         feedback *about* an erased person is personal data
--   event_feedback        about them and should leave with them; feedback *by*
--   feedback_subjects     them is bound to a subject who never agreed to it
--                         outliving its author. Neither is an "outstanding
--                         booking, payment or refund", which is what §9's
--                         sentence actually names, so cascading stays the
--                         default and changing it would be a product decision
--                         taken quietly in a migration.
--
--   event_message_recipients  a queued email to somebody who has left should
--                             not be sent.
--
-- One residue worth naming rather than discovering: event_feedback.host_ids is
-- a plain uuid[] with no foreign key, so an erased host's id stays in it. It
-- resolves to no row, identifies nobody, and removing it would mean rewriting
-- what an answer was given about. It is left alone on purpose.
--
-- Dropping NOT NULL and changing a foreign key's delete action rewrites no
-- data and moves no row, so this stays inside the additive-only rule. The
-- re-added constraints revalidate rows that already satisfy them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. event_orders — keep the payment, drop the payer
--
-- Everything that answers "what happened to this money" stays on the row:
-- amount_cents, currency, status, stripe_account_id, stripe_payment_intent_id,
-- stripe_checkout_session_id, paid_at. event_refunds rides on order_id, so a
-- refund survives with its order and needs nothing of its own here.
--
-- The select policies need no change and are correct as they stand:
-- `profile_id = auth.uid()` never matches null, so an orphaned order is
-- readable by the event's hosts and by an admin, and by nobody else.
-- ---------------------------------------------------------------------------

alter table public.event_orders
  alter column profile_id drop not null;

alter table public.event_orders
  drop constraint if exists event_orders_profile_id_fkey;

alter table public.event_orders
  add constraint event_orders_profile_id_fkey
  foreign key (profile_id) references public.profiles (id) on delete set null;

comment on column public.event_orders.profile_id is
  '§9, ORG-13. Null once that account has been closed. The payment record outlives the payer, so an event''s reported sales cannot change retroactively because somebody left.';

-- ---------------------------------------------------------------------------
-- 2. event_attendance — keep the arrival, drop the arriver
--
-- event_participants joins profiles to put a name to a row, so an orphaned
-- attendance falls out of that view — correctly, since there is no name left
-- to show. The count at the door reads event_attendance directly and keeps it,
-- which is the number this change exists to protect.
-- ---------------------------------------------------------------------------

alter table public.event_attendance
  alter column profile_id drop not null;

alter table public.event_attendance
  drop constraint if exists event_attendance_profile_id_fkey;

alter table public.event_attendance
  add constraint event_attendance_profile_id_fkey
  foreign key (profile_id) references public.profiles (id) on delete set null;

comment on column public.event_attendance.profile_id is
  '§9. Null once that account has been closed. Somebody was in the room; that stays true after they leave the platform.';
