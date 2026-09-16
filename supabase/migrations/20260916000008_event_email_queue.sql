-- ============================================================================
-- The email queue
--
-- event_messages and event_message_recipients are a queue, not a log written
-- after the fact. Nothing in this system sends an email and then records that
-- it did. Everything is scheduled into these two tables first, and exactly one
-- dispatcher takes rows out of them.
--
-- The difference matters more than it sounds. A log written after sending
-- cannot tell you what is about to go out, cannot be cancelled, cannot be
-- rescheduled when the event moves, and cannot be retried without risking a
-- second copy. A queue can do all four, and EML-06 and EML-08 both need it to.
--
-- Two rules are enforced here rather than left to the dispatcher:
--
-- EML-06, moving an event. Change starts_at and every unsent reminder moves
-- with it. A reminder whose new moment is already in the past is marked
-- 'skipped' and never sent — "your event starts in an hour" arriving after
-- the event is worse than silence, because it is confidently wrong. Moving
-- ends_at moves the unsent feedback_open message the same way.
--
-- EML-06 again, duplicate copies. unique (message_id, profile_id). One person
-- gets one copy of one message, and a retry of a partially-failed send cannot
-- give somebody who already received it a second one.
--
-- ORG-10 and EML-03 are why there is no trigger that emails attendees when an
-- event is edited. Saving an event and telling people about it are two
-- outcomes with two labels, and a host who fixes a typo in the description
-- has not decided to email two hundred people. queue_event_message() is the
-- deliberate act; nothing calls it on the host's behalf.
--
-- FDB-03 and EML-09: no function in this file can reach peer_feedback or
-- event_feedback, and the dispatcher must not either. Submitted feedback
-- never leaves the database in an email.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. event_email_settings — EML-02
--
-- One row per event, created with the event. A host who wants no automatic
-- reminders at all turns them off here rather than deleting every reminder
-- row, so their schedule survives being switched back on.
-- ---------------------------------------------------------------------------

create table public.event_email_settings (
  event_id          uuid primary key references public.events (id) on delete cascade,
  reminders_enabled boolean not null default true,
  updated_by        uuid references public.profiles (id) on delete set null,
  updated_at        timestamptz not null default now()
);

comment on table public.event_email_settings is
  'EML-02. Per-event email preferences. One row per event, created with it.';

-- ---------------------------------------------------------------------------
-- 2. event_reminders
--
-- What the host wants sent and how long before. Separate from the messages
-- themselves because a reminder is a standing intention and a message is one
-- attempt to act on it: the intention survives the event moving, the message
-- does not.
-- ---------------------------------------------------------------------------

create table public.event_reminders (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events (id) on delete cascade,
  minutes_before int not null,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),

  constraint event_reminders_window_sane check (minutes_before between 1 and 43200)
);

create unique index event_reminders_once_idx
  on public.event_reminders (event_id, minutes_before);

comment on table public.event_reminders is
  'EML-02. A standing intention to remind attendees N minutes before the event. Survives the event being rescheduled; the messages it produces do not.';

-- ---------------------------------------------------------------------------
-- 3. event_messages
--
-- One row per thing to say to an audience. scheduled_for is when it becomes
-- due; the dispatcher claims rows whose moment has come and whose status is
-- still 'scheduled'.
--
-- changed_details is {column: {from, to}} — the same shape log_activity()
-- writes — so EML-04 can name what actually changed rather than sending "some
-- details have been updated", which tells a reader nothing and makes them
-- open the page to diff it themselves.
-- ---------------------------------------------------------------------------

create table public.event_messages (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events (id) on delete cascade,
  kind            text not null,
  reminder_id     uuid references public.event_reminders (id) on delete set null,
  scheduled_for   timestamptz,
  status          message_status not null default 'scheduled',
  subject         text,
  body            text,
  changed_details jsonb,
  audience_count  int,
  triggered_by    uuid references public.profiles (id) on delete set null,
  sent_at         timestamptz,
  error           text,
  created_at      timestamptz not null default now(),

  constraint event_messages_kind_known check (kind in (
    'confirmation', 'payment', 'reminder', 'invite', 'update',
    'cancelled', 'attendee_cancelled', 'refund', 'feedback_open'
  ))
);

-- The dispatcher's index: due, still scheduled, oldest first.
create index event_messages_due_idx
  on public.event_messages (scheduled_for)
  where status = 'scheduled';

create index event_messages_event_idx on public.event_messages (event_id, created_at desc);

-- EML-06. At most one live reminder message per reminder per event. Without
-- it, rescheduling an event twice in a minute leaves two scheduled copies and
-- everybody gets reminded twice.
create unique index event_messages_live_reminder_idx
  on public.event_messages (event_id, reminder_id)
  where reminder_id is not null and status = 'scheduled';

-- The same, for the one automatic message that is not a reminder.
create unique index event_messages_live_feedback_idx
  on public.event_messages (event_id)
  where kind = 'feedback_open' and status = 'scheduled';

comment on table public.event_messages is
  'EML-08. The send queue. Everything is scheduled here first and one dispatcher takes rows out — nothing sends an email and records it afterwards.';
comment on column public.event_messages.changed_details is
  'EML-04. {column: {from, to}}, so the email can name what changed instead of saying that something did.';
comment on column public.event_messages.status is
  'skipped is a message whose moment passed before the dispatcher reached it. EML-06: a late reminder is worse than no reminder.';

-- ---------------------------------------------------------------------------
-- 4. event_message_recipients
--
-- Written by the dispatcher at send time, one row per person, each with its
-- own status. EML-05: one Resend message per person, so nobody ever sees who
-- else was on the list.
--
-- EML-08's retry rule falls out of the shape: a retry updates rows with
-- status 'failed' and the unique index refuses to add a second row for
-- somebody who already has one.
-- ---------------------------------------------------------------------------

create table public.event_message_recipients (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.event_messages (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  email      text not null,
  status     message_status not null default 'queued',
  error      text,
  sent_at    timestamptz
);

create unique index event_message_recipients_once_idx
  on public.event_message_recipients (message_id, profile_id);

create index event_message_recipients_retry_idx
  on public.event_message_recipients (message_id)
  where status = 'failed';

comment on table public.event_message_recipients is
  'EML-05/06/08. One row per person per message. The unique index is what makes a retry safe: nobody receives a second copy.';

-- ---------------------------------------------------------------------------
-- 5. Every event gets settings and a default schedule
--
-- EML-11. Seven days before and one day before, reminders on, which is what
-- somebody would have set by hand. A host who wants neither switches reminders
-- off; a host who wants different ones edits the rows.
--
-- Only offsets that are still in the future are seeded. An event created three
-- days out gets the one-day reminder and not the seven-day one, and an event
-- created tomorrow gets neither. The dispatcher would handle it correctly
-- either way — schedule_event_messages() marks a reminder whose moment has
-- passed as 'skipped' rather than firing it late (EML-06) — but that puts a
-- 'skipped' row in the organiser's status list on day one, sitting beside
-- 'failed', explaining nothing. Better not to create the row.
--
-- A host who deliberately adds a seven-day reminder to a short-notice event
-- still gets the skipped row, and there it is genuinely informative: they
-- asked for something that cannot happen.
-- ---------------------------------------------------------------------------

create or replace function public.seed_event_email_defaults()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.event_email_settings (event_id, updated_by)
  values (new.id, auth.uid())
  on conflict (event_id) do nothing;

  insert into public.event_reminders (event_id, minutes_before)
  select new.id, m
  from unnest(array[10080, 1440]) as m
  where new.starts_at - make_interval(mins => m) > now()
  on conflict (event_id, minutes_before) do nothing;

  return null;
end;
$$;

comment on function public.seed_event_email_defaults() is
  'EML-11. Gives a new event its settings row and the default reminders — seven days and one day before — skipping any offset that is already in the past.';

create trigger trg_seed_event_email_defaults
  after insert on public.events
  for each row execute function public.seed_event_email_defaults();

-- The events that already exist never fired that trigger. Settings only: a
-- reminder row for an event that happened last month would be scheduled into
-- the past on its first edit, and skipped — noise for no benefit.
insert into public.event_email_settings (event_id)
select id from public.events
on conflict (event_id) do nothing;

-- ---------------------------------------------------------------------------
-- 6. schedule_event_messages — EML-06, the whole of it
--
-- Recomputes every automatic message for one event: the reminders, and the
-- one that opens feedback. Called whenever anything it depends on moves —
-- the event's times, its publication state, or its reminder rows.
--
-- Three things happen, in this order, and the order is the requirement:
--
--   1. A message whose moment has passed is marked 'skipped'. Not sent late,
--      not silently deleted — skipped, visibly, so somebody looking at the
--      queue can see that a reminder was due at a time that no longer exists.
--   2. A message still in the future is moved to its new moment.
--   3. A reminder with no live message gets one, if its moment is still ahead.
--
-- A draft or cancelled event schedules nothing. Nothing is scheduled for an
-- event nobody can register for.
--
-- ponytail: recomputes all of one event's messages on any change. That is a
-- handful of rows per event and it runs on an edit, not in a loop. Make it
-- incremental if an event ever has hundreds of reminders, which it will not.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_event_messages(p_event uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_event    public.events%rowtype;
  v_enabled  boolean;
  v_reminder record;
  v_due      timestamptz;
begin
  select * into v_event from public.events where id = p_event;
  if not found then
    return;
  end if;

  select coalesce(reminders_enabled, true) into v_enabled
  from public.event_email_settings where event_id = p_event;
  v_enabled := coalesce(v_enabled, true);

  -- An event that is not published has no audience worth scheduling for, and
  -- a cancelled one has had its own message instead.
  if v_event.status <> 'published' then
    update public.event_messages
    set status = 'cancelled'
    where event_id = p_event
      and status = 'scheduled'
      and kind in ('reminder', 'feedback_open');
    return;
  end if;

  -- Reminders.
  for v_reminder in
    select r.* from public.event_reminders r where r.event_id = p_event
  loop
    v_due := v_event.starts_at - make_interval(mins => v_reminder.minutes_before);

    if not (v_reminder.enabled and v_enabled) then
      update public.event_messages
      set status = 'cancelled'
      where event_id = p_event and reminder_id = v_reminder.id and status = 'scheduled';
      continue;
    end if;

    if v_due <= now() then
      -- EML-06. Its moment is gone. Mark the existing one skipped and do not
      -- create a replacement that would go out immediately and be wrong.
      update public.event_messages
      set status = 'skipped'
      where event_id = p_event and reminder_id = v_reminder.id and status = 'scheduled';
      continue;
    end if;

    update public.event_messages
    set scheduled_for = v_due
    where event_id = p_event and reminder_id = v_reminder.id and status = 'scheduled';

    if not found then
      insert into public.event_messages (event_id, kind, reminder_id, scheduled_for)
      values (p_event, 'reminder', v_reminder.id, v_due)
      on conflict do nothing;
    end if;
  end loop;

  -- FDB-15. The message that tells people feedback is open.
  v_due := coalesce(v_event.ends_at, v_event.starts_at)
           + make_interval(mins => v_event.feedback_opens_after_minutes);

  if v_due <= now() then
    update public.event_messages
    set status = 'skipped'
    where event_id = p_event and kind = 'feedback_open' and status = 'scheduled';
  else
    update public.event_messages
    set scheduled_for = v_due
    where event_id = p_event and kind = 'feedback_open' and status = 'scheduled';

    if not found then
      insert into public.event_messages (event_id, kind, scheduled_for)
      values (p_event, 'feedback_open', v_due)
      on conflict do nothing;
    end if;
  end if;
end;
$$;

comment on function public.schedule_event_messages(uuid) is
  'EML-06. Recomputes an event''s reminder and feedback_open messages. A message whose moment has passed is skipped, never sent late.';

-- ---------------------------------------------------------------------------
-- 7. What makes the schedule move
--
-- The event's times, its status, and its feedback delay. Not its title, not
-- its description — a reworded event is still at the same hour, and there is
-- no reason to touch the queue.
--
-- Cancelling is the one case that also produces a message rather than only
-- moving them: the people who were coming have to be told, and every pending
-- reminder for an event that is not happening is cancelled in the same breath.
-- ---------------------------------------------------------------------------

-- OLD is an unassigned record on INSERT, and reading a field of one raises.
-- `tg_op = 'INSERT' or old.status is distinct from ...` usually survives that
-- on short-circuit evaluation, but PostgreSQL does not guarantee the
-- evaluation order of AND and OR — the planner is free to reorder them. A
-- trigger that works until the day it is re-planned is not worth the two
-- saved lines, so the operations are separated before either reads a row.
create or replace function public.reschedule_event_messages()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_attendee uuid;
begin
  if tg_op = 'INSERT' then
    perform public.schedule_event_messages(new.id);
    return null;
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    -- ORG-09, EML-03. Nothing else is going out about this event.
    update public.event_messages
    set status = 'cancelled'
    where event_id = new.id and status = 'scheduled';

    insert into public.event_messages (event_id, kind, scheduled_for, triggered_by)
    values (new.id, 'cancelled', now(), auth.uid());

    -- And in the bell as well as the inbox, for anybody holding a place.
    for v_attendee in
      select distinct r.profile_id
      from public.event_registrations r
      where r.event_id = new.id and r.status in ('pending', 'confirmed')
    loop
      insert into public.notifications (profile_id, kind, actor_id, event_id)
      values (v_attendee, 'event_cancelled', auth.uid(), new.id);
    end loop;

    return null;
  end if;

  if new.starts_at is distinct from old.starts_at
     or new.ends_at is distinct from old.ends_at
     or new.status  is distinct from old.status
     or new.feedback_opens_after_minutes is distinct from old.feedback_opens_after_minutes
  then
    perform public.schedule_event_messages(new.id);
  end if;

  return null;
end;
$$;

comment on function public.reschedule_event_messages() is
  'EML-06. Moves an event''s unsent messages when the event moves, and cancels the lot when the event is called off.';

-- Trigger order on events is alphabetical, so this one runs before the seed
-- and finds no reminder rows on an insert. That is fine and is why
-- trg_reschedule_on_reminder_change exists: the seed's own inserts schedule
-- what they need. A draft schedules nothing in any case.
create trigger trg_reschedule_event_messages
  after insert or update on public.events
  for each row execute function public.reschedule_event_messages();

-- NEW is an unassigned record on DELETE, and coalesce() does not save you.
-- coalesce stops at its first non-null argument, but new.event_id *is* the
-- first argument, so a delete reads it and raises before old is ever reached.
-- Unlike the OR above, this one fails every time rather than depending on the
-- plan. tg_op is the only thing safe to read on both operations.
create or replace function public.reschedule_on_reminder_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.schedule_event_messages(old.event_id);
  else
    perform public.schedule_event_messages(new.event_id);
  end if;
  return null;
end;
$$;

create trigger trg_reschedule_on_reminder_change
  after insert or update or delete on public.event_reminders
  for each row execute function public.reschedule_on_reminder_change();

create trigger trg_reschedule_on_settings_change
  after update on public.event_email_settings
  for each row execute function public.reschedule_on_reminder_change();

-- ---------------------------------------------------------------------------
-- 8. queue_event_message — ORG-10, the deliberate act
--
-- A host pressing "notify attendees". Nothing calls this automatically, which
-- is the point: EML-03 and ORG-10 both insist that saving an event and
-- emailing everybody about it are two decisions, and only one of them is made
-- by clicking Save.
--
-- The caller supplies changed_details because the organiser screen is what
-- knows which fields the host actually touched in this sitting. The database
-- knows every change ever made; it does not know which ones this email is
-- about.
-- ---------------------------------------------------------------------------

create or replace function public.queue_event_message(
  p_event         uuid,
  p_kind          text,
  p_subject       text default null,
  p_body          text default null,
  p_changed       jsonb default null,
  p_scheduled_for timestamptz default now()
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_id      uuid;
  v_person  uuid;
begin
  if v_me is null or not (public.hosts_event(p_event) or public.is_admin()) then
    raise exception 'You are not running this event.';
  end if;
  if p_kind not in ('update', 'reminder', 'invite', 'cancelled', 'feedback_open') then
    raise exception 'That is not a message a host sends.';
  end if;

  insert into public.event_messages
    (event_id, kind, scheduled_for, subject, body, changed_details, triggered_by)
  values
    (p_event, p_kind, coalesce(p_scheduled_for, now()),
     nullif(btrim(coalesce(p_subject, '')), ''),
     nullif(btrim(coalesce(p_body, '')), ''),
     p_changed, v_me)
  returning id into v_id;

  -- EML-04. The bell says the same thing the inbox will, so somebody who
  -- reads one does not need the other.
  if p_kind = 'update' then
    for v_person in
      select distinct r.profile_id
      from public.event_registrations r
      where r.event_id = p_event and r.status in ('pending', 'confirmed')
    loop
      insert into public.notifications (profile_id, kind, actor_id, event_id)
      values (v_person, 'event_updated', v_me, p_event);
    end loop;
  end if;

  return v_id;
end;
$$;

comment on function public.queue_event_message(uuid, text, text, text, jsonb, timestamptz) is
  'ORG-10, EML-03/04. Queues a message a host has decided to send. Never called on a host''s behalf — saving an event does not email anybody.';

-- ---------------------------------------------------------------------------
-- 9. event_message_audience — EML-07
--
-- Who should receive a message, asked at send time rather than at schedule
-- time. This is the requirement: a recipient list built when a reminder was
-- scheduled a week ago would still be emailing people who cancelled on
-- Tuesday.
--
-- It lives in the database rather than in the dispatcher so that there is one
-- definition of "is this person still coming", and so the edge function
-- cannot drift away from it by accident.
--
-- ponytail: every kind that goes to attendees uses the same audience — people
-- holding a live place. Split it when a kind genuinely needs a different list.
-- ---------------------------------------------------------------------------

create or replace function public.event_message_audience(p_message uuid)
returns table (profile_id uuid, email text)
language sql stable security definer set search_path = public
as $$
  select distinct p.id, p.email::text
  from public.event_messages m
  join public.event_registrations r
    on r.event_id = m.event_id
   and r.status in ('pending', 'confirmed')
  join public.profiles p
    on p.id = r.profile_id
   and p.profile_status not in ('suspended', 'removed')
  where m.id = p_message
    and p.email is not null
    -- A message about an event nobody can see any more goes nowhere.
    and exists (select 1 from public.events e where e.id = m.event_id);
$$;

comment on function public.event_message_audience(uuid) is
  'EML-07. Who is eligible for that message right now. Asked by the dispatcher at send time, never baked in when the message was scheduled.';

-- ---------------------------------------------------------------------------
-- 10. Row level security
--
-- A host reads and edits their own event's settings, reminders and queue.
-- Attendees read none of it: the queue names who is being emailed and how
-- many of them there are, which is information about other people.
--
-- event_messages and event_message_recipients have no write policy for
-- anybody. The dispatcher writes them on the service role, and hosts queue a
-- message through queue_event_message(), which checks who is asking. A host
-- who could UPDATE event_messages directly could rewrite the body of a
-- message after it had been claimed for sending.
-- ---------------------------------------------------------------------------

alter table public.event_email_settings      enable row level security;
alter table public.event_reminders           enable row level security;
alter table public.event_messages            enable row level security;
alter table public.event_message_recipients  enable row level security;

create policy event_email_settings_select on public.event_email_settings for select to authenticated
using (public.hosts_event(event_id) or public.is_admin());

create policy event_email_settings_update on public.event_email_settings for update to authenticated
using (public.hosts_event(event_id) or public.is_admin())
with check (public.hosts_event(event_id) or public.is_admin());

create policy event_reminders_select on public.event_reminders for select to authenticated
using (public.hosts_event(event_id) or public.is_admin());

create policy event_reminders_insert on public.event_reminders for insert to authenticated
with check (public.hosts_event(event_id) or public.is_admin());

create policy event_reminders_update on public.event_reminders for update to authenticated
using (public.hosts_event(event_id) or public.is_admin())
with check (public.hosts_event(event_id) or public.is_admin());

create policy event_reminders_delete on public.event_reminders for delete to authenticated
using (public.hosts_event(event_id) or public.is_admin());

create policy event_messages_select on public.event_messages for select to authenticated
using (public.hosts_event(event_id) or public.is_admin());

create policy event_message_recipients_select on public.event_message_recipients for select to authenticated
using (
  exists (
    select 1 from public.event_messages m
    where m.id = public.event_message_recipients.message_id
      and (public.hosts_event(m.event_id) or public.is_admin())
  )
);

-- ---------------------------------------------------------------------------
-- 11. Audit
--
-- The body and subject of a message are skipped: they are long free text that
-- already has a home two columns away, and an email body copied into the
-- audit trail is a second copy of something written to a specific audience.
-- ---------------------------------------------------------------------------

create trigger log_event_email_settings
  after insert or update or delete on public.event_email_settings
  for each row execute function public.log_activity();

create trigger log_event_reminders
  after insert or update or delete on public.event_reminders
  for each row execute function public.log_activity();

create trigger log_event_messages
  after insert or update or delete on public.event_messages
  for each row execute function public.log_activity('body', 'subject');

-- ---------------------------------------------------------------------------
-- 12. The dispatcher's clock
--
-- pg_cron every minute, calling the event-mailer function over pg_net. Both
-- extensions are available on Supabase's hosted plans and on neither a local
-- `supabase start` nor a free project, so the whole thing is wrapped: a
-- project without them logs a notice and migrates cleanly, and the GitHub
-- Actions schedule in the repo is the fallback trigger.
--
-- Whichever one is live, the dispatcher is the same function and claiming a
-- row is what makes it safe to have both pointed at it at once.
--
-- The service role key is read from a database setting rather than written
-- here, because a migration file is in git and a key in git is a key that has
-- been published. Set it once, out of band:
--
--   alter database postgres set app.settings.service_role_key = '...';
--   alter database postgres set app.settings.functions_url = 'https://<ref>.supabase.co/functions/v1';
--
-- ponytail: the job is unscheduled and rescheduled on every migration run, so
-- this file is safe to re-apply. If the settings are absent the job is not
-- created at all and Actions carries the load.
-- ---------------------------------------------------------------------------

do $$
declare
  v_url  text := current_setting('app.settings.functions_url', true);
  v_key  text := current_setting('app.settings.service_role_key', true);
  v_http text;
begin
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    raise notice 'event-mailer cron not scheduled: app.settings.functions_url / service_role_key are not set. The GitHub Actions schedule is the trigger.';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  -- pg_net has lived in `net` and in `extensions` depending on how a project
  -- was created, and a cron job that names the wrong one fails once a minute
  -- into cron.job_run_details where nobody is looking. Ask the catalogue
  -- instead of guessing.
  select quote_ident(n.nspname) || '.http_post'
    into v_http
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.proname = 'http_post'
  limit 1;

  if v_http is null then
    raise notice 'event-mailer cron not scheduled: pg_net exposes no http_post on this project.';
    return;
  end if;

  -- Unschedule in a block of its own. There is nothing to remove on a first
  -- run, and letting that error reach the outer handler would roll back the
  -- extensions this block has just created.
  begin
    perform cron.unschedule('event-mailer');
  exception when others then
    null;
  end;

  perform cron.schedule(
    'event-mailer',
    '* * * * *',
    format(
      $job$select %s(
        url     := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', %L
        ),
        body    := '{}'::jsonb
      )$job$,
      v_http,
      v_url || '/event-mailer',
      'Bearer ' || v_key
    )
  );

  raise notice 'event-mailer cron scheduled, every minute, via %.', v_http;

exception when others then
  -- The extensions are unavailable on this plan, or this role may not create
  -- them. Neither is a reason to fail a deployment: Actions carries the load.
  raise notice 'event-mailer cron setup skipped (%): the GitHub Actions schedule is the trigger.', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Grants
-- ---------------------------------------------------------------------------

grant select, update         on public.event_email_settings     to authenticated;
grant select, insert, update, delete on public.event_reminders  to authenticated;
grant select                 on public.event_messages           to authenticated;
grant select                 on public.event_message_recipients to authenticated;

grant execute on function public.queue_event_message(uuid, text, text, text, jsonb, timestamptz)
  to authenticated;
-- Deliberately not granted to authenticated: the audience of a message is a
-- list of who is coming and their email addresses. Only the dispatcher asks.
grant execute on function public.event_message_audience(uuid)   to service_role;
grant execute on function public.schedule_event_messages(uuid)  to service_role;
