-- Payment defects found by the local Stripe simulation. One migration.

-- ---------------------------------------------------------------------------
-- D2. One refund in flight per order, not one refund ever. Including
-- 'completed' in the live set meant that after one partial refund landed the
-- rest of the order could never be refunded, from the app or (recorded) from
-- the Stripe dashboard. Over-refunding is still stopped by event-refund's
-- remaining = amount - completed, and by Stripe's own amount_too_large.
-- ---------------------------------------------------------------------------
drop index if exists public.event_refunds_live_key;
create unique index event_refunds_live_key
  on public.event_refunds (order_id)
  where status in ('requested', 'processing');

comment on table public.event_refunds is
  'BUY-09. Money going back. At most one refund in flight per order, so the same payment is never returned twice; completed partial refunds may be followed by more, up to the order amount.';

-- ---------------------------------------------------------------------------
-- D3, D4. A payment landing (pending -> confirmed) used to skip every check.
-- It now refuses a cancelled event, and re-counts capacity when the hold had
-- lapsed, because a lapsed hold's place may already have been sold again.
-- A refusal raises, and confirmPaidOrder() keeps the order paid and writes a
-- needs_attention refund. Opening/closing registration and publish state are
-- deliberately not re-checked: somebody who paid inside a live hold keeps it.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_event_capacity()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_event public.events%rowtype;
  v_taken int;
  v_cap   int;
  v_paying boolean := false;
begin
  -- Only a row that takes a place is interesting. Cancelling and expiring give
  -- one back, and nothing needs locking to give something back.
  if new.status not in ('pending', 'confirmed') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('pending', 'confirmed') then
    if not (old.status = 'pending' and new.status = 'confirmed') then
      return new;
    end if;
    v_paying := true;
  end if;

  select * into v_event from public.events where id = new.event_id for update;

  if not found then
    raise exception 'That event no longer exists.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'This event has been cancelled.';
  end if;

  if v_paying then
    -- A live hold was counted when it was taken, so its place is still there.
    if old.hold_expires_at is not null and old.hold_expires_at > now() then
      return new;
    end if;
  else
    if v_event.status <> 'published' then
      raise exception 'This event is not open for registration.';
    end if;
    if v_event.registration_closed then
      raise exception 'Registration for this event is closed.';
    end if;
  end if;

  if v_event.capacity is not null then
    -- BUY-06. A pending row with no expiry is not a hold and takes nothing.
    select count(*) into v_taken
      from public.event_registrations r
     where r.event_id = new.event_id
       and r.id <> new.id
       and (r.status = 'confirmed'
            or (r.status = 'pending' and r.hold_expires_at > now()));

    if v_taken >= v_event.capacity then
      raise exception 'This event is sold out.';
    end if;
  end if;

  -- A ticket option may also cap itself, which is a smaller question and needs
  -- no lock of its own: the event lock above already serialises everybody
  -- competing for this event.
  if new.ticket_type_id is not null then
    select t.quantity into v_cap from public.ticket_types t where t.id = new.ticket_type_id;

    if v_cap is not null then
      select count(*) into v_taken
        from public.event_registrations r
       where r.ticket_type_id = new.ticket_type_id
         and r.id <> new.id
         and (r.status = 'confirmed'
              or (r.status = 'pending' and r.hold_expires_at > now()));

      if v_taken >= v_cap then
        raise exception 'That ticket option is sold out.';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- B-D12. The §7.2 payment lock could never be set: enforce_event_lifecycle
-- copied old.payment_locked_at over the write lock_event_payment_on_paid()
-- made. Now the nested trigger may set it once; nobody may clear it.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_event_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- ORG-3. A draft born with a published_at would skip the first-publish check.
    new.published_at := case when new.status = 'published' then now() end;
  else
    -- ORG-1/ORG-2. §7.0: only an admin re-decides who hosts and who is paid.
    if (new.host_id, new.payment_connector_id, new.payment_recipient_id)
         is distinct from (old.host_id, old.payment_connector_id, old.payment_recipient_id)
       and auth.uid() is not null
       and pg_trigger_depth() = 1
       and not public.is_admin()
    then
      raise exception 'Only an administrator can change who hosts this event or who it pays.';
    end if;

    -- ORG-6.
    if old.status = 'cancelled' and new.status <> 'cancelled' then
      raise exception 'This event was cancelled and everyone was told, so it cannot be reopened. Create a new event instead.';
    end if;

    -- §7.2. Money already taken decides where the rest of it goes.
    if old.payment_locked_at is not null
       and (new.payment_connector_id is distinct from old.payment_connector_id
            or new.payment_recipient_id is distinct from old.payment_recipient_id)
    then
      raise exception
        'Tickets have already been sold for this event, so the payment account cannot be changed.';
    end if;
    -- Set once, by lock_event_payment_on_paid() (a nested trigger, depth > 1),
    -- and never cleared. Keeping old unconditionally threw that write away,
    -- so no event was ever locked.
    new.payment_locked_at := case
      when old.payment_locked_at is null and pg_trigger_depth() > 1 then new.payment_locked_at
      else old.payment_locked_at
    end;

    -- ORG-3/CRE-18. Only the publish branch below writes this.
    new.published_at := old.published_at;

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

      new.published_at := coalesce(old.published_at, now());
    end if;

    if new.status = 'cancelled' and old.status <> 'cancelled' then
      new.cancelled_at := coalesce(new.cancelled_at, now());
      new.cancelled_by := coalesce(new.cancelled_by, auth.uid());
    end if;

    if old.published_at is not null and new.slug is distinct from old.slug then
      raise exception 'The link for a published event cannot be changed.';
    end if;
  end if;

  -- ORG-20. Only what is being written now; an old row is not re-judged.
  if tg_op = 'INSERT' or new.timezone is distinct from old.timezone then
    if not exists (select 1 from pg_timezone_names where name = new.timezone) then
      raise exception 'That time zone is not one we recognise. Pick one from the list.';
    end if;
  end if;
  if (tg_op = 'INSERT' or new.currency is distinct from old.currency)
     and new.currency !~ '^[a-z]{3}$'
  then
    raise exception 'A currency is a three-letter code, such as gbp.';
  end if;
  if (tg_op = 'INSERT' or new.slug is distinct from old.slug)
     and new.slug !~ '^[a-z0-9-]+$'
  then
    raise exception 'An event link can only use lowercase letters, numbers and hyphens.';
  end if;

  return new;
end;
$function$;

-- Backfill: every event that has taken money is locked from its first payment.
-- The lifecycle trigger is bypassed for this one statement only, because at
-- depth 0 it would (correctly) refuse to let a plain UPDATE set the lock.
alter table public.events disable trigger trg_enforce_event_lifecycle;
update public.events e
   set payment_locked_at = o.first_paid
  from (
    select event_id, min(coalesce(paid_at, created_at)) as first_paid
      from public.event_orders
     where status in ('paid', 'refunded', 'partially_refunded') and amount_cents > 0
     group by event_id
  ) o
 where o.event_id = e.id and e.payment_locked_at is null;
alter table public.events enable trigger trg_enforce_event_lifecycle;
