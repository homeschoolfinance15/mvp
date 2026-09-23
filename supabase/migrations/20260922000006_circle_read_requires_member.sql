-- ============================================================================
-- Reading a circle requires being a member (NET-4)
--
-- circle_messages_select checked only connector_id = my_circle_id(), so a
-- suspended or removed member kept reading their circle while the insert was
-- refused. The admin Members screen promises "they lose both reading and
-- writing"; posts already gate on is_member(). Connectors are network members
-- (network_member = true), so they keep reading their own circle. Admins are
-- unchanged.
-- ============================================================================

drop policy if exists circle_messages_select on public.circle_messages;

create policy circle_messages_select on public.circle_messages for select to authenticated
using (
  (connector_id = public.my_circle_id() and public.is_member())
  or public.is_admin()
);
