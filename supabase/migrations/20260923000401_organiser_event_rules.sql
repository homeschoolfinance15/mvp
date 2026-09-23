-- ============================================================================
-- Organiser rules the database holds, not the screen
--
--   ORG-7   mark_attended() names somebody with a confirmed place, an
--           invitation, or a seat on the hosting team. Anybody else is a
--           stranger being written into the attendance record.
--   ORG-12  switching a paid option on for a published event asks the same
--           payment question the first publish asked. Without it, publish free
--           and add the paid option afterwards walked round that check.
--   ORG-13  a reminder that already went out is not sent again when the event
--           moves. The attendee has it; a second copy with a new time reads as
--           a mistake. The "details changed" email is how they hear the move.
--   ORG-14  a published event that has invited people or emailed them cannot
--           be deleted. They were told it exists; cancelling tells them it is
--           off. Eventbrite has the same rule (delete only events without
--           orders; otherwise cancel).
--   ORG-15  only the creator (events.host_id, which only an admin can change)
--           or an admin deletes. A cohost runs the event, not its existence.
--   ORG-22  an event with a confirmed place cannot go back to draft. Taking
--           it down silently strands the people holding tickets; cancelling is
--           the path, and it tells them.
--
-- ORG-14 and ORG-15 hold on a direct delete only (pg_trigger_depth() = 1, a
-- signed-in caller). The cascade from a profile being erased has its own
-- guard (20260916000034) and its own "account or everything" choice
-- (20260923000801); these two rules must not refuse a person closing their
-- account. The registrations/orders/attendance refusal still holds on every
-- path, as before.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ORG-7 — mark_attended()
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

  -- ORG-7. Hosts are in the list for the FDB-06 reason above.
  if not (
    exists (
      select 1 from public.event_registrations r
       where r.event_id = p_event and r.profile_id = p_profile and r.status = 'confirmed'
    )
    or exists (
      select 1 from public.event_invites i
       where i.event_id = p_event and i.profile_id = p_profile
    )
    or exists (
      select 1 from public.event_host_ids(p_event) h where h.profile_id = p_profile
    )
  ) then
    raise exception
      'This person has no confirmed place at this event and was not invited to it, so they '
      'cannot be marked as attended. Register or invite them first.';
  end if;

  insert into public.event_attendance
    (event_id, profile_id, method, recorded_by, corrected, reason)
  values
    (p_event, p_profile, 'manual', v_me, true, nullif(btrim(coalesce(p_reason, '')), ''))
  on conflict (event_id, profile_id) do nothing;
end;
$$;

comment on function public.mark_attended(uuid, uuid, text) is
  'ATT-04, ORG-7. A host records that somebody with a confirmed place, an invitation or a host seat was there without a scan. Always marked as a correction (ATT-06), never as a scan.';

-- ---------------------------------------------------------------------------
-- 2. ORG-12 — a paid option goes on sale only where the money can land
-- ---------------------------------------------------------------------------

create or replace function public.guard_paid_ticket_activation()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_event  public.events%rowtype;
  v_ready  boolean;
  v_reason text;
begin
  -- Only the moment an option becomes paid-and-on-sale. An option that was
  -- already selling is left alone, so renaming it on a restricted account
  -- still saves (and checkout still refuses the sale, BUY-14).
  if not (new.is_active and new.price_cents > 0) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.is_active and old.price_cents > 0 then
    return new;
  end if;

  select * into v_event from public.events where id = new.event_id;
  -- A draft is asked at publish (enforce_event_lifecycle); a cancelled event
  -- sells nothing whatever its options say.
  if v_event.status is distinct from 'published' then
    return new;
  end if;

  select s.can_sell_paid, s.reason into v_ready, v_reason
  from public.connector_sale_readiness(v_event.payment_connector_id) s;

  if not v_ready then
    raise exception '%', case v_reason
      when 'no_account'       then 'Connect a Stripe account before putting a paid ticket on sale.'
      when 'disconnected'     then 'This event''s Stripe account is no longer connected, so a paid ticket cannot go on sale. Reconnect it first.'
      when 'restricted'       then 'Stripe has restricted this event''s payment account, so a paid ticket cannot go on sale. Resolve it with Stripe first.'
      when 'pending'          then 'Stripe has not finished setting up this event''s payment account, so a paid ticket cannot go on sale yet. Finish onboarding on Stripe first.'
      when 'charges_disabled' then 'Stripe has not switched charges on for this event''s payment account yet, so a paid ticket cannot go on sale.'
      else 'A paid ticket cannot go on sale for this event yet.'
    end;
  end if;

  return new;
end;
$$;

comment on function public.guard_paid_ticket_activation() is
  'ORG-12. Refuses a paid ticket option being created or switched on for a published event whose payment account cannot take charges — the same question enforce_event_lifecycle() asks at first publish.';

drop trigger if exists trg_guard_paid_ticket_activation on public.ticket_types;
create trigger trg_guard_paid_ticket_activation
  before insert or update of is_active, price_cents on public.ticket_types
  for each row execute function public.guard_paid_ticket_activation();

-- ---------------------------------------------------------------------------
-- 3. ORG-13 — schedule_event_messages(), reminders go out once
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

-- ---------------------------------------------------------------------------
-- 4. ORG-22 — people with a confirmed place are not taken down on
-- ---------------------------------------------------------------------------

create or replace function public.guard_event_unpublish()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.status = 'published' and new.status = 'draft'
     and exists (
       select 1 from public.event_registrations r
        where r.event_id = old.id and r.status = 'confirmed'
     )
  then
    raise exception
      'People have confirmed places at this event, so it cannot be taken down. Cancel it '
      'instead: that tells everyone holding a place and keeps the history.';
  end if;
  return new;
end;
$$;

comment on function public.guard_event_unpublish() is
  'ORG-22. A published event with a confirmed registration cannot return to draft; cancelling is the path.';

drop trigger if exists trg_guard_event_unpublish on public.events;
create trigger trg_guard_event_unpublish
  before update of status on public.events
  for each row execute function public.guard_event_unpublish();

-- ---------------------------------------------------------------------------
-- 5. ORG-14, ORG-15 — guard_event_deletion()
-- ---------------------------------------------------------------------------

create or replace function public.guard_event_deletion()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_direct boolean := auth.uid() is not null and pg_trigger_depth() = 1;
begin
  -- ORG-15. events_delete lets any host through; the creator decides.
  if v_direct and old.host_id <> auth.uid() and not public.is_admin() then
    raise exception 'Only the person who created this event, or an administrator, can delete it.';
  end if;

  if exists (select 1 from public.event_registrations r where r.event_id = old.id)
     or exists (select 1 from public.event_orders o where o.event_id = old.id)
     or exists (select 1 from public.event_attendance a where a.event_id = old.id)
  then
    raise exception
      'This event has registrations, payments or attendance recorded against it, so it '
      'cannot be deleted — that would erase other people''s tickets and payment records. '
      'Cancel it instead: that stops sales, invalidates entry, tells everyone holding a '
      'place, and keeps the history.';
  end if;

  -- ORG-14.
  if v_direct and old.status = 'published' and (
       exists (select 1 from public.event_invites i where i.event_id = old.id)
       or exists (
         select 1 from public.event_messages m
          where m.event_id = old.id and m.status in ('queued', 'sent')
       )
     )
  then
    raise exception
      'People have been invited to or emailed about this event, so it cannot be deleted. '
      'Cancel it instead: that tells them it is off and keeps the history.';
  end if;

  return old;
end;
$$;

comment on function public.guard_event_deletion() is
  'ORG-14, ORG-15, QLT-08. Only the creator or an admin deletes an event directly; never one anybody has registered for, paid for or attended (every path, including a cascade); never a published one that has invited or emailed people (direct deletes). Cancelling is the supported route and keeps the history.';
