-- ============================================================================
-- Putting sale readiness back to one vocabulary
--
-- 20260916000023 returned a stable code in `reason` and payoutState()'s own
-- verb in `fix_action` — connect, continue, stripe. 20260916000024 replaced
-- both: `reason` became an organiser sentence rendered verbatim, and
-- `fix_action` became a token from a newly invented set (connect_stripe,
-- reconnect_stripe, resolve_stripe_restriction, finish_stripe_onboarding).
-- Both files are applied.
--
-- The invented set is the one to lose. A second vocabulary for the same five
-- states is the duplication that cost this build a function already: the
-- client has a mapping for PayoutState.fix, it is correct, and the database
-- returning a parallel set of strings for the same facts means two places to
-- change and one of them will be forgotten. The value of `fix_action` is that
-- it picks a link target and a button label, and payoutState()'s verbs do that
-- exactly as well as longer ones do.
--
-- The sentence in `reason` goes with it, for the same reason and one more: the
-- prose belongs in src/routes/connector/payouts.ts, which already holds it and
-- which is where a copywriter would look. A migration is a poor home for words
-- somebody will want to edit without a database deployment.
--
-- So this restores 20260916000023's behaviour exactly:
--
--   reason       a stable code: platform_account | no_account | disconnected |
--                restricted | pending | charges_disabled | ready
--   fix_action   connect | continue | stripe, identical to PayoutState.fix
--
-- Both are non-null in every state, including the two that can sell —
-- 'ready' and 'platform_account' are facts worth returning, not silence.
--
-- The signature is unchanged through all three files, so this replaces rather
-- than drops and the grants survive untouched.
--
-- enforce_event_lifecycle() has to come back with it: 20260916000024 made it
-- read `reason` as the message to raise, and a code raised at an organiser
-- would read as "restricted" with no sentence around it. It returns to
-- choosing its own sentence from the code, which is the version that was
-- applied in 20260916000023 and is the last one anybody verified.
-- ============================================================================

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
  '§7.3. Whether that payment account can take a charge right now, as a stable reason code and a fix verb. The states, their order and the verbs are payoutState()''s in src/routes/connector/payouts.ts, which owns the words — one vocabulary, mapped once, on the client.';

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
  '§7.3. Whether this event can sell paid tickets right now: (can_sell_paid, reason, fix_action). Derived from current state, so it is as true after publication as before it. Says nothing about whether the event has paid tickets at all; that is the caller''s question.';

-- ---------------------------------------------------------------------------
-- Publish, choosing its own sentence from the code again
--
-- Still advisory, and still the same answer the dashboard gets. The sentences
-- here are the ones an organiser meets at the moment they press publish, which
-- is a different moment from reading a banner, so they say what to do about it
-- rather than describing the state.
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
  'ORG-01C, ORG-09, EVT-01, §7.0/§7.2/§7.3. Fills the slug, routes the money from the creator, freezes routing once tickets are sold, and refuses a paid publish with a sentence chosen from connector_sale_readiness()''s reason code. The paid check is advisory — stripe-checkout is authoritative.';
