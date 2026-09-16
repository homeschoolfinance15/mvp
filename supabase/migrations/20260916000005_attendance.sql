-- ============================================================================
-- Attendance — who actually turned up
--
-- One row per person per event, and never more than one (ATT-03). A door is a
-- bad place to discover that somebody has been counted twice, and an attendance
-- record is the eligibility gate for feedback (FDB-06), so a duplicate is not
-- only untidy, it is a second set of feedback forms.
--
-- Two ways in, and the difference between them is preserved rather than
-- flattened:
--
--   'scan'    a real ticket code was presented at the door
--   'manual'  a host asserted afterwards that this person was there
--
-- ATT-06 is the reason they stay distinguishable. A correction is a correction:
-- we do not invent a scan that never happened, or an arrival time nobody
-- observed. `corrected` marks the assertion as one, and a manual row must name
-- somebody other than the attendee, so nobody checks themselves in.
--
-- check_in() returns a word rather than raising, because every one of the five
-- outcomes is an ordinary thing that happens at a door and each needs its own
-- sentence on screen (ATT-02). An exception would collapse them all into "that
-- did not work", in front of a queue.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. event_attendance
-- ---------------------------------------------------------------------------

create table public.event_attendance (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events (id)        on delete cascade,
  profile_id  uuid not null references public.profiles (id)      on delete cascade,
  method      text not null default 'scan',
  ticket_id   uuid references public.event_tickets (id)          on delete set null,
  recorded_by uuid references public.profiles (id)               on delete set null,
  recorded_at timestamptz not null default now(),
  corrected   boolean not null default false,
  reason      text,

  constraint event_attendance_once unique (event_id, profile_id),
  constraint event_attendance_method_known check (method in ('scan', 'manual')),

  -- ATT-06 says "a guest cannot mark themselves attended", and there is
  -- deliberately no `recorded_by <> profile_id` constraint enforcing it. The
  -- rule is about who is asking, not about which two columns match: FDB-06
  -- requires that a present host's attendance is recorded even though they
  -- bought no ticket, and a solo host has nobody else to record it. A check
  -- constraint cannot tell a host from a guest — it cannot read another table
  -- — so the rule lives in the insert policy and in mark_attended(), where
  -- hosts_event() can be asked. A guest is refused there, which is the actual
  -- requirement; a host recording their own presence is allowed, which is the
  -- other half of it.

  -- A correction is always the manual kind. Marking a scan as corrected would
  -- be claiming a scan happened and was then adjusted, which is a third story
  -- and not one anybody can support.
  constraint event_attendance_correction_is_manual
    check (not corrected or method = 'manual')
);

create index event_attendance_event_idx   on public.event_attendance (event_id);
create index event_attendance_profile_idx on public.event_attendance (profile_id);

comment on table public.event_attendance is
  'ATT-03. Who turned up, once per person per event. Scanned or asserted by a host, and the two stay distinguishable (ATT-06).';
comment on column public.event_attendance.corrected is
  'ATT-06. True when a host recorded attendance after the fact. Never a fabricated scan.';

-- ---------------------------------------------------------------------------
-- 2. attended_event — FDB-06
--
-- The eligibility gate for feedback, asked of somebody other than the caller,
-- because the feedback pages ask it about everyone who was in the room.
-- ---------------------------------------------------------------------------

create or replace function public.attended_event(p_event uuid, p_profile uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.event_attendance a
     where a.event_id = p_event and a.profile_id = p_profile
  );
$$;

comment on function public.attended_event(uuid, uuid) is
  'FDB-06. Whether that person is recorded as having attended that event. The one gate on giving and receiving feedback.';

-- ---------------------------------------------------------------------------
-- 3. check_in — ATT-02
--
-- The door. Hosts and admins only: the code alone must not be enough, or
-- anybody holding a ticket could mark themselves through by calling this with
-- their own code.
--
-- The order of the tests is the order a person at the door cares about. A
-- revoked or cancelled ticket is 'cancelled' rather than 'invalid', because
-- the two need very different conversations — one is "your booking was
-- cancelled, let me check what happened", the other is "this is not a ticket".
-- ---------------------------------------------------------------------------

create or replace function public.check_in(p_ticket_code text, p_event uuid)
returns check_in_result
language plpgsql security definer set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_ticket public.event_tickets%rowtype;
  v_reg    public.event_registrations%rowtype;
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;
  if not (public.hosts_event(p_event) or public.is_admin()) then
    raise exception 'Only a host can check people in.';
  end if;

  select * into v_ticket from public.event_tickets
   where code = btrim(lower(p_ticket_code));
  if not found then
    return 'invalid';
  end if;

  if v_ticket.event_id <> p_event then
    return 'wrong_event';
  end if;

  select * into v_reg from public.event_registrations where id = v_ticket.registration_id;
  if v_ticket.revoked_at is not null
     or v_reg.status is distinct from 'confirmed'
  then
    return 'cancelled';
  end if;

  if exists (select 1 from public.event_attendance a
              where a.event_id = p_event and a.profile_id = v_ticket.profile_id)
  then
    return 'already';
  end if;

  insert into public.event_attendance
    (event_id, profile_id, method, ticket_id, recorded_by)
  values
    (p_event, v_ticket.profile_id, 'scan', v_ticket.id, v_me);

  return 'ok';
end;
$$;

comment on function public.check_in(text, uuid) is
  'ATT-02. Scans a ticket at the door and answers ok | already | wrong_event | invalid | cancelled. Host or admin only.';

-- ---------------------------------------------------------------------------
-- 4. mark_attended — ATT-04, ATT-06
--
-- Somebody arrived without a working ticket, or the queue moved faster than
-- the scanner. A host says so, and the row says that is what happened.
--
-- Idempotent on the unique constraint: marking the same person twice is the
-- same outcome, and an error there would be a host being told off for
-- double-checking.
-- ---------------------------------------------------------------------------

create or replace function public.mark_attended(
  p_event   uuid,
  p_profile uuid,
  p_reason  text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;
  -- ATT-06's "a guest cannot mark themselves attended" is this one line. A
  -- guest is not a host of the event, so they never get past it, whoever they
  -- name. A host naming themselves does get past it, and must: FDB-06 counts
  -- present hosts as participants and requires their presence to be recorded,
  -- and a host running an event alone has nobody else to record it.
  if not (public.hosts_event(p_event) or public.is_admin()) then
    raise exception 'Only a host can record attendance.';
  end if;

  insert into public.event_attendance
    (event_id, profile_id, method, recorded_by, corrected, reason)
  values
    (p_event, p_profile, 'manual', v_me, true, nullif(btrim(coalesce(p_reason, '')), ''))
  on conflict (event_id, profile_id) do nothing;
end;
$$;

comment on function public.mark_attended(uuid, uuid, text) is
  'ATT-04. A host records that somebody was there without a scan. Always marked as a correction (ATT-06), never as a scan.';

-- ---------------------------------------------------------------------------
-- 5. Row level security
--
-- You may see that you attended; a host sees their own door.
--
-- The insert policy is where ATT-06 actually holds: only somebody running the
-- event may say who was there. A guest reaching the table directly is refused
-- whether they name themselves or anybody else, which is stronger than the
-- "not yourself" test it replaces — that one would have let a guest write an
-- attendance row for their friend.
-- ---------------------------------------------------------------------------

alter table public.event_attendance enable row level security;

create policy event_attendance_select on public.event_attendance for select to authenticated
using (profile_id = auth.uid() or public.hosts_event(event_id) or public.is_admin());

create policy event_attendance_insert on public.event_attendance for insert to authenticated
with check (public.hosts_event(event_id) or public.is_admin());

create policy event_attendance_update on public.event_attendance for update to authenticated
using (public.hosts_event(event_id) or public.is_admin())
with check (public.hosts_event(event_id) or public.is_admin());

create policy event_attendance_delete on public.event_attendance for delete to authenticated
using (public.hosts_event(event_id) or public.is_admin());

-- ---------------------------------------------------------------------------
-- 6. Audit and grants
-- ---------------------------------------------------------------------------

create trigger log_event_attendance
  after insert or update or delete on public.event_attendance
  for each row execute function public.log_activity('reason');

grant select, insert, update, delete on public.event_attendance to authenticated;

grant execute on function public.attended_event(uuid, uuid)     to authenticated;
grant execute on function public.check_in(text, uuid)           to authenticated;
grant execute on function public.mark_attended(uuid, uuid, text) to authenticated;
