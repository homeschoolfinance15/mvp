-- ============================================================================
-- event_sale_readiness — can this event take money right now
--
-- This replaces the ticket_types trigger the previous migration's comment asked
-- for, and that trigger should not be built. It would refuse a paid ticket type
-- on an event whose Stripe is not connected yet, which is stricter than both
-- Luma and Eventbrite — both let an organiser build the whole event and price
-- it before connecting an account — and it fixes the wrong layer anyway.
--
-- Payment capability is checked where money moves, every time, never at a
-- lifecycle transition. Stripe itself works this way: charges_enabled is
-- re-evaluated on every charge, and there is no such thing as "you were allowed
-- when you published". So stripe-checkout is not one of three redundant gates,
-- it is THE gate, and the publish check is a courtesy that fails early.
--
-- The shape is event_capacity_state()'s: derived from current state, no
-- transition semantics, one definition that every screen reads so they cannot
-- disagree. Three consumers:
--
--   stripe-checkout       authoritative, at the moment of the charge
--   organiser dashboard   a live banner
--   publish               advisory, same answer, fails early
--
-- It also closes something nobody had raised: today, when a connector's Stripe
-- is restricted after publishing, the dashboard says nothing at all and the
-- organiser learns about it from a confused attendee.
--
-- NOTE: superseded in part by 20260916000024, which splits the words into an
-- attendee sentence and an organiser sentence. The reasoning for the split is
-- in that file. This one is left exactly as it was applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The answer, asked of a payment account
--
-- The states and their order are lifted from payoutState() in
-- src/routes/connector/payouts.ts, deliberately and exactly: same sequence,
-- same vocabulary, same fix verbs. That file already owns the prose an
-- organiser reads, and it stays owning it — a second copy of those sentences
-- here is precisely the duplication that produced the audience bug. What this
-- returns is the machine answer: a stable reason code and the fix verb, which
-- the client maps to the words it already has.
--
--   platform_account   null connector: Amazing's own Stripe (BUY-13)
--   no_account         nothing connected
--   disconnected       was connected, is not now (§7.3, last row)
--   restricted         Stripe will not accept new charges
--   pending            onboarding unfinished
--   charges_disabled   connected, charges not switched on yet
--   ready              sell
--
-- Every blocking state stops NEW paid sales and nothing else. Existing
-- bookings, tickets, check-in and refunds are untouched by all of them, which
-- is the rule §7.3 spends its last row on.
-- ---------------------------------------------------------------------------

create or replace function public.connector_sale_readiness(p_connector uuid)
returns table (can_sell_paid boolean, reason text, fix_action text)
language sql stable security definer set search_path = public
as $$
  select
    r.reason = 'ready' or r.reason = 'platform_account',
    r.reason,
    case r.reason
      when 'no_account'       then 'connect'
      when 'disconnected'     then 'connect'
      when 'pending'          then 'continue'
      when 'restricted'       then 'stripe'
      when 'charges_disabled' then 'stripe'
      else null
    end
  from (
    select case
      when p_connector is null then 'platform_account'
      when c.id is null then 'no_account'
      when c.stripe_account_id is null or c.stripe_account_status = 'none' then 'no_account'
      when c.stripe_account_status = 'disconnected' then 'disconnected'
      when c.stripe_account_status = 'restricted'   then 'restricted'
      when c.stripe_account_status = 'pending'      then 'pending'
      when not c.stripe_charges_enabled             then 'charges_disabled'
      else 'ready'
    end as reason
    from (select 1) one
    left join public.connectors c on c.id = p_connector
  ) r;
$$;

comment on function public.connector_sale_readiness(uuid) is
  '§7.3. Whether that payment account can take a charge right now, as a stable reason code and a fix verb. The states and their order mirror payoutState() in src/routes/connector/payouts.ts, which owns the words.';

-- ---------------------------------------------------------------------------
-- 2. The same answer, asked of an event
--
-- The name the consumers use. Two entry points onto one body rather than two
-- implementations: the trigger in section 3 has to ask about a connector it is
-- holding in NEW and cannot ask about an event row that is mid-update.
-- ---------------------------------------------------------------------------

create or replace function public.event_sale_readiness(p_event uuid)
returns table (can_sell_paid boolean, reason text, fix_action text)
language sql stable security definer set search_path = public
as $$
  select s.can_sell_paid, s.reason, s.fix_action
  from public.events e
  cross join lateral public.connector_sale_readiness(e.payment_connector_id) s
  where e.id = p_event;
$$;

comment on function public.event_sale_readiness(uuid) is
  '§7.3. Whether this event can sell paid tickets right now: (can_sell_paid, reason, fix_action). Derived from current state, so it is as true after publication as before it — which is how an organiser finds out that Stripe restricted them last week.';

-- ---------------------------------------------------------------------------
-- 3. Publish, using the same answer
--
-- Unchanged in effect and no longer carrying its own opinion. The sentence an
-- organiser meets at publish is chosen from the reason code, so it says what is
-- actually wrong rather than "connect a Stripe account" to somebody whose
-- account is connected and restricted.
--
-- Still advisory. Nothing here is what protects the money: a paid ticket type
-- added after publication never re-runs this, and that is fine, because
-- stripe-checkout asks the same function at the moment of every charge.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_event_lifecycle()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_creator_connector uuid;
  v_has_paid_tickets  boolean;
  v_ready             boolean;
  v_reason            text;
begin
  if tg_op = 'INSERT' then
    if new.slug is null or btrim(new.slug) = '' then
      new.slug := public.generate_event_slug(new.title);
    end if;

    -- §7.0. A connector creator is paid on their own account, full stop.
    select c.id into v_creator_connector
      from public.connectors c where c.profile_id = new.host_id;
    if v_creator_connector is not null then
      new.payment_connector_id := v_creator_connector;
    end if;

    new.payment_locked_at := null;

    if new.status = 'published' then
      new.published_at := coalesce(new.published_at, now());
    end if;
    return new;
  end if;

  -- §7.2. Money already taken decides where the rest of it goes.
  if old.payment_locked_at is not null
     and (new.payment_connector_id is distinct from old.payment_connector_id
          or new.payment_recipient_id is distinct from old.payment_recipient_id)
  then
    raise exception
      'Tickets have already been sold for this event, so the payment account cannot be changed.';
  end if;
  new.payment_locked_at := old.payment_locked_at;

  if new.status = 'published' and old.status is distinct from 'published' then
    -- ORG-01C. Only the first publish asks permission.
    if old.published_at is null
       and not (public.may_create_events(auth.uid()) or public.is_admin())
    then
      raise exception 'You do not have permission to publish events.';
    end if;

    select exists (
      select 1 from public.ticket_types t
       where t.event_id = new.id and t.is_active and t.price_cents > 0
    ) into v_has_paid_tickets;

    if v_has_paid_tickets then
      select s.can_sell_paid, s.reason into v_ready, v_reason
      from public.connector_sale_readiness(new.payment_connector_id) s;

      if not v_ready then
        raise exception '%', case v_reason
          when 'no_account'       then 'Connect a Stripe account before publishing an event with paid tickets.'
          when 'disconnected'     then 'This event''s Stripe account is no longer connected, so paid tickets cannot go on sale. Reconnect it, or publish without paid tickets.'
          when 'restricted'       then 'Stripe has restricted this event''s payment account and will not accept new charges. Resolve it with Stripe, or publish without paid tickets.'
          when 'pending'          then 'Stripe has not finished setting up this event''s payment account. Finish onboarding on Stripe, or publish without paid tickets.'
          when 'charges_disabled' then 'Stripe has not switched charges on for this event''s payment account yet. Paid tickets cannot go on sale until it does.'
          else 'Paid tickets cannot go on sale for this event yet.'
        end;
      end if;
    end if;

    new.published_at := coalesce(new.published_at, now());
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
    new.cancelled_by := coalesce(new.cancelled_by, auth.uid());
  end if;

  if old.published_at is not null and new.slug is distinct from old.slug then
    raise exception 'The link for a published event cannot be changed.';
  end if;

  return new;
end;
$$;

comment on function public.enforce_event_lifecycle() is
  'ORG-01C, ORG-09, EVT-01, §7.0/§7.2/§7.3. Fills the slug, routes the money from the creator, freezes routing once tickets are sold, and refuses a paid publish with the reason event_sale_readiness() gives. The paid check is advisory — stripe-checkout is authoritative.';

-- ---------------------------------------------------------------------------
-- 4. The note that is now wrong
--
-- 20260916000021 told the next reader to add a trigger on ticket_types before
-- trimming the edge-function check. That was the wrong instruction and this
-- replaces it.
-- ---------------------------------------------------------------------------

comment on function public.may_sell_paid_events(uuid) is
  '§7.3. Superseded by connector_sale_readiness(), which gives the same answer plus the reason and the fix. Kept because policies and older callers still reference it. Note that no lifecycle transition protects paid sales and none should: payment capability is checked where money moves, so stripe-checkout is authoritative and every other check is a courtesy that fails early.';

grant execute on function public.connector_sale_readiness(uuid) to anon, authenticated;
grant execute on function public.event_sale_readiness(uuid)     to anon, authenticated;
