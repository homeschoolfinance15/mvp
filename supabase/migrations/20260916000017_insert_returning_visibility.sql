-- ============================================================================
-- A connector could not create an event, and the reason is RETURNING
--
-- ORG-01B, broken for every connector and working perfectly for every admin,
-- which is the asymmetry that makes it worth writing down properly.
--
-- Postgres applies SELECT policies to the row produced by INSERT ... RETURNING.
-- PostgREST always uses RETURNING — supabase-js `.insert().select()` sends
-- `Prefer: return=representation` — so every insert from the application is the
-- returning form, and a table whose select policy cannot see the row that was
-- just written refuses the whole statement with 42501. The insert itself was
-- never the problem: events_insert's WITH CHECK passed every time.
--
-- events_select could admit a brand-new row through exactly one clause, since
-- a new event is a draft:
--
--     or public.hosts_event(id)
--
-- hosts_event() is STABLE and reads public.events. Called from inside the
-- statement that is inserting into public.events, it sees the snapshot from
-- before the row existed, finds nothing, and returns false. Every other clause
-- is false too — draft, not cancelled, no booking — so the row is invisible to
-- its own author for the length of one statement, and Postgres raises.
--
-- An admin never noticed because is_admin() answers from profiles and never
-- looks at the new row at all.
--
-- The fix is to ask the row, not the table. `host_id = auth.uid()` is
-- evaluated against the row being returned, so there is no snapshot to be on
-- the wrong side of. It is not a widening by any amount: events_insert already
-- requires `host_id = auth.uid()`, and hosts_event() already grants the
-- creator precisely this — through a route that happens not to work mid-insert.
-- For anon, auth.uid() is null and `host_id = null` is null, so nothing opens.
--
-- hosts_event(id) stays, because it is what covers cohosts.
--
-- The general shape, for whoever hits this next: a SELECT policy on table X
-- that calls a function which reads table X cannot see a row being inserted
-- into X. The cure is a clause on one of the row's own columns. Section 2
-- records the audit of every other table in this schema for the same shape.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The fix
-- ---------------------------------------------------------------------------

drop policy events_select on public.events;
create policy events_select on public.events for select to anon, authenticated
using (
  status in ('published', 'cancelled')
  -- The row's own column, so this survives INSERT ... RETURNING. Read the
  -- header before removing it as a duplicate of hosts_event(id): it is not one.
  or host_id = auth.uid()
  or public.hosts_event(id)
  or public.is_admin()
  or public.has_event_booking(id)
);

-- ---------------------------------------------------------------------------
-- 2. Every other table, audited for the same shape
--
-- The dangerous pattern is specifically self-referential: a policy on X calling
-- a function that selects from X. events was the only one. Recorded here so the
-- next person does not have to re-derive it, and so that a new policy can be
-- checked against the list.
--
--   ticket_types          event_visible(event_id) reads events, not
--                         ticket_types, and the event already exists when a
--                         ticket type is inserted. Safe.
--   event_registrations   `profile_id = auth.uid()` is a row-own column and
--                         both the insert policy and register_free() write the
--                         caller's own id, so the first clause always fires.
--   event_attendance      insert is host-only; hosts_event(event_id) reads
--                         events and event_hosts, never event_attendance.
--   event_invites         same shape as attendance. Safe.
--   event_hosts           its select policy is is_member(), which reads
--                         profiles. Safe.
--   event_reminders       hosts_event(event_id) again. Safe.
--   event_email_settings  hosts_event(event_id) again. Safe.
--   event_orders          no insert policy for any user role; written by the
--                         webhook on the service role, which is outside RLS.
--   event_refunds         same, and its select reads event_orders.
--   event_tickets         same; written by a definer trigger.
--   event_messages        no insert policy; queue_event_message() is definer.
--
--   feedback_subjects     these three DO refuse INSERT ... RETURNING, and
--   peer_feedback         deliberately: select is is_admin() and nothing else
--   event_feedback        (FDB-09), so an author cannot read back what they
--                         just wrote. It is not the snapshot bug and it is not
--                         fixable without breaking the requirement — the client
--                         must send `Prefer: return=minimal` when writing
--                         feedback. scripts/check-events.mjs carries an
--                         insertMinimal() helper for exactly this.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3. A note that will save somebody an afternoon
--
-- protect_profile_fields() pins role, profile_status, id, created_at and
-- network_member for anybody who is not an admin — and the service role is not
-- an admin. is_admin() reads profiles for auth.uid(), and auth.uid() is null
-- when a request carries the service key, so a service-role PATCH of
-- profiles.role returns 200 and silently changes nothing.
--
-- That is correct: the service key is for machines, and a machine should not
-- be handing out roles as a side effect of a fixture script. Change a role
-- with SQL, or as a signed-in admin.
--
-- connectors.can_create_events is not pinned by anything and updates normally.
-- ---------------------------------------------------------------------------

comment on function public.protect_profile_fields() is
  'Pins id, role, profile_status, created_at and network_member for everyone except an admin. Note that the service role is NOT an admin — auth.uid() is null for it — so a service-role PATCH of role returns 200 and changes nothing. Use SQL, or a signed-in admin.';
