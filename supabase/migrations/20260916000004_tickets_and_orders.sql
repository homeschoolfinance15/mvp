-- ============================================================================
-- Tickets, registrations, orders, refunds
--
-- Five tables that between them answer four questions people will ask at
-- awkward moments, and which must never be answered by the same row:
--
--   ticket_types          what is on sale, and for how much
--   event_registrations   who has a place, and what kind of place it is
--   event_orders          what money was taken, by which Stripe account
--   event_refunds         what money went back
--   event_tickets         what gets scanned at the door
--
-- Keeping them apart is the whole design. A registration is not a payment:
-- free events have no order at all, a paid registration exists for twenty
-- minutes before its money does (BUY-06), and a refunded order does not
-- automatically mean the person is not coming. BUY-08 is explicit that "your
-- place is cancelled" and "your money is back" are two sentences with two
-- different timelines, and one column cannot say both.
--
-- Capacity belongs to the event, never to a ticket type (ORG-04): every
-- option shares the one number, so an organiser does not have to keep four
-- sub-totals adding up to the size of the room.
--
-- BUY-05 is the rule this file is built around and it is handled in exactly
-- one place: a before-trigger that locks the event row before counting. Read
-- section 6.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ticket_types
--
-- An event with no rows here is free with no options to choose between — that
-- is the legacy shape and it keeps working. price_cents = 0 is a deliberate
-- free option sitting alongside paid ones, which is a different thing from
-- having no options at all.
--
-- is_active rather than deletion: a ticket type somebody has already bought
-- cannot be removed without orphaning their order (ORG-04).
-- ---------------------------------------------------------------------------

create table public.ticket_types (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events (id) on delete cascade,
  name        varchar not null,
  price_cents int not null default 0,
  currency    char(3) not null default 'gbp',
  quantity    int,
  position    int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),

  constraint ticket_types_name_length   check (length(btrim(name)) between 1 and 120),
  constraint ticket_types_price_sane    check (price_cents >= 0),
  constraint ticket_types_quantity_sane check (quantity is null or quantity > 0)
);

create index ticket_types_event_idx on public.ticket_types (event_id, position);

comment on table public.ticket_types is
  'ORG-04. What is on sale for an event. All options share events.capacity; quantity is an optional cap on this one option.';
comment on column public.ticket_types.quantity is
  'Optional ceiling for this option alone. Null means the event capacity is the only limit.';

-- ---------------------------------------------------------------------------
-- 2. event_registrations
--
-- One person's place at one event. The partial unique index is the
-- anti-duplicate guard: somebody may hold or have exactly one live place, and
-- after cancelling they may take another, because cancelled and expired rows
-- fall out of the predicate.
--
-- terms_snapshot copies the refund terms as they read when this person agreed
-- to them (BUY-15). The event's terms can be edited afterwards; what somebody
-- actually agreed to cannot.
-- ---------------------------------------------------------------------------

create table public.event_registrations (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events (id)   on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  ticket_type_id  uuid references public.ticket_types (id)      on delete set null,
  status          registration_status not null default 'pending',
  hold_expires_at timestamptz,
  confirmed_at    timestamptz,
  cancelled_at    timestamptz,
  cancelled_by    uuid references public.profiles (id) on delete set null,
  terms_snapshot  text,
  created_at      timestamptz not null default now()
);

create unique index event_registrations_live_key
  on public.event_registrations (event_id, profile_id)
  where status in ('pending', 'confirmed');

create index event_registrations_event_idx   on public.event_registrations (event_id, status);
create index event_registrations_profile_idx on public.event_registrations (profile_id, created_at desc);
create index event_registrations_holds_idx   on public.event_registrations (hold_expires_at)
  where status = 'pending';

comment on table public.event_registrations is
  'Who has a place at an event. One live row per person per event; cancelling releases the place and lets them take another.';
comment on column public.event_registrations.hold_expires_at is
  'BUY-06. A place held while Stripe Checkout is open. expire_event_holds() releases it when the moment passes.';
comment on column public.event_registrations.terms_snapshot is
  'BUY-15. The refund terms as they read when this person agreed to them. The event''s copy can be edited; this cannot.';

-- ---------------------------------------------------------------------------
-- 3. event_orders
--
-- BUY-04: two unique constraints are the whole of double-charge protection.
-- idempotency_key is the client's promise that a retried request is the same
-- request; stripe_checkout_session_id is Stripe's, and the webhook is
-- idempotent on it.
--
-- stripe_account_id is written at checkout and never recomputed (§7.2). The
-- event's answer to "whose account" can change; this order's cannot, because
-- the refund has to go back through the account that took the money, and that
-- account may by then have been disconnected from the connector.
--
-- application_fee_cents is always 0 in this release: §13 excludes platform
-- commission, and direct charges mean turning it on later is one parameter
-- rather than a re-architecture.
-- ---------------------------------------------------------------------------

create table public.event_orders (
  id                         uuid primary key default gen_random_uuid(),
  event_id                   uuid not null references public.events (id)     on delete cascade,
  profile_id                 uuid not null references public.profiles (id)   on delete cascade,
  registration_id            uuid references public.event_registrations (id) on delete set null,
  amount_cents               int not null,
  fee_cents                  int,
  application_fee_cents      int not null default 0,
  currency                   char(3) not null default 'gbp',
  status                     order_status not null default 'pending',
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id   text,
  stripe_account_id          text,
  -- not null, and that is the whole point of it. A unique index does not
  -- constrain nulls — two null keys do not collide — so a nullable key would
  -- have given exactly no protection against the double charge it exists to
  -- prevent (BUY-04). The checkout function derives it from the event, the
  -- person, the ticket and the registration, so it always has one.
  idempotency_key            text not null unique,
  terms_snapshot             text,
  paid_at                    timestamptz,
  created_at                 timestamptz not null default now(),

  constraint event_orders_amount_sane check (amount_cents >= 0),
  constraint event_orders_fee_sane
    check (application_fee_cents >= 0 and application_fee_cents <= amount_cents)
);

create index event_orders_event_idx   on public.event_orders (event_id, status);
create index event_orders_profile_idx on public.event_orders (profile_id, created_at desc);

comment on table public.event_orders is
  'BUY-04. What money was taken for a registration. A free registration has no order at all.';
comment on column public.event_orders.stripe_account_id is
  '§7.2. Which Stripe account actually took this payment. Frozen at checkout; every refund goes back through it. Never recomputed from the event.';
comment on column public.event_orders.application_fee_cents is
  '§7.1. Platform commission. Always 0 in this release — §13 excludes it — and kept as a column so switching it on is a value rather than a migration.';

-- ---------------------------------------------------------------------------
-- 4. event_refunds
--
-- BUY-09: the partial unique index is what stops the same money being sent
-- back twice. A failed refund falls out of the predicate so it can be retried;
-- a completed one never does.
--
-- 'needs_attention' is where a refund lands when Stripe said something we did
-- not plan for. It is a human's queue rather than a failure, because a silent
-- retry of an ambiguous refund is how money goes missing.
-- ---------------------------------------------------------------------------

create table public.event_refunds (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.event_orders (id) on delete cascade,
  amount_cents     int not null,
  status           refund_status not null default 'requested',
  stripe_refund_id text,
  reason           text,
  requested_by     uuid references public.profiles (id) on delete set null,
  failure_message  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint event_refunds_amount_sane check (amount_cents > 0)
);

create unique index event_refunds_live_key
  on public.event_refunds (order_id)
  where status in ('requested', 'processing', 'completed');

create index event_refunds_order_idx on public.event_refunds (order_id, created_at desc);

comment on table public.event_refunds is
  'BUY-09. Money going back. At most one live refund per order, so the same payment is never returned twice.';

-- ---------------------------------------------------------------------------
-- 5. event_tickets
--
-- One ticket per registration, issued by trigger the moment the registration
-- is confirmed — free or paid, both roads lead here, so nothing has to
-- remember to call an issue function (BUY-10).
--
-- The code is sixteen random bytes, not a derivation of anything. QLT-05: a
-- ticket code that can be worked out from an event id and an email address is
-- a free ticket for anybody who can count.
--
-- revoked_at and replaced_by exist for BUY-11, reissuing a ticket: the old
-- code stops scanning and points at the new one, so a door can say "this
-- ticket was replaced" rather than "invalid".
-- ---------------------------------------------------------------------------

create table public.event_tickets (
  id              uuid primary key default gen_random_uuid(),
  registration_id uuid not null unique references public.event_registrations (id) on delete cascade,
  event_id        uuid not null references public.events (id)   on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  code            text not null unique,
  revoked_at      timestamptz,
  replaced_by     uuid references public.event_tickets (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index event_tickets_event_idx   on public.event_tickets (event_id);
create index event_tickets_profile_idx on public.event_tickets (profile_id);

comment on table public.event_tickets is
  'BUY-10. What the QR encodes. One per registration, issued on confirmation, code unguessable (QLT-05).';

-- ---------------------------------------------------------------------------
-- 6. Capacity — BUY-05
--
-- The race is real and it is not theoretical: two people tap "register" on the
-- last place within the same second, both count 49 of 50, both insert, and the
-- room is over-sold by one. Counting in application code cannot fix it and
-- neither can a check constraint, which cannot see other rows.
--
-- `select 1 from events ... for update` takes an exclusive lock on the event
-- row before the count. The second session blocks there until the first
-- commits, then counts a table that already contains the first insert and
-- refuses. Every registration for one event is serialised by that lock.
--
-- ponytail: one lock per event row; registrations for a single event
-- serialise. Fine at this scale — partition the count if one event ever sells
-- thousands.
--
-- Deliberately not enforced here: whether the event has finished. The legacy
-- backfill in 20260916000009 writes confirmed registrations for events that
-- ended months ago, and a past event with a real attendee is a fact rather
-- than a rule being broken. register_free() and event_capacity_state() are
-- where a live attendee is told the doors have shut.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_event_capacity()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_event public.events%rowtype;
  v_taken int;
  v_cap   int;
begin
  -- Only a row that takes a place is interesting. Cancelling and expiring give
  -- one back, and nothing needs locking to give something back.
  if new.status not in ('pending', 'confirmed') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('pending', 'confirmed') then
    return new;
  end if;

  select * into v_event from public.events where id = new.event_id for update;

  if not found then
    raise exception 'That event no longer exists.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'This event has been cancelled.';
  end if;
  if v_event.status <> 'published' then
    raise exception 'This event is not open for registration.';
  end if;
  if v_event.registration_closed then
    raise exception 'Registration for this event is closed.';
  end if;

  if v_event.capacity is not null then
    select count(*) into v_taken
      from public.event_registrations r
     where r.event_id = new.event_id
       and r.id <> new.id
       and (r.status = 'confirmed'
            or (r.status = 'pending'
                and (r.hold_expires_at is null or r.hold_expires_at > now())));

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
         and r.status in ('pending', 'confirmed');

      if v_taken >= v_cap then
        raise exception 'That ticket option is sold out.';
      end if;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_event_capacity() is
  'BUY-05. Locks the event row before counting, so two people cannot both take the last place.';

create trigger trg_enforce_event_capacity
  before insert or update on public.event_registrations
  for each row execute function public.enforce_event_capacity();

-- ---------------------------------------------------------------------------
-- 7. Holds that lapsed
--
-- BUY-06. An abandoned checkout must not keep somebody's place forever, and
-- the live-registration unique index means a stale hold would also stop that
-- same person ever trying again. Scoped to one event and called at the top of
-- register_free(), so the common path sweeps itself and there is no cron job
-- to forget about.
--
-- ponytail: swept lazily on demand. If an event is quiet enough that nobody
-- registers for a day, its stale holds sit there a day — harmless, since the
-- count already ignores them. Schedule it if a sold-out event ever needs its
-- places back faster than the next attempt.
-- ---------------------------------------------------------------------------

create or replace function public.expire_event_holds(p_event uuid default null)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_count int;
begin
  update public.event_registrations
  set status = 'expired'
  where status = 'pending'
    and hold_expires_at is not null
    and hold_expires_at <= now()
    and (p_event is null or event_id = p_event);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.expire_event_holds(uuid) is
  'BUY-06. Releases checkout holds whose twenty minutes are up. Safe for anyone to call at any time.';

-- ---------------------------------------------------------------------------
-- 8. Issuing the ticket, and telling the hosts
--
-- On the transition into 'confirmed', from either road: register_free() for a
-- free place, the Stripe webhook for a paid one. Putting it in a trigger
-- rather than in both callers is what makes it impossible for a confirmed
-- registration to exist without a ticket.
--
-- on conflict do nothing because registration_id is unique: a registration
-- that is cancelled and later confirmed again keeps its original ticket rather
-- than acquiring a second one.
-- ---------------------------------------------------------------------------

create or replace function public.issue_ticket_on_confirm()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_host uuid;
begin
  if new.status <> 'confirmed' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'confirmed' then
    return null;
  end if;

  insert into public.event_tickets (registration_id, event_id, profile_id, code)
  values (
    new.id, new.event_id, new.profile_id,
    encode(extensions.gen_random_bytes(16), 'hex')
  )
  on conflict (registration_id) do nothing;

  -- The same shape as the RSVP notice this replaces: every host hears, and
  -- nobody hears about themselves.
  for v_host in select h.profile_id from public.event_host_ids(new.event_id) h loop
    if v_host <> new.profile_id then
      insert into public.notifications (profile_id, kind, actor_id, event_id)
      values (v_host, 'event_registered', new.profile_id, new.event_id);
    end if;
  end loop;

  return null;
end;
$$;

comment on function public.issue_ticket_on_confirm() is
  'BUY-10. Every confirmed registration gets exactly one ticket, whichever road confirmed it, and the hosts hear about it.';

create trigger trg_issue_ticket_on_confirm
  after insert or update on public.event_registrations
  for each row execute function public.issue_ticket_on_confirm();

-- A place that has been given up should not still scan at the door.
create or replace function public.revoke_ticket_on_cancel()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status in ('cancelled', 'expired')
     and old.status not in ('cancelled', 'expired')
  then
    update public.event_tickets
    set revoked_at = coalesce(revoked_at, now())
    where registration_id = new.id;
  end if;
  return null;
end;
$$;

comment on function public.revoke_ticket_on_cancel() is
  'ATT-02. A cancelled or expired registration''s ticket stops scanning, so the door says "cancelled" rather than "welcome".';

create trigger trg_revoke_ticket_on_cancel
  after update on public.event_registrations
  for each row execute function public.revoke_ticket_on_cancel();

-- ---------------------------------------------------------------------------
-- 9. §7.2 — the first paid order freezes the routing
--
-- Set here rather than in the checkout function because only the webhook knows
-- a payment actually completed, and the answer must be the same however the
-- order reached 'paid'. enforce_event_lifecycle() is what then refuses to move
-- the money.
-- ---------------------------------------------------------------------------

create or replace function public.lock_event_payment_on_paid()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'paid' and new.amount_cents > 0 then
    update public.events
    set payment_locked_at = now()
    where id = new.event_id and payment_locked_at is null;
  end if;
  return null;
end;
$$;

comment on function public.lock_event_payment_on_paid() is
  '§7.2. Stamps events.payment_locked_at when the first real payment lands. Revenue for tickets already sold cannot then be retargeted.';

create trigger trg_lock_event_payment_on_paid
  after insert or update on public.event_orders
  for each row execute function public.lock_event_payment_on_paid();

-- ---------------------------------------------------------------------------
-- 10. event_capacity_state — one answer, for every screen
--
-- ORG-03A. Five words, and the order they are tested in is the whole point: a
-- cancelled event is cancelled even if it also sold out, and a finished one is
-- finished even if places remained. The state an attendee needs to read is the
-- one that explains why they cannot register, not the first one that happens
-- to be true.
--
-- `confirmed` is strictly confirmed places, because that is the number an
-- organiser puts on a guest list. `remaining` also subtracts live checkout
-- holds, because that is the number a buyer needs — a held place is not on
-- sale, even though nobody has paid for it yet.
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
      count(*) filter (
        where r.status = 'confirmed'
           or (r.status = 'pending'
               and (r.hold_expires_at is null or r.hold_expires_at > now()))
      )::int as taken
    from public.event_registrations r
    where r.event_id = e.id
  ) c
  where e.id = p_event;
$$;

comment on function public.event_capacity_state(uuid) is
  'ORG-03A. capacity, confirmed, remaining, and one of open | sold_out | closed | cancelled | finished. The single definition every screen reads.';

-- ---------------------------------------------------------------------------
-- 11. event_availability
--
-- The same answer as a view, so a browse page can fetch a list of events and
-- their states in one request rather than one round trip per card.
-- security_invoker off and gated in the WHERE, exactly as member_directory and
-- event_public do it.
-- ---------------------------------------------------------------------------

create view public.event_availability
with (security_invoker = off) as
select
  e.id as event_id,
  e.slug,
  s.capacity,
  s.confirmed,
  s.remaining,
  s.state
from public.events e
cross join lateral public.event_capacity_state(e.id) s
where public.event_visible(e.id);

comment on view public.event_availability is
  'ORG-03A. Capacity and state per event, readable by anybody who can see the event itself.';

-- ---------------------------------------------------------------------------
-- 12. register_free — BUY-02
--
-- The free road. One function, so that "am I allowed", "is there room", "have
-- I already got a place" and "what did I agree to" are all answered inside one
-- transaction under one lock, rather than in four requests from a browser that
-- may stop after the second.
--
-- Paid registration does not come through here: it goes through
-- stripe-checkout, which writes a pending row and lets the webhook confirm it.
-- Both end up in the same table under the same capacity trigger.
-- ---------------------------------------------------------------------------

create or replace function public.register_free(p_event uuid, p_ticket_type uuid default null)
returns public.event_registrations
language plpgsql security definer set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_event public.events%rowtype;
  v_type  public.ticket_types%rowtype;
  v_state text;
  v_row   public.event_registrations%rowtype;
begin
  if v_me is null then
    raise exception 'You must be signed in to register.';
  end if;
  if not public.has_account() then
    raise exception 'Your account cannot register for events.';
  end if;

  perform public.expire_event_holds(p_event);

  select * into v_event from public.events where id = p_event;
  if not found or not public.event_visible(p_event) then
    raise exception 'We could not find that event.';
  end if;

  -- Which option. Given one, it must belong to this event, be on sale, and be
  -- free. Given none, the event must not have a paid option that the caller is
  -- quietly stepping past.
  if p_ticket_type is not null then
    select * into v_type from public.ticket_types
     where id = p_ticket_type and event_id = p_event and is_active;
    if not found then
      raise exception 'That ticket is not available for this event.';
    end if;
    if v_type.price_cents > 0 then
      raise exception 'That ticket has to be paid for.';
    end if;
  elsif exists (select 1 from public.ticket_types t
                 where t.event_id = p_event and t.is_active) then
    select * into v_type from public.ticket_types
     where event_id = p_event and is_active and price_cents = 0
     order by position, created_at
     limit 1;
    if not found then
      raise exception 'This event has no free tickets.';
    end if;
  end if;

  if exists (select 1 from public.event_registrations r
              where r.event_id = p_event and r.profile_id = v_me
                and r.status in ('pending', 'confirmed'))
  then
    raise exception 'You already have a place at this event.';
  end if;

  select s.state into v_state from public.event_capacity_state(p_event) s;
  if v_state <> 'open' then
    raise exception 'Registration is not open for this event (%).', v_state;
  end if;

  -- The capacity trigger is what actually decides this, under the event lock.
  -- The check above is the friendly answer; this insert is the true one.
  insert into public.event_registrations
    (event_id, profile_id, ticket_type_id, status, confirmed_at, terms_snapshot)
  values
    (p_event, v_me, v_type.id, 'confirmed', now(), v_event.refund_terms)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.register_free(uuid, uuid) is
  'BUY-02. Takes a free place under the capacity lock and issues the ticket. Refuses a paid ticket type: that road is stripe-checkout.';

-- ---------------------------------------------------------------------------
-- 13. cancel_registration — BUY-08
--
-- Gives the place back and revokes the ticket, and does not touch money.
-- Whether a refund is due is a separate decision with separate terms (BUY-15)
-- and a separate function in the payments workstream. Conflating them is how
-- somebody ends up told they have been refunded when they have not.
-- ---------------------------------------------------------------------------

create or replace function public.cancel_registration(p_registration uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.event_registrations%rowtype;
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_row from public.event_registrations where id = p_registration;
  if not found then
    raise exception 'We could not find that registration.';
  end if;

  if not (v_row.profile_id = v_me
          or public.hosts_event(v_row.event_id)
          or public.is_admin())
  then
    raise exception 'That is not your registration.';
  end if;

  -- Cancelling twice is not an error, it is the same outcome.
  if v_row.status in ('cancelled', 'expired') then
    return;
  end if;

  update public.event_registrations
  set status       = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_me
  where id = p_registration;
end;
$$;

comment on function public.cancel_registration(uuid) is
  'BUY-08. Releases the place and revokes the ticket. Says nothing about money — a refund is a separate decision with its own terms.';

-- ---------------------------------------------------------------------------
-- 14. Row level security
--
-- ticket_types are as visible as their event, so a public page can price
-- itself. Everything else is own rows, plus the hosts, plus an admin.
--
-- Orders, refunds and tickets have no write policy at all. They are written by
-- the definer functions above and by the Stripe webhook on the service role,
-- which is the only thing that knows a payment happened. A browser that could
-- insert a paid order is a browser that could grant itself a ticket.
-- ---------------------------------------------------------------------------

alter table public.ticket_types        enable row level security;
alter table public.event_registrations enable row level security;
alter table public.event_orders        enable row level security;
alter table public.event_refunds       enable row level security;
alter table public.event_tickets       enable row level security;

create policy ticket_types_select on public.ticket_types for select to anon, authenticated
using (public.event_visible(event_id));

create policy ticket_types_insert on public.ticket_types for insert to authenticated
with check (public.hosts_event(event_id) or public.is_admin());

create policy ticket_types_update on public.ticket_types for update to authenticated
using (public.hosts_event(event_id) or public.is_admin())
with check (public.hosts_event(event_id) or public.is_admin());

create policy ticket_types_delete on public.ticket_types for delete to authenticated
using (public.hosts_event(event_id) or public.is_admin());

create policy event_registrations_select on public.event_registrations for select to authenticated
using (profile_id = auth.uid() or public.hosts_event(event_id) or public.is_admin());

-- For yourself, or for a guest if you run the event. The status clause on the
-- self branch is load-bearing: 'confirmed' is a statement that the money is
-- settled, and issue_ticket_on_confirm() turns it into a ticket. Without it,
-- `POST /event_registrations {status: 'confirmed'}` is a free ticket to a paid
-- event, which is BUY-04 undone by one request. A caller may hold a place;
-- only register_free() and the webhook may confirm one.
create policy event_registrations_insert on public.event_registrations for insert to authenticated
with check (
  public.has_account()
  and (
    (profile_id = auth.uid() and status = 'pending')
    or public.hosts_event(event_id)
    or public.is_admin()
  )
);

-- Hosts and admins only, for the same reason. An attendee moving their own
-- row from 'pending' to 'confirmed' is an attendee confirming their own
-- payment; the capacity trigger waves that update through as "the same seat"
-- and the ticket trigger issues on it. Attendees cancel through
-- cancel_registration(), which is SECURITY DEFINER and checks who is asking.
create policy event_registrations_update on public.event_registrations for update to authenticated
using (public.hosts_event(event_id) or public.is_admin())
with check (public.hosts_event(event_id) or public.is_admin());

create policy event_orders_select on public.event_orders for select to authenticated
using (profile_id = auth.uid() or public.hosts_event(event_id) or public.is_admin());

create policy event_refunds_select on public.event_refunds for select to authenticated
using (
  exists (
    select 1 from public.event_orders o
     where o.id = public.event_refunds.order_id
       and (o.profile_id = auth.uid() or public.hosts_event(o.event_id) or public.is_admin())
  )
);

create policy event_tickets_select on public.event_tickets for select to authenticated
using (profile_id = auth.uid() or public.hosts_event(event_id) or public.is_admin());

-- ---------------------------------------------------------------------------
-- 15. Audit
--
-- terms_snapshot and the ticket code are skipped: one is a long copy of text
-- that already exists on the event, the other is a credential, and the
-- activity log is not a place to keep credentials even behind is_admin().
-- ---------------------------------------------------------------------------

create trigger log_ticket_types
  after insert or update or delete on public.ticket_types
  for each row execute function public.log_activity();

create trigger log_event_registrations
  after insert or update or delete on public.event_registrations
  for each row execute function public.log_activity('terms_snapshot');

create trigger log_event_orders
  after insert or update or delete on public.event_orders
  for each row execute function public.log_activity('terms_snapshot');

create trigger log_event_refunds
  after insert or update or delete on public.event_refunds
  for each row execute function public.log_activity('failure_message');

create trigger log_event_tickets
  after insert or update or delete on public.event_tickets
  for each row execute function public.log_activity('code');

-- ---------------------------------------------------------------------------
-- 16. Grants
--
-- anon reads prices and availability, because the public event page has to
-- show both before anybody signs in. It reads nothing else here.
-- ---------------------------------------------------------------------------

grant select on public.ticket_types       to anon, authenticated;
grant select on public.event_availability to anon, authenticated;

grant insert, update, delete on public.ticket_types        to authenticated;
grant select, insert, update on public.event_registrations to authenticated;
grant select on public.event_orders  to authenticated;
grant select on public.event_refunds to authenticated;
grant select on public.event_tickets to authenticated;

grant execute on function public.event_capacity_state(uuid) to anon, authenticated;
grant execute on function public.expire_event_holds(uuid)   to authenticated;
grant execute on function public.register_free(uuid, uuid)  to authenticated;
grant execute on function public.cancel_registration(uuid)  to authenticated;
