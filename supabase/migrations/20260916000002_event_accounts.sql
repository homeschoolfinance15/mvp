-- ============================================================================
-- Two kinds of account, and who may put an event on sale
--
-- Until now is_member() meant "holds a profile that has not been suspended",
-- and that one answer gated the feed, the circle, the member directory and
-- every profile answer in the system. It was correct while the only way to
-- get a profile was to redeem a connector's invite code.
--
-- The event platform breaks that assumption. Somebody buying a ticket to a
-- public event needs an account — a ticket, an order, a refund and a feedback
-- form all belong to a person — but they were never invited into the network
-- and must not walk into the members' feed on the way to their ticket
-- (ACC-05). They have a profile, so under the old definition they were a
-- member.
--
-- So the gate splits in two:
--
--   has_account()  profile exists, not suspended or removed
--                  -> events, tickets, orders, attendance, feedback
--   is_member()    has_account() AND profiles.network_member
--                  -> everything it gated before, unchanged
--
-- The column defaults to true and every existing row gets it, so is_member()
-- answers exactly what it answered yesterday for everybody who already has an
-- account (QLT-06). Only event signup writes false.
--
-- ACC-06: a ticket buyer who is later invited into the network properly keeps
-- the same profile row. Redeeming a code flips the flag rather than making a
-- second person with the same face.
--
-- The second half of this file is hosting permission. Two questions that look
-- like one and are not (ORG-01C):
--
--   may_create_events(p)  admin, or a connector an admin has switched on
--                         -> checked creating a draft, and at first publish
--   may_host_events(p)    admin, or any connector (unchanged)
--                         -> checked when somebody is named a host
--
-- Switching the permission off stops new events. It does not reach into an
-- event already running and lock its organiser out of their own guest list.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles.network_member
--
-- not null default true does the backfill: every existing row is a network
-- member from the instant the column exists, and there is no window in which
-- is_member() is redefined against nulls.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column network_member boolean not null default true;

comment on column public.profiles.network_member is
  'ACC-01. True for someone invited into the network. False for an event-only account: a real person with a real profile who may buy a ticket and nothing else.';

-- Partial, because the interesting set is the small one. Nobody ever asks for
-- every network member; admins ask which accounts arrived through an event.
create index profiles_event_only_idx on public.profiles (created_at desc)
  where network_member = false;

-- ---------------------------------------------------------------------------
-- 2. The two gates
-- ---------------------------------------------------------------------------

create or replace function public.has_account()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and profile_status not in ('suspended', 'removed')
  );
$$;

comment on function public.has_account() is
  'ACC-01. True for anyone holding a live profile, network member or event-only. The read gate for event surfaces: events, tickets, orders, attendance, feedback.';

-- The body is has_account() with one more condition rather than a call to it,
-- so this stays a single exists() the planner can inline into a policy.
-- Behaviour for every existing row is identical to before.
create or replace function public.is_member()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and profile_status not in ('suspended', 'removed')
      and network_member
  );
$$;

comment on function public.is_member() is
  'True for anyone invited into the network whose profile has not been suspended or removed. The read gate for every members-only surface. An event-only account is not a member.';

-- ---------------------------------------------------------------------------
-- 2a. Onboarding — BUY-01
--
-- "A visitor must create an account or sign in and finish required onboarding
-- before completing event registration. This applies to free and paid
-- events." Today that is enforced by a route guard, which makes it true for
-- people who use our interface and false for anybody who calls the API.
--
-- What counts as *required* onboarding for registering is the question, and
-- the answer is narrower than the network's onboarding. The client has two
-- gates, and only the first one belongs here:
--
--   needsOnboarding      no current_profession. Everybody who is not an
--                        admin answers this, event-only accounts included.
--   needsQuestionnaire   profile_answers.completed_at is null, for role
--                        'user'. This is network curation — it is what makes
--                        somebody matchable to other members.
--
-- The questionnaire cannot be part of the registration gate, because ACC-02
-- says a ticket buyer never joins a network and therefore never answers it.
-- Requiring it would make buying a ticket impossible for exactly the people
-- the event platform exists to serve. So: a name and a profession, which is
-- what the /onboarding step collects, and nothing else.
--
-- ponytail: mirrors needsOnboarding rather than replacing it. If the rule ever
-- grows a third condition, this function is the one that should hold it and
-- the client should ask it, rather than the two drifting apart.
-- ---------------------------------------------------------------------------

create or replace function public.onboarding_complete(p_profile uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_profile
       and p.profile_status not in ('suspended', 'removed')
       and (p.role = 'admin' or btrim(coalesce(p.current_profession, '')) <> '')
  );
$$;

comment on function public.onboarding_complete(uuid) is
  'BUY-01. Whether that person has finished the onboarding required before registering for an event: a profession, or being an admin. Deliberately not the network questionnaire — an event-only account never answers it (ACC-02).';

-- ---------------------------------------------------------------------------
-- 3. network_member is not a field you may edit
--
-- profiles_update lets anybody write their own row, and protect_profile_fields
-- is what stops that being a way to become an admin. network_member joins that
-- list: without it, an event-only account could PATCH itself into the members'
-- feed, which is ACC-05 undone by one HTTP request.
--
-- redeem_code is the one legitimate writer and announces itself with a
-- transaction-local setting. PostgREST cannot call set_config() — only
-- functions in the exposed schema are reachable — so the only way to raise
-- this flag is from inside the redemption function.
--
-- ponytail: one shared setting name. A second function needing the same
-- exemption gets its own name rather than widening this one.
-- ---------------------------------------------------------------------------

create or replace function public.protect_profile_fields()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;
  new.id             := old.id;
  new.role           := old.role;
  new.profile_status := old.profile_status;
  new.created_at     := old.created_at;
  if coalesce(current_setting('amazing.redeeming_code', true), '') <> 'on' then
    new.network_member := old.network_member;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Event-only signup (ACC-02)
--
-- The counterpart to redeem_code for somebody who has no code and wants a
-- ticket. Called immediately after auth.signUp as the freshly created user,
-- exactly as redeem_code is. It is the only place a network_member = false
-- row is ever created.
-- ---------------------------------------------------------------------------

create or replace function public.create_event_account(p_full_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to set up an account.';
  end if;
  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'A name is required.';
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'This account is already set up.';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.profiles (id, role, full_name, email, profile_status, network_member)
  values (v_uid, 'user', trim(p_full_name), v_email, 'active', false);

  return jsonb_build_object('role', 'user', 'network_member', false);
end;
$$;

comment on function public.create_event_account(text) is
  'ACC-02. Turns a bare auth account into an event-only profile. No invite code, no network access, and no second row when they are later invited properly.';

-- ---------------------------------------------------------------------------
-- 5. redeem_code — ACC-06
--
-- Unchanged except for one branch. It used to refuse outright if a profile
-- already existed, which was right while the only profiles were members'. An
-- event-only account redeeming an invite code is now the case that matters:
-- the same person, upgraded in place, keeping their tickets, their orders and
-- the feedback they have already given.
--
-- A connector claim code still needs a fresh account. That path hands out a
-- role, and role is pinned by protect_profile_fields for good reasons — an
-- admin makes somebody a connector, not a claim code they were sent.
-- ---------------------------------------------------------------------------

create or replace function public.redeem_code(p_code text, p_full_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_email        text;
  v_existing     public.profiles%rowtype;
  v_invitation   public.connector_invitations%rowtype;
  v_code         public.invite_codes%rowtype;
  v_connector    public.connectors%rowtype;
  v_connector_id uuid;
  v_new_code     varchar;
begin
  if v_uid is null then
    raise exception 'You must be signed in to redeem a code.';
  end if;

  select * into v_existing from public.profiles where id = v_uid;

  -- Already in the network: there is nothing left to redeem. Only the
  -- event-only case carries on past here.
  if found and v_existing.network_member then
    raise exception 'This account is already set up.';
  end if;

  select email into v_email from auth.users where id = v_uid;

  -- Path A: a connector claiming the account an admin created for them.
  select * into v_invitation
  from public.connector_invitations
  where upper(claim_code) = upper(trim(p_code))
  for update;

  if found then
    if v_invitation.claimed_at is not null then
      raise exception 'This claim code has already been used.';
    end if;
    if v_existing.id is not null then
      raise exception 'This account is already set up.';
    end if;

    insert into public.profiles (id, role, full_name, email, profile_status)
    values (
      v_uid, 'connector',
      coalesce(nullif(trim(p_full_name), ''), v_invitation.full_name),
      v_email, 'active'
    );

    insert into public.connectors (profile_id, invite_status, invite_capacity)
    values (v_uid, 'active', v_invitation.invite_capacity)
    returning id into v_connector_id;

    loop
      v_new_code := public.generate_code('AMZ');
      exit when not exists (select 1 from public.invite_codes where code = v_new_code);
    end loop;

    insert into public.invite_codes (connector_id, code, status, max_uses, use_count)
    values (v_connector_id, v_new_code, 'active',
            greatest(v_invitation.invite_capacity, 1), 0);

    update public.connector_invitations
    set claimed_at = now(), claimed_by = v_uid
    where id = v_invitation.id;

    return jsonb_build_object('role', 'connector',
                              'connector_id', v_connector_id,
                              'invite_code', v_new_code);
  end if;

  -- Path B: a member joining on a connector's invite code.
  select * into v_code
  from public.invite_codes
  where upper(code) = upper(trim(p_code))
  for update;

  if not found then
    raise exception 'We don''t recognise that code.';
  end if;

  select * into v_connector from public.connectors where id = v_code.connector_id;

  if v_code.status <> 'active' then
    raise exception 'This invitation code is no longer active.';
  end if;
  if v_code.use_count >= v_code.max_uses then
    raise exception 'This invitation code has been fully used.';
  end if;
  if v_connector.invite_status <> 'active' then
    raise exception 'This connector is not currently inviting.';
  end if;

  if v_existing.id is null then
    insert into public.profiles (id, role, full_name, email, profile_status)
    values (v_uid, 'user', trim(p_full_name), v_email, 'active');
  else
    -- ACC-06. The same person, now let in properly. Their name is overwritten
    -- only if they gave one; their tickets and orders are untouched.
    perform set_config('amazing.redeeming_code', 'on', true);
    update public.profiles
    set network_member = true,
        full_name      = coalesce(nullif(trim(p_full_name), ''), full_name)
    where id = v_uid;
    perform set_config('amazing.redeeming_code', 'off', true);
  end if;

  insert into public.connector_user_links (connector_id, user_profile_id, invite_code_id)
  values (v_code.connector_id, v_uid, v_code.id);

  update public.invite_codes
  set use_count = use_count + 1,
      status = case
                 when use_count + 1 >= max_uses then 'exhausted'::invite_status
                 else status
               end
  where id = v_code.id;

  return jsonb_build_object('role', 'user', 'connector_id', v_code.connector_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Hosting permission on the connector row
--
-- Defaults to false: nobody gains the ability to sell tickets because a
-- migration ran. An admin grants it deliberately, and the two audit columns
-- record who and when, because "who let them charge for that" is the first
-- question anybody will ask.
--
-- The Stripe Connect block lives here too (§7.1). What we hold is an account
-- id and a cache of what Stripe last told us about it — never a secret key,
-- never a connector-owned webhook. Charges are direct charges on their
-- account, so their balance, their fees, their disputes, their refunds.
--
-- Null stripe_account_id means this connector's events take money through
-- Amazing's own account (BUY-13).
--
-- No new policy: connectors_update is already admin-only, which is exactly
-- ORG-01B. A connector completing their own Stripe onboarding does it through
-- the payments edge function on the service role, not by PATCHing this row.
-- ---------------------------------------------------------------------------

alter table public.connectors
  add column can_create_events            boolean not null default false,
  add column events_permission_changed_by uuid references public.profiles (id) on delete set null,
  add column events_permission_changed_at timestamptz,
  add column stripe_account_id            text,
  add column stripe_connected_at          timestamptz,
  add column stripe_charges_enabled       boolean not null default false,
  add column stripe_payouts_enabled       boolean not null default false,
  add column stripe_account_status        text not null default 'none',
  add column stripe_checked_at            timestamptz;

alter table public.connectors
  add constraint connectors_stripe_status_known
    check (stripe_account_status in
           ('none', 'pending', 'ready', 'restricted', 'disconnected'));

comment on column public.connectors.can_create_events is
  'ORG-01A. Whether this connector may create events. Gates creation and first publish only, never the management of an event they already run (ORG-01C).';
comment on column public.connectors.events_permission_changed_by is
  'ORG-01B. Which admin last moved can_create_events. Stamped by trigger, never by the caller.';
comment on column public.connectors.stripe_account_id is
  'BUY-14. The Stripe connected account their events are paid into. Null means Amazing''s own account.';
comment on column public.connectors.stripe_charges_enabled is
  '§7.3. What Stripe last said about this account taking money. False blocks new paid sales and nothing else — existing bookings, tickets and refunds carry on.';
comment on column public.connectors.stripe_account_status is
  'none | pending | ready | restricted | disconnected. A cache of Stripe''s answer, refreshed at stripe_checked_at. Stripe is the authority; this is what we can show without a round trip.';

-- Stamped by the database rather than by whoever wrote the update, so it
-- cannot be forgotten at a call site or backdated from a client.
create or replace function public.stamp_events_permission()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.can_create_events is distinct from old.can_create_events then
    new.events_permission_changed_by := auth.uid();
    new.events_permission_changed_at := now();
  end if;
  return new;
end;
$$;

comment on function public.stamp_events_permission() is
  'ORG-01B. Records who switched a connector''s event permission and when.';

create trigger trg_stamp_events_permission
  before update on public.connectors
  for each row execute function public.stamp_events_permission();

create or replace function public.may_create_events(p_profile uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
      from public.profiles p
      left join public.connectors c on c.profile_id = p.id
     where p.id = p_profile
       and p.profile_status = 'active'
       and (p.role = 'admin' or (c.id is not null and c.can_create_events))
  );
$$;

comment on function public.may_create_events(uuid) is
  'ORG-01A. True for an admin, or a connector an admin has switched on. Asked when an event is created and when it is published for the first time, and never again after that (ORG-01C).';

-- ---------------------------------------------------------------------------
-- 7. May money actually change hands (§7.3)
--
-- Asked of the account the event's money is routed to, not of the caller.
-- Null is Amazing's own Stripe account (BUY-13): the platform is configured
-- or it is not, and that is a deployment question rather than a row in this
-- table, so null answers true and the edge function fails loudly if the
-- platform key is missing.
--
-- charges_enabled is the only thing that matters. payouts_enabled can be
-- false for a week while Stripe verifies a bank account, and refusing to sell
-- tickets over that would be wrong — the money is safely in their balance
-- either way.
--
-- This gates *new* paid sales only. It is deliberately not consulted by
-- refunds, tickets, check-in or anything else an existing attendee touches:
-- losing payment capability must never strand somebody who already paid
-- (BUY-14, §7.3 last row).
-- ---------------------------------------------------------------------------

create or replace function public.may_sell_paid_events(p_connector uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
           when p_connector is null then true
           else exists (
             select 1 from public.connectors c
              where c.id = p_connector
                and c.stripe_account_id is not null
                and c.stripe_charges_enabled
           )
         end;
$$;

comment on function public.may_sell_paid_events(uuid) is
  '§7.3. Whether paid tickets may go on sale against that payment account. Null connector means Amazing''s own Stripe. Free events never ask this.';

-- ---------------------------------------------------------------------------
-- 8. Grants
--
-- has_account() and may_create_events() are granted to anon as well. An
-- anonymous visitor on a public event page evaluates the same policies a
-- signed-in one does, and a policy that cannot execute its own gate fails the
-- whole query rather than quietly returning false.
-- ---------------------------------------------------------------------------

grant execute on function public.has_account()               to anon, authenticated;
grant execute on function public.onboarding_complete(uuid)   to anon, authenticated;
grant execute on function public.may_create_events(uuid)     to anon, authenticated;
grant execute on function public.may_sell_paid_events(uuid)  to anon, authenticated;
grant execute on function public.create_event_account(text)  to authenticated;
