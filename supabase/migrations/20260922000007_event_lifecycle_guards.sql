-- ============================================================================
-- Event lifecycle guards: the columns a host may not choose
--
-- `authenticated` has UPDATE on every events column, and `events_update` only
-- asks whether you host the event. So the trigger is the only place that can
-- say which columns are not a host's to write:
--
--   ORG-1/ORG-2  host_id, payment_connector_id and payment_recipient_id. §7.0:
--                "nobody added later changes either answer". A cohost could
--                take the event over, or point its sales at their own Stripe
--                (or at Amazing's, by clearing the connector). Admins still
--                can, through is_admin(). A deletion elsewhere that nulls a
--                payment column (ON DELETE SET NULL) arrives as a nested
--                trigger and a service-role call has no auth.uid(); neither
--                is a host choosing a value, so both pass.
--   ORG-3/CRE-18 published_at is never taken from the client. It is stamped by
--                the publish branch and nothing else, and never cleared. A
--                client-written published_at skipped the first-publish check
--                and unlocked a published event's slug.
--   ORG-6        cancelled is terminal. Everyone holding a place was told.
--   ORG-20       timezone, currency and slug in the shapes the UI produces,
--                checked when they are written, not on every later update.
--
-- And on ticket_types:
--   ORG-20       an option's currency is its event's.
--   ORG-11       an option somebody holds cannot be deleted; the FK would have
--                quietly nulled it off their registration.
-- ============================================================================

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
    new.payment_locked_at := old.payment_locked_at;

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
$$;

comment on function public.enforce_event_lifecycle() is
  'ORG-01C, ORG-09, EVT-01, §7.0/§7.2/§7.3, ORG-1/2/3/6/20. Fills the slug, routes the money from the creator and lets only an admin change it or the host, freezes routing once tickets are sold, stamps published_at itself, keeps a cancellation terminal, validates timezone/currency/slug, and refuses a paid publish with a sentence chosen from connector_sale_readiness()''s reason code. The paid check is advisory — stripe-checkout is authoritative.';

-- ---------------------------------------------------------------------------
-- ticket_types: same currency as the event; not deleted from under a holder
-- ---------------------------------------------------------------------------

create or replace function public.guard_ticket_type()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.event_registrations r where r.ticket_type_id = old.id) then
      raise exception 'People already hold this option — switch On sale off instead.';
    end if;
    return old;
  end if;

  if new.currency is distinct from (select e.currency from public.events e where e.id = new.event_id) then
    raise exception 'A ticket option has to be in the event''s currency.';
  end if;
  return new;
end;
$$;

comment on function public.guard_ticket_type() is
  'ORG-20, ORG-11. A ticket option is priced in its event''s currency, and one that registrations point at cannot be deleted (the FK would null it off their tickets).';

drop trigger if exists trg_guard_ticket_type on public.ticket_types;
create trigger trg_guard_ticket_type
  before insert or update of currency, event_id or delete on public.ticket_types
  for each row execute function public.guard_ticket_type();
