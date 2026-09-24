-- ============================================================================
-- Reminders nobody asked for any more are not sent
--
--   Removing a reminder time nulls event_messages.reminder_id (on delete set
--   null), and schedule_event_messages() only walked the reminders that still
--   exist, so the orphaned message stayed 'scheduled' and went out anyway.
--   Switching reminders off had the same hole for any such orphan.
--
--   Redefines schedule_event_messages() (latest: 20260923000401) with one
--   extra cancel, and makes the first save of event_email_settings (an insert,
--   from the Emails page's upsert) reschedule as an update already did.
-- ============================================================================

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

  -- A reminder whose time was removed (the foreign key has nulled reminder_id
  -- by the time this runs), one pointing anywhere but this event's reminder
  -- times, and every reminder while reminders are switched off: none was
  -- asked for any more, and the loop below only reaches rows through
  -- event_reminders.
  update public.event_messages m
  set status = 'cancelled'
  where m.event_id = p_event
    and m.kind = 'reminder'
    and m.status = 'scheduled'
    and (
      not v_enabled
      or m.reminder_id is null
      or not exists (
        select 1 from public.event_reminders r
         where r.id = m.reminder_id and r.event_id = p_event
      )
    );

  -- Reminders.
  for v_reminder in
    select r.* from public.event_reminders r where r.event_id = p_event
  loop
    -- ORG-13. Already handed to the mailer (or sent, or tried and failed with
    -- its own retry): not rescheduled into a second copy by a postponement.
    if exists (
      select 1 from public.event_messages m
       where m.event_id = p_event
         and m.reminder_id = v_reminder.id
         and m.status in ('queued', 'sent', 'failed')
    ) then
      continue;
    end if;

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

drop trigger if exists trg_reschedule_on_settings_change on public.event_email_settings;
create trigger trg_reschedule_on_settings_change
  after insert or update on public.event_email_settings
  for each row execute function public.reschedule_on_reminder_change();

-- What is already orphaned. A reminder with no reminder time is not wanted,
-- whatever state its event is in.
update public.event_messages
set status = 'cancelled'
where kind = 'reminder' and status = 'scheduled' and reminder_id is null;
