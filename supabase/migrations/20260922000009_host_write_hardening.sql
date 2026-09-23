-- ============================================================================
-- Host writes that went further than any screen does
--
-- Each of these was a table a host could write to directly, when every screen
-- that needs the write already goes through a security definer function that
-- does exactly the permitted thing. The direct path was only ever a way round
-- the function's rules.
--
--   ORG-8   attendance: back-dated, a 'scan' nobody made, credited to a cohost
--   ORG-9   sent messages: clear sent_at, rewrite the body, flip back to scheduled
--   ORG-10  invitations: retargeted by UPDATE to a person outside the community
--   ORG-16  invitations to a draft nobody can open
--   ORG-21  a draft's capacity and Stripe standing readable by id
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ORG-8, ATT-06 — attendance is written by check_in() and mark_attended()
--
-- Both are definer and stamp method, recorded_by and recorded_at themselves.
-- A direct insert or update let a host choose all three, which is the
-- fabricated scan and the unobserved arrival time ATT-06 forbids. No screen
-- writes the table directly (CheckIn and EventGuests call the two functions).
-- Delete stays: removing a wrong row invents nothing.
-- ---------------------------------------------------------------------------

drop policy if exists event_attendance_insert on public.event_attendance;
drop policy if exists event_attendance_update on public.event_attendance;
revoke insert, update on public.event_attendance from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. ORG-9, EML-08 — message history is not host-editable
--
-- The update policy was opened for the retry button, which now calls
-- retry_failed_recipients() (definer). With the policy in place, the freeze
-- trigger could be walked round by clearing sent_at first. Nothing else in the
-- client updates event_messages; the dispatcher is service role.
-- ---------------------------------------------------------------------------

drop policy if exists event_messages_update on public.event_messages;
revoke update on public.event_messages from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 3. ORG-10 — an invitation cannot be re-pointed at somebody else
--
-- A resend is a new row (resend_of), so the insert policy — and with it
-- may_invite_to_event() — sees every invitation. send_status is moved by the
-- mailer on the service role. The update policy served nothing but the bypass.
-- ---------------------------------------------------------------------------

drop policy if exists event_invites_update on public.event_invites;
revoke update on public.event_invites from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 4. ORG-16 — only a published event can be invited to
--
-- A draft cannot be opened by the invitee, and a cancelled event is not one to
-- invite anybody to. The notification trigger fires on insert, so refusing the
-- insert here is what stops the bell notice pointing at nothing.
-- ---------------------------------------------------------------------------

create or replace function public.may_invite_to_event(p_event uuid, p_profile uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select (public.hosts_event(p_event) or public.is_admin())
     and exists (
       select 1 from public.events e
        where e.id = p_event and e.status = 'published'
     )
     and (
       public.is_admin()
       or exists (
         select 1 from public.connector_user_links l
          where l.user_profile_id = p_profile
            and l.connector_id = public.my_connector_id()
       )
     );
$$;

comment on function public.may_invite_to_event(uuid, uuid) is
  'ORG-08A, ORG-16. Whether the caller may invite that person to that event: a host of a published event, and either an admin or the connector whose community they belong to.';

-- ---------------------------------------------------------------------------
-- 5. ORG-21 — a draft says nothing to somebody who cannot see it
--
-- Capacity is public for a visible event (the event page shows it), so it
-- follows event_visible(), which already admits hosts, admins and bookers.
--
-- Readiness is the organiser's sentence about their Stripe account (see
-- 20260916000024): hosts and admins, plus stripe-checkout on the service role,
-- which reads can_sell_paid and never passes the sentence on.
-- ---------------------------------------------------------------------------

create or replace function public.event_capacity_state(p_event uuid)
returns table (capacity int, confirmed int, remaining int, state text)
language sql stable security definer set search_path = public
as $$
  select
    e.capacity,
    c.confirmed,
    case when e.capacity is null then null
         else greatest(e.capacity - c.taken, 0) end,
    case
      when e.status = 'cancelled'                                then 'cancelled'
      when coalesce(e.ends_at, e.starts_at) < now()              then 'finished'
      when e.status <> 'published'                               then 'closed'
      when e.registration_closed                                 then 'closed'
      when e.capacity is not null and c.taken >= e.capacity      then 'sold_out'
      else 'open'
    end
  from public.events e
  cross join lateral (
    select
      count(*) filter (where r.status = 'confirmed')::int as confirmed,
      -- BUY-06. Same rule as the capacity trigger: no expiry, no hold.
      count(*) filter (
        where r.status = 'confirmed'
           or (r.status = 'pending' and r.hold_expires_at > now())
      )::int as taken
    from public.event_registrations r
    where r.event_id = e.id
  ) c
  where e.id = p_event
    and public.event_visible(e.id);
$$;

create or replace function public.event_sale_readiness(p_event uuid)
returns table (can_sell_paid boolean, reason text, fix_action text)
language sql stable security definer set search_path = public
as $$
  select s.can_sell_paid, s.reason, s.fix_action
  from public.events e
  cross join lateral public.connector_sale_readiness(e.payment_connector_id) s
  where e.id = p_event
    and (public.hosts_event(e.id)
         or public.is_admin()
         or auth.role() = 'service_role');
$$;
