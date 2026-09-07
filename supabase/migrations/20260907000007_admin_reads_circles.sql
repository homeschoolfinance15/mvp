-- ============================================================================
-- Administrators can read the circles
--
-- The circle chat migration deliberately withheld this and said so: an admin
-- belongs to no circle, this repo already limits what an admin sees, and
-- opening a group conversation to an operator is a decision somebody should
-- make on purpose rather than inherit by default.
--
-- That decision has now been made. An administrator can read every circle,
-- so the network has one place where its structure and its conversations are
-- visible to whoever runs it.
--
-- Note what does NOT change:
--   · admins still cannot WRITE into a circle they are not part of; the
--     insert policy still requires connector_id = my_circle_id(), which is
--     null for an admin. Reading a room is not the same as speaking in it.
--   · the audit trigger still skips the message body, so the log does not
--     become a second copy of every conversation.
--   · members and connectors see exactly what they saw before.
-- ============================================================================

drop policy circle_messages_select on public.circle_messages;

create policy circle_messages_select on public.circle_messages for select to authenticated
using (
  connector_id = public.my_circle_id()
  or public.is_admin()
);

comment on table public.circle_messages is
  'One connector''s room: the connector and everyone they invited. Readable by that circle and by administrators; writable only from inside.';
