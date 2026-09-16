-- ============================================================================
-- Four things the organiser screens need and could not have
--
-- All four are the same kind of gap: a requirement that describes something an
-- organiser does, against a schema that only ever described what they may read.
--
--   EML-08  retrying failed recipients, which needs a message to be re-openable
--   EML-02  an event with no settings row is an Emails screen updating nothing
--   EML-08  "saved but not yet announced" has to outlive the browser tab
--   ORG-08  a host has to be able to contact their own guests
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. EML-08 — retrying what failed, without resending to everybody
--
-- event_messages had a select policy and nothing else, so the retry button
-- errored every time. Hosts need to re-open a message; they must not be able
-- to rewrite one that has already gone out, because event_messages is the
-- history EML-08 requires to be real.
--
-- The policy opens the row. The trigger is what keeps the record honest,
-- because RLS can gate a row but cannot compare it to the row it used to be.
--
-- One rule, and it needs to know nothing about who is calling: once sent_at is
-- set, the content is frozen — for the host, for the dispatcher, for anybody.
-- The dispatcher never rewrites content either, it writes status, sent_at and
-- error, so the same sentence serves both and there is no need to guess at
-- whether auth.uid() is null for a service-role caller. A message that failed
-- before anything left (sent_at still null) stays fully editable, which is
-- exactly when fixing the body and trying again is the right thing to do.
--
-- ponytail: status itself is not constrained, so a host can write 'sent' on a
-- message that never went. It is cosmetic — event_message_recipients is the
-- delivery record, it has no write policy for anybody, and it contradicts the
-- lie immediately. Constrain the transitions if the summary status ever
-- becomes something reporting is built on.
-- ---------------------------------------------------------------------------

create policy event_messages_update on public.event_messages for update to authenticated
using (public.hosts_event(event_id) or public.is_admin())
with check (public.hosts_event(event_id) or public.is_admin());

create or replace function public.freeze_sent_message_content()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.sent_at is null then
    return new;
  end if;

  if new.event_id        is distinct from old.event_id
     or new.kind         is distinct from old.kind
     or new.reminder_id  is distinct from old.reminder_id
     or new.subject      is distinct from old.subject
     or new.body         is distinct from old.body
     or new.changed_details is distinct from old.changed_details
     or new.triggered_by is distinct from old.triggered_by
  then
    raise exception
      'This message has already been sent, so what it said cannot be changed. Send a new update instead.';
  end if;

  return new;
end;
$$;

comment on function public.freeze_sent_message_content() is
  'EML-08. Once a message has left, its content is history. Status and schedule still move, so a retry can re-open it.';

create trigger trg_freeze_sent_message_content
  before update on public.event_messages
  for each row execute function public.freeze_sent_message_content();

-- The retry itself, as a function rather than as a write policy on
-- event_message_recipients.
--
-- EML-08 is precise: "retry failed recipients without resending to everyone
-- who already received the message". That is a rule about which rows move, and
-- a policy cannot express it — a policy that let a host update recipient rows
-- would also let them reset a 'sent' row and give somebody a second copy, or
-- write a delivery history that never happened. One function does exactly the
-- permitted thing and nothing adjacent to it.
--
-- Deliberately does not clear sent_at: that is when the message first went out,
-- and clearing it would unfreeze the content above.

create or replace function public.retry_failed_recipients(p_message uuid)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_event uuid;
  v_count int;
begin
  select event_id into v_event from public.event_messages where id = p_message;
  if not found then
    raise exception 'We could not find that message.';
  end if;
  if not (public.hosts_event(v_event) or public.is_admin()) then
    raise exception 'You are not running this event.';
  end if;

  update public.event_message_recipients
  set status = 'scheduled', error = null
  where message_id = p_message and status = 'failed';

  get diagnostics v_count = row_count;
  if v_count = 0 then
    return 0;
  end if;

  update public.event_messages
  set status = 'scheduled', scheduled_for = now(), error = null
  where id = p_message;

  return v_count;
end;
$$;

comment on function public.retry_failed_recipients(uuid) is
  'EML-08. Re-opens a message for the recipients whose delivery failed, and only those. Anybody who already received it is untouched.';

-- ---------------------------------------------------------------------------
-- 2. EML-02 — an event must never reach the Emails screen without settings
--
-- The seed trigger covers every event created from now on, and 20260916000008
-- backfills every event that already existed; 20260916000009 creates no events,
-- so the legacy rows are covered by that backfill too. Coverage is complete as
-- it stands.
--
-- The insert policy is here anyway, because the failure mode if it is ever not
-- complete is silent: an update against no row changes nothing and reports
-- success, and the organiser finds out when the reminders do not arrive. With
-- this, the screen can upsert and stop depending on an invariant maintained
-- three migrations away.
-- ---------------------------------------------------------------------------

create policy event_email_settings_insert on public.event_email_settings for insert to authenticated
with check (public.hosts_event(event_id) or public.is_admin());

grant insert on public.event_email_settings to authenticated;

-- ---------------------------------------------------------------------------
-- 3. EML-08 — "saved, not yet announced", in the database
--
-- The organiser saves an address change and does not send the email. EML-08
-- requires the dashboard to say so afterwards and offer the send action. Held
-- in component state that fact lives as long as the tab does: a cohost opening
-- the event tomorrow sees nothing, and the whole point of the requirement is
-- that it is about something the organiser has forgotten to do.
--
-- Null means "there are unannounced changes", which is also the correct answer
-- for an event nobody has ever sent an update about.
--
-- Two small triggers rather than editing enforce_event_lifecycle() and
-- queue_event_message(): both of those are long, both are load-bearing, and
-- neither becomes easier to read with a fourth concern in it.
-- ---------------------------------------------------------------------------

alter table public.events add column details_notified_at timestamptz;

comment on column public.events.details_notified_at is
  'EML-08. When attendees were last told about a change to the details. Cleared the moment a notifiable field moves, so null means "saved but not announced".';

-- EML-03 names the fields an attendee needs to be told about: address, venue,
-- date, time, attendee instructions. A reworded description is not one of them
-- and must not light up the banner.
create or replace function public.clear_details_notified()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.venue_name            is distinct from old.venue_name
     or new.address            is distinct from old.address
     or new.location           is distinct from old.location
     or new.starts_at          is distinct from old.starts_at
     or new.ends_at            is distinct from old.ends_at
     or new.timezone           is distinct from old.timezone
     or new.attendee_instructions is distinct from old.attendee_instructions
  then
    new.details_notified_at := null;
  end if;
  return new;
end;
$$;

comment on function public.clear_details_notified() is
  'EML-03/08. A change an attendee would want to hear about marks the event as having unannounced changes.';

create trigger trg_clear_details_notified
  before update on public.events
  for each row execute function public.clear_details_notified();

-- And the other half: queueing the update email is what marks them told. On
-- event_messages rather than inside queue_event_message() so it holds for any
-- caller, including the dispatcher queueing on somebody's behalf.
--
-- No recursion: this updates a column that is not in the notifiable list
-- above, so the trigger that clears it does not fire on this write.
create or replace function public.stamp_details_notified()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.kind = 'update' then
    update public.events set details_notified_at = now() where id = new.event_id;
  end if;
  return null;
end;
$$;

comment on function public.stamp_details_notified() is
  'EML-08. Queueing an update email is the act that clears the "not yet announced" state.';

create trigger trg_stamp_details_notified
  after insert on public.event_messages
  for each row execute function public.stamp_details_notified();

-- ---------------------------------------------------------------------------
-- 4. ORG-08 — a host can contact their own guests
--
-- "Authorized organizers can access the contact information needed to operate
-- their event." profiles_select shows a connector only their own community, so
-- a host whose guest list contains somebody from outside it — which is the
-- ordinary case for a public event, and the only case for an event-only
-- account — could see a name and no way to reach them.
--
-- Same shape as member_directory, for the same reason: security_invoker off so
-- the view can read past profiles_select, and its own gate in the WHERE. The
-- base-table guarantee is untouched, which is what keeps this from becoming a
-- way to read the whole profiles table.
--
-- What it exposes is ORG-07's list — who registered, which ticket, the
-- registration, payment and check-in states — plus the email ORG-08 allows.
--
-- What it does not expose is the point. No connector notes, no profile
-- answers, no semantic summary, no interests, no ticket code. ORG-08 names
-- notes and unrelated profile answers as excluded, and this view is precisely
-- where that leak would happen, so the column list is the whole defence and it
-- is deliberately short.
-- ---------------------------------------------------------------------------

create view public.event_guest_list
with (security_invoker = off) as
select
  r.event_id,
  r.id             as registration_id,
  r.profile_id,
  p.full_name,
  p.email::text    as email,
  r.status         as registration_status,
  r.created_at     as registered_at,
  r.ticket_type_id,
  t.name           as ticket_type_name,
  t.price_cents,
  o.status         as payment_status,
  o.amount_cents,
  o.currency,
  a.id is not null as attended,
  a.recorded_at    as attended_at,
  a.method         as attendance_method
from public.event_registrations r
join public.profiles p on p.id = r.profile_id
left join public.ticket_types t on t.id = r.ticket_type_id
left join public.event_attendance a
       on a.event_id = r.event_id and a.profile_id = r.profile_id
-- The most recent order for this registration. A registration has at most one
-- live order, but an abandoned checkout leaves a 'pending' row behind and the
-- host should see the one that matters.
left join lateral (
  select o2.status, o2.amount_cents, o2.currency
  from public.event_orders o2
  where o2.registration_id = r.id
  order by o2.created_at desc
  limit 1
) o on true
where public.hosts_event(r.event_id) or public.is_admin();

comment on view public.event_guest_list is
  'ORG-07/08. The guest list a host operates their event from: name, email, ticket, registration, payment and check-in state. No connector notes, no profile answers, no ticket codes.';

revoke all on public.event_guest_list from anon, authenticated;
grant select on public.event_guest_list to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

grant update on public.event_messages to authenticated;

grant execute on function public.retry_failed_recipients(uuid) to authenticated;
