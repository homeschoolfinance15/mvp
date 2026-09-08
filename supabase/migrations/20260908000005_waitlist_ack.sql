-- ============================================================================
-- "We got your application"
--
-- Somebody applied at the door and heard nothing back, so a typo in their own
-- email address was invisible to them and to us until an admin tried to make
-- contact weeks later.
--
-- This column is the idempotency guard for that email. The edge function
-- claims a row by stamping it, so the same applicant cannot be mailed twice
-- however many times the endpoint is called, and an address that never
-- applied cannot be mailed at all.
-- ============================================================================

alter table public.waitlist_entries add column ack_sent_at timestamptz;

comment on column public.waitlist_entries.ack_sent_at is
  'When the "we got your application" email went out. Also the guard that stops it going out twice.';
