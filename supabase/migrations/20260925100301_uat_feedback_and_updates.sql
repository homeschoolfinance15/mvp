-- The five confirmed UAT defects. Existing answers and sent-message history stay intact.

-- FDB-09/12: old clients cannot read submitted answers through this RPC.
create or replace function public.my_event_feedback(p_event uuid)
returns table (question_id uuid, answer_scale int, answer_text text)
language sql stable security definer set search_path = public
as $$
  select f.question_id, f.answer_scale, f.answer_text
  from public.event_feedback f
  where public.is_admin() and f.event_id = p_event and f.author_id = auth.uid()
$$;

-- FDB-16: a new meaning requires a new row/version, even before the first answer.
create or replace function public.keep_feedback_question_version()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.scope, new.slot, new.version, new.wording, new.answer_format)
     is distinct from (old.scope, old.slot, old.version, old.wording, old.answer_format) then
    raise exception 'Question versions cannot be rewritten. Create a new version instead.' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_keep_feedback_question_version on public.feedback_questions;
create trigger trg_keep_feedback_question_version
  before update on public.feedback_questions
  for each row execute function public.keep_feedback_question_version();

create or replace function public.feedback_answer_scope_matches()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.feedback_questions q
    where q.id = new.question_id and q.scope = tg_argv[0] and q.active
  ) then
    raise exception 'That question is no longer available on this form. Refresh the questions before sending.' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- EML-03/04: retain the original and latest saved values until the update is queued.
alter table public.events add column if not exists unannounced_changes jsonb not null default '{}'::jsonb;
alter table public.event_messages add column if not exists preview_snapshot jsonb;

create or replace function public.event_update_snapshot(p_event public.events)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'title', p_event.title, 'slug', p_event.slug, 'status', p_event.status,
    'starts_at', p_event.starts_at, 'ends_at', p_event.ends_at,
    'timezone', p_event.timezone, 'venue_name', p_event.venue_name,
    'address', p_event.address, 'location', p_event.location,
    'attendee_instructions', p_event.attendee_instructions
  )
$$;

create or replace function public.clear_details_notified()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_field text;
  v_before jsonb := public.event_update_snapshot(old);
  v_after jsonb := public.event_update_snapshot(new);
  v_changes jsonb := old.unannounced_changes;
  v_from jsonb;
begin
  if old.status = 'draft' then
    new.unannounced_changes := '{}'::jsonb;
    return new;
  end if;
  foreach v_field in array array['title','starts_at','ends_at','timezone','venue_name','address','location','attendee_instructions'] loop
    if v_before -> v_field is distinct from v_after -> v_field then
      new.details_notified_at := null;
      v_from := case when v_changes ? v_field then v_changes -> v_field -> 'from' else v_before -> v_field end;
      if v_from = v_after -> v_field then
        v_changes := v_changes - v_field;
      else
        v_changes := v_changes || jsonb_build_object(v_field, jsonb_build_object('from', v_from, 'to', v_after -> v_field));
      end if;
    end if;
  end loop;
  -- The stamp trigger may clear the changes after a successful queue write.
  if v_before is distinct from v_after then new.unannounced_changes := v_changes; end if;
  return new;
end;
$$;

create or replace function public.event_update_preview(p_event uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_event public.events%rowtype; v_count integer;
begin
  if not (public.is_admin() or public.hosts_event(p_event)) then
    raise exception 'You are not running this event.' using errcode = '42501';
  end if;
  select * into strict v_event from public.events where id = p_event;
  select count(distinct r.profile_id) into v_count
  from public.event_registrations r join public.profiles p on p.id = r.profile_id
  where r.event_id = p_event and r.status = 'confirmed'
    and p.profile_status not in ('suspended', 'removed') and coalesce(btrim(p.email), '') <> '';
  return jsonb_build_object('snapshot', public.event_update_snapshot(v_event),
    'changed_details', v_event.unannounced_changes, 'audience_count', v_count);
end;
$$;
revoke all on function public.event_update_preview(uuid) from public, anon;
grant execute on function public.event_update_preview(uuid) to authenticated;

-- Recheck under the event lock at insertion, closing the preview/read/insert race.
create or replace function public.check_event_update_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_event public.events%rowtype; v_field text;
begin
  if new.kind = 'update' and new.preview_snapshot is not null then
    select * into strict v_event from public.events where id = new.event_id for update;
    foreach v_field in array array['starts_at', 'ends_at'] loop
      if new.preview_snapshot ? v_field then
        new.preview_snapshot := jsonb_set(new.preview_snapshot, array[v_field],
          coalesce(to_jsonb((new.preview_snapshot ->> v_field)::timestamptz), 'null'::jsonb));
      end if;
    end loop;
    if new.preview_snapshot is distinct from public.event_update_snapshot(v_event) then
      raise exception 'The event changed again after this preview was built.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_check_event_update_snapshot on public.event_messages;
create trigger trg_check_event_update_snapshot before insert on public.event_messages
  for each row execute function public.check_event_update_snapshot();

create or replace function public.stamp_details_notified()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'update' then
    update public.events set details_notified_at = now(), unannounced_changes = '{}'::jsonb
    where id = new.event_id;
  end if;
  return null;
end;
$$;

-- FDB-06/15: an initial request is still owed when its opening time is in the past.
-- Reuse one message and recipient ledger across reschedules and late corrections.
create or replace function public.ensure_feedback_request(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_event public.events%rowtype;
  v_message public.event_messages%rowtype;
  v_due timestamptz;
  v_added integer;
begin
  -- Attendance inserts already hold a foreign-key KEY SHARE lock on events.
  -- NO KEY UPDATE serializes scheduling without a conflicting lock upgrade
  -- when different guests check in simultaneously.
  select * into v_event from public.events where id = p_event for no key update;
  if not found or v_event.status <> 'published' then return; end if;
  v_due := coalesce(v_event.ends_at, v_event.starts_at) + make_interval(mins => v_event.feedback_opens_after_minutes);
  select * into v_message from public.event_messages
  where event_id = p_event and kind = 'feedback_open'
  order by case status when 'queued' then 0 when 'scheduled' then 1 when 'sent' then 2 when 'failed' then 3 else 4 end,
           created_at desc limit 1 for update;
  if not found then
    insert into public.event_messages(event_id, kind, scheduled_for)
    values (p_event, 'feedback_open', v_due) returning * into v_message;
  end if;

  insert into public.event_message_recipients(message_id, profile_id, email, status)
  select v_message.id, a.profile_id, p.email, 'scheduled'
  from public.event_attendance a join public.profiles p on p.id = a.profile_id
  where a.event_id = p_event and p.profile_status not in ('suspended','removed')
    and coalesce(btrim(p.email), '') <> ''
    and not exists (
      select 1 from public.event_message_recipients r join public.event_messages m on m.id = r.message_id
      where m.event_id = p_event and m.kind = 'feedback_open' and r.profile_id = a.profile_id and r.status = 'sent'
    )
  on conflict (message_id, profile_id) do update set status = 'scheduled', email = excluded.email, error = null
  where event_message_recipients.status in ('skipped', 'cancelled');
  get diagnostics v_added = row_count;

  if v_message.status <> 'queued' and (
    v_message.status in ('scheduled','skipped','cancelled') or v_added > 0
  ) then
    update public.event_messages set status = 'scheduled', scheduled_for = v_due, error = null
    where id = v_message.id;
  end if;
end;
$$;

create or replace function public.add_late_feedback_recipient(p_event uuid, p_profile uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.event_attendance where event_id = p_event and profile_id = p_profile) then
    perform public.ensure_feedback_request(p_event);
  end if;
end;
$$;

-- If a correction arrives while the dispatcher owns the message, its newly queued
-- recipient must survive the dispatcher's final status write.
create or replace function public.keep_pending_feedback_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'feedback_open' and old.status = 'queued' and new.status = 'sent'
     and exists (select 1 from public.event_message_recipients where message_id = new.id and status = 'scheduled') then
    new.status := 'scheduled';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_keep_pending_feedback_request on public.event_messages;
create trigger trg_keep_pending_feedback_request before update on public.event_messages
  for each row execute function public.keep_pending_feedback_request();

revoke all on function public.keep_feedback_question_version(), public.event_update_snapshot(public.events),
  public.check_event_update_snapshot(), public.ensure_feedback_request(uuid), public.keep_pending_feedback_request()
  from public, anon, authenticated;
grant execute on function public.ensure_feedback_request(uuid) to service_role;

-- FDB-09: account exports contain operational records, never submitted reviews.
create or replace function public.export_my_data()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;

  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = v_me),
    'profile_answers', (select to_jsonb(x) from public.profile_answers x where x.profile_id = v_me),
    'posts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.posts x where x.author_id = v_me),
    'comments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                   from public.post_comments x where x.author_id = v_me),
    'likes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.post_likes x where x.profile_id = v_me),
    'circle_messages', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                          from public.circle_messages x where x.author_id = v_me),
    'events_hosted', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                        from public.events x
                       where x.host_id = v_me
                          or exists (select 1 from public.event_hosts h
                                      where h.event_id = x.id and h.profile_id = v_me)),
    'rsvps', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.event_invitations x where x.profile_id = v_me),
    'event_registrations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                              from public.event_registrations x where x.profile_id = v_me),
    'event_tickets', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                        from public.event_tickets x where x.profile_id = v_me),
    'event_orders', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                       from public.event_orders x where x.profile_id = v_me),
    'event_attendance', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                           from public.event_attendance x where x.profile_id = v_me),
    'notifications', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                        from public.notifications x where x.profile_id = v_me),
    'reports_i_raised', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                           from public.profile_reports x where x.reporter_id = v_me),
    'recommendations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                          from public.recommendations x where x.profile_id = v_me),
    'my_activity', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                      from public.activity_log x where x.actor_id = v_me)
  );
end;
$$;


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

  perform public.ensure_feedback_request(p_event);
end;
$$;

-- Repair previously skipped, never-sent requests for published events.
select public.ensure_feedback_request(e.id) from public.events e
where e.status = 'published' and exists (
  select 1 from public.event_messages m where m.event_id = e.id
    and m.kind = 'feedback_open' and m.status = 'skipped' and m.sent_at is null
);
