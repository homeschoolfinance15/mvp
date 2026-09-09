-- ---------------------------------------------------------------------------
-- Who a code was emailed to
--
-- A connector who sends five invitations in a week has, until now, no way to
-- tell which code went to whom: the dashboard lists five identical-looking
-- codes. These two columns are written by the invite-email function after the
-- mail provider accepts the message, so they record what was actually sent,
-- not what somebody typed into a box.
--
-- ponytail: one address per code, the most recent send. A code with
-- max_uses > 1 mailed to several people keeps only the last. Give it its own
-- invite_sends table if multi-use codes start being mailed around in earnest.
--
-- Written only by the edge function, under the service role, so no policy
-- change is needed: nothing else may update this table, and the existing
-- select policy (your own codes, or everything if admin) already covers who
-- gets to read the columns.
-- ---------------------------------------------------------------------------

alter table public.invite_codes
  add column if not exists sent_to text,
  add column if not exists sent_at timestamptz;

comment on column public.invite_codes.sent_to is
  'The address the invite-email function last mailed this code to. Null if it was only ever copied out by hand.';

comment on column public.invite_codes.sent_at is
  'When invite-email last mailed this code. Set together with sent_to.';
