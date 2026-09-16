-- ============================================================================
-- Sale readiness: an organiser sentence and a machine token
--
-- 20260916000023 was applied returning (can_sell_paid, reason, fix_action) with
-- reason as a stable code and fix_action as a bare verb. The shape is right and
-- the contents were not:
--
--   reason       is now the organiser-facing SENTENCE, rendered verbatim. All
--                three organiser surfaces — the dashboard banner, the payment
--                panel and the publish modal — read this one string, so they
--                cannot word the same problem three ways.
--
--   fix_action   is now a TOKEN from a closed set, never rendered raw. A token
--                can choose a link target and a button label; a sentence can
--                choose neither. The organiser UI was deriving the destination
--                from payment_connector_id != null, which is a heuristic
--                standing in for a fact this function already holds.
--
-- Both are null when can_sell_paid is true. There is nothing to say.
--
-- ---------------------------------------------------------------------------
-- The attendee is a different audience with a different sentence, by design
--
-- An earlier draft of this file tried to serve both from here, with an
-- attendee_message column. That was the wrong fix and it is gone. A sentence
-- vague enough to be safe for a stranger is useless to the organiser, and one
-- specific enough to help the organiser leaks their standing with Stripe to
-- whoever hit checkout. The attendee's refusal is a fixed sentence owned by
-- stripe-checkout, keyed off can_sell_paid being false and saying nothing about
-- why.
--
-- Single-sourcing still holds where it matters: one organiser sentence for
-- three organiser surfaces. Two audiences having two sentences is a decision,
-- not drift.
--
-- ---------------------------------------------------------------------------
-- The closed set, and the one value this function cannot return
--
--   connect_stripe                nothing connected
--   reconnect_stripe              was connected, is not now
--   resolve_stripe_restriction    Stripe has restricted the account
--   finish_stripe_onboarding      connected, charges not enabled, onboarding
--                                 still outstanding
--   platform_stripe_unconfigured  an Amazing-hosted event and the platform
--                                 Stripe key is missing
--
-- The last one is part of the vocabulary and this function will never emit it,
-- which is worth saying plainly rather than leaving as a silent gap.
-- Whether the platform's own Stripe key exists is an edge-function environment
-- fact — STRIPE_SECRET_KEY — and there is nothing in this database that can
-- observe it. A null payment_connector_id means "Amazing's own account", and
-- from here that is simply ready.
--
-- So stripe-checkout owns that token: it is the only thing that knows the key
-- is absent, and it finds out at exactly the moment it matters. It is in the
-- set here so both sides agree on the spelling and so the organiser UI has a
-- branch for it. If you would rather the database could answer it too, the
-- cheapest honest way is an explicit operations flag — a GUC read with
-- current_setting('app.settings.platform_stripe_ready', true) — rather than
-- this function inferring a deployment fact it cannot see. Say the word.
-- ============================================================================

-- The return type is unchanged from 20260916000023 — same three columns, same
-- types — so this replaces rather than drops, and the grants survive.

create or replace function public.connector_sale_readiness(p_connector uuid)
returns table (can_sell_paid boolean, reason text, fix_action text)
language sql stable security definer set search_path = public
as $$
  select
    r.code in ('ready', 'platform_account'),

    -- Organiser-facing, rendered verbatim. Every one of these is careful to say
    -- that existing bookings are unaffected: §7.3's last row is the rule that
    -- is easiest to get wrong, and an organiser reading a blocked banner needs
    -- to know their sold tickets are still good.
    case r.code
      when 'no_account'       then 'No Stripe account is connected to this event''s payment recipient, so paid tickets cannot go on sale. Free events are unaffected.'
      when 'disconnected'     then 'This event''s Stripe account is no longer connected. New paid sales are stopped; bookings already made, their tickets, check-in and refunds all carry on working.'
      when 'restricted'       then 'Stripe has restricted this event''s payment account and will not accept new charges through it. Stripe says what it needs, usually identity or business details, in the account dashboard. Existing bookings and refunds are unaffected.'
      when 'pending'          then 'Stripe has the account but has not finished setting it up. Continue on Stripe and answer what it still asks for. Until then, free events only.'
      when 'charges_disabled' then 'Stripe has not switched charges on for this account yet, usually a verification step still in progress on their side. Free events can go ahead in the meantime.'
      else null
    end,

    case r.code
      when 'no_account'       then 'connect_stripe'
      when 'disconnected'     then 'reconnect_stripe'
      when 'restricted'       then 'resolve_stripe_restriction'
      when 'pending'          then 'finish_stripe_onboarding'
      when 'charges_disabled' then 'finish_stripe_onboarding'
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
    end as code
    from (select 1) one
    left join public.connectors c on c.id = p_connector
  ) r;
$$;

comment on function public.connector_sale_readiness(uuid) is
  '§7.3. Whether that payment account can take a charge right now. reason is the organiser-facing sentence, rendered verbatim; fix_action is a token from a closed set (connect_stripe, reconnect_stripe, resolve_stripe_restriction, finish_stripe_onboarding, platform_stripe_unconfigured) and is never rendered raw. Both null when can_sell_paid is true. The attendee''s refusal is a fixed sentence owned by stripe-checkout and is deliberately not here.';

-- ---------------------------------------------------------------------------
-- The same answer, asked of an event
--
-- One question only: can the payment destination for this event take money
-- right now. It does not ask whether the event has any paid ticket type — that
-- is the caller's concern, and keeping it out is what makes this a single clear
-- question rather than a compound one:
--
--   stripe-checkout       the event necessarily has a paid ticket, because
--                         somebody is trying to pay for it
--   organiser dashboard   gates on "there is an active paid ticket type"
--                         itself, so a free-only event never shows the banner
--   publish               the same, advisory
--
-- A free-only event whose host has no Stripe therefore reports can_sell_paid
-- false, and every caller correctly ignores it. That is intended.
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
  '§7.3. Whether this event can sell paid tickets right now. Derived from current state, so it is as true after publication as before it. Says nothing about whether the event has paid tickets at all; that is the caller''s question.';

-- ---------------------------------------------------------------------------
-- Publish speaks to an organiser, so it uses the organiser sentence
--
-- The case statement that lived inside this trigger is gone. The words are in
-- one place now and the trigger reads them, rather than keeping a parallel set
-- that could drift from the dashboard's.
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
        raise exception '%', v_reason;
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
  'ORG-01C, ORG-09, EVT-01, §7.0/§7.2/§7.3. Fills the slug, routes the money from the creator, freezes routing once tickets are sold, and refuses a paid publish with the organiser sentence connector_sale_readiness() supplies. The paid check is advisory — stripe-checkout is authoritative.';
