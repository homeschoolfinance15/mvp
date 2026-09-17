-- ============================================================================
-- The event platform stops being a photograph
--
-- `circle_messages` and `notifications` have been in the realtime publication
-- since 20260907000005 and ...013. Nothing in the event platform was, so every
-- list it added was accurate at the moment it loaded and drifting afterwards:
-- a host watching people register saw nothing until they refreshed, two
-- stewards on a door could not see each other's scans, and the administrator's
-- sidebar went on saying "Waitlist 35" however many of those people had just
-- been let in.
--
-- What a subscriber receives is still decided by the same row-level policies
-- that decide what they could fetch — realtime applies them per subscriber, so
-- adding a table here grants nobody anything. And `useLive` never reads the
-- pushed row anyway: a change means "ask again", and the asking goes through
-- the ordinary query. Publishing a table widens what a screen can *notice*,
-- never what it can see.
--
-- Deliberately NOT published:
--
--   peer_feedback / event_feedback / feedback_subjects
--     FDB-09 and FDB-12 make submitted feedback admin-only, and a live signal
--     is itself information: an attendee watching their own screen update the
--     instant somebody reviewed them learns who is writing about them and
--     when. The admin feedback view reloads when opened, which is enough for
--     a record nobody is waiting on in real time.
--
--   activity_log
--     Append-only and high volume. Every write in the product lands in it, so
--     subscribing would mean a refetch on essentially every action anywhere.
--     The log is a thing you go and read, not a thing you watch.
--
-- `profiles` IS published, having nearly been left out on the assumption that
-- a row every session holds must churn. It does not: there is no last-seen
-- stamp, no activity column, and no code path that writes one outside a
-- deliberate profile edit or a status change by an administrator. Those are
-- exactly the changes the Members count and the member lists exist to show, so
-- the assumption would have cost the feature for no saving at all.
--
-- ponytail: one loop, and `add table` throws when the table is already there,
-- so each is tried in its own block. Migrations get re-applied; a publication
-- list is not a thing to hand-maintain twice.
-- ============================================================================

do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication is absent; live updates are off on this project.';
    return;
  end if;

  foreach v_table in array array[
    -- Status, capacity and details. Drives sold-out and the public page.
    'events',
    'ticket_types',
    -- The guest list, and what capacity is counted from.
    'event_registrations',
    'event_orders',
    'event_tickets',
    'event_refunds',
    -- The door. Two phones scanning the same room have to agree.
    'event_attendance',
    -- Invitations, and whether they turned into registrations.
    'event_invites',
    -- Message history and delivery problems (EML-08).
    'event_messages',
    'event_message_recipients',
    -- The administrator's sidebar counts and member lists.
    'profiles',
    'connectors',
    'connector_notes',
    'waitlist_entries',
    'connector_user_links',
    'invite_codes'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    exception
      when duplicate_object then
        -- Already published. Nothing to do and not a fault.
        null;
      when undefined_table then
        raise notice 'realtime: % does not exist on this project, skipped.', v_table;
    end;
  end loop;
end
$$;
