-- ============================================================================
-- Events, extended — never replaced
--
-- public.events already holds live rows that members can see and hosts can
-- edit. Everything below is added alongside; not one existing column moves.
--
-- Three things change in how an event behaves:
--
--   1. It has a lifecycle. draft -> published -> (cancelled). Every row that
--      exists today is published, because it was visible to the whole network
--      the moment it was written and pretending otherwise would hide it.
--      "Finished" is not in the enum: it is ends_at and the clock, and a
--      status somebody has to remember to set is a status that is wrong.
--
--   2. It has a slug, and therefore a link that works without an account
--      (EVT-01). The slug carries a random suffix, so a draft's URL cannot be
--      guessed from its title before the host is ready to share it.
--
--   3. It is readable by anon when published. This is the big one. The old
--      policy was `using (is_member())` — the whole point of a public event
--      page is that it is not. Drafts stay host-only (ORG-02).
--
-- ORG-01C is the subtle rule in this file and it is enforced in a trigger,
-- not in a policy. may_create_events gates creating a draft and the *first*
-- publish. events_update is left exactly as the co-host migration wrote it,
-- so switching a connector's permission off never locks them out of an event
-- they are already running: they keep editing, inviting, checking people in
-- and issuing refunds. They simply cannot start another one.
-- ============================================================================

-- Slugs and ticket codes both want random bytes. Supabase ships pgcrypto in
-- the extensions schema; this is here so a bare project does not fail three
-- migrations later on a missing function.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. The new columns
-- ---------------------------------------------------------------------------

alter table public.events
  add column status                event_status not null default 'draft',
  add column slug                  text,
  add column timezone              text not null default 'Europe/London',
  add column venue_name            varchar,
  add column address               text,
  add column attendee_instructions text,
  add column refund_terms          text,
  add column capacity              int,
  add column registration_closed   boolean not null default false,
  add column currency              char(3) not null default 'gbp',
  add column payment_connector_id  uuid references public.connectors (id) on delete set null,
  add column payment_recipient_id  uuid references public.profiles (id)   on delete set null,
  add column payment_locked_at     timestamptz,
  add column published_at          timestamptz,
  add column cancelled_at          timestamptz,
  add column cancelled_by          uuid references public.profiles (id) on delete set null,
  add column feedback_opens_after_minutes int not null default 120;

alter table public.events
  add constraint events_capacity_sane
    check (capacity is null or capacity > 0),
  add constraint events_feedback_delay_sane
    check (feedback_opens_after_minutes between 0 and 20160);

comment on column public.events.status is
  'draft | published | cancelled. Finished is derived from ends_at, never stored.';
comment on column public.events.capacity is
  'ORG-03. Null is unlimited. Every ticket type on the event shares this one number.';
comment on column public.events.registration_closed is
  'ORG-03A. The organiser stopping sales early. Deliberately not the same fact as selling out, because an attendee reads the two very differently.';
comment on column public.events.payment_connector_id is
  'BUY-14, §7.0. Whose Stripe account this event''s money lands in. Resolved from the creator on insert. Null is Amazing''s own account (BUY-13).';
comment on column public.events.payment_recipient_id is
  'BUY-14. One recipient for the money. Never a split — a split is an accounting argument nobody wants at refund time.';
comment on column public.events.payment_locked_at is
  '§7.2. Stamped when the first paid order exists. After that the payment recipient is immutable: revenue for tickets already sold cannot be retargeted.';
comment on column public.events.feedback_opens_after_minutes is
  'FDB-15. How long after the event ends the feedback form opens. Editable per event.';

-- ---------------------------------------------------------------------------
-- 2. Existing rows are published
--
-- They were network-visible before this migration and must stay that way
-- (QLT-06). published_at is their creation time rather than now(): the event
-- was public from the day it was written, and stamping today would make every
-- existing event look freshly announced to anything sorting by it.
-- ---------------------------------------------------------------------------

update public.events
set status       = 'published',
    published_at = created_at;

-- ---------------------------------------------------------------------------
-- 3. Slugs
--
-- The suffix is always appended, never only on collision. It settles
-- uniqueness without a retry dance, and it keeps a draft's URL from being
-- derivable from its title — ORG-02 is a weak promise if /e/summer-dinner
-- resolves the moment somebody guesses the name.
-- ---------------------------------------------------------------------------

create or replace function public.generate_event_slug(p_title text)
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_base text;
  v_slug text;
begin
  v_base := btrim(regexp_replace(lower(coalesce(p_title, '')), '[^a-z0-9]+', '-', 'g'), '-');
  v_base := left(v_base, 60);
  if v_base = '' then
    v_base := 'event';
  end if;

  loop
    v_slug := v_base || '-' || encode(extensions.gen_random_bytes(3), 'hex');
    exit when not exists (select 1 from public.events where slug = v_slug);
  end loop;

  return v_slug;
end;
$$;

comment on function public.generate_event_slug(text) is
  'EVT-01. A readable, unguessable path segment for an event. Always carries a random suffix.';

do $$
declare
  r record;
begin
  for r in select id, title from public.events where slug is null loop
    update public.events set slug = public.generate_event_slug(r.title) where id = r.id;
  end loop;
end;
$$;

alter table public.events alter column slug set not null;
create unique index events_slug_key on public.events (slug);

create index events_status_starts_idx on public.events (status, starts_at);

-- ---------------------------------------------------------------------------
-- 4. The lifecycle trigger
--
-- Rules that policies cannot express, because RLS can gate a row but cannot
-- compare it to the row it used to be.
--
--   ORG-01C  the first publish needs may_create_events; later ones do not,
--            so an organiser whose permission was withdrawn can still take
--            their own event down and put it back up.
--   ORG-09   cancelling stamps who and when, from the server.
--   EVT-01   a published slug is frozen. Somebody has already sent that link
--            to people who are not going to be told it changed.
--   §7.0     whoever created the event owns its money. Resolved once, on
--            insert, from host_id — the creator — and never from whoever
--            happens to be editing. Adding an admin as a co-host does not
--            move a connector's revenue to Amazing, and a connector
--            co-hosting an admin's event does not move Amazing's to them
--            (ORG-05: co-hosting creates no revenue split).
--   §7.2     once a paid order exists the routing is frozen. Tickets already
--            sold cannot have their revenue retargeted.
--   §7.3     paid tickets need a payment account that Stripe will actually
--            charge on. Free events are never blocked by payment setup.
--
-- The §7.3 check reads public.ticket_types, which 20260916000004 creates. A
-- plpgsql body is not resolved until it runs, and nothing publishes an event
-- between these two files, so the forward reference is safe. It lives here
-- because there should be exactly one function that knows what publishing
-- means.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_event_lifecycle()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_creator_connector uuid;
  v_has_paid_tickets  boolean;
begin
  if tg_op = 'INSERT' then
    if new.slug is null or btrim(new.slug) = '' then
      new.slug := public.generate_event_slug(new.title);
    end if;

    -- §7.0. A connector creator is paid on their own account, full stop —
    -- forced rather than defaulted, because otherwise the routing is a field
    -- in a form somebody can point elsewhere. An admin creator leaves it
    -- null, meaning Amazing's own account, and may name a different
    -- recipient explicitly: that is the one deliberate override, and BUY-14
    -- requires the screen to say so unmissably before sales open.
    select c.id into v_creator_connector
      from public.connectors c where c.profile_id = new.host_id;
    if v_creator_connector is not null then
      new.payment_connector_id := v_creator_connector;
    end if;

    -- Never trusted from a client: a row that arrived claiming to be locked
    -- would freeze routing that no money has been taken against yet.
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
    -- ORG-01C. old.published_at being null is what makes this the first
    -- publish; after that the event is theirs to run however many times they
    -- toggle it.
    if old.published_at is null
       and not (public.may_create_events(auth.uid()) or public.is_admin())
    then
      raise exception 'You do not have permission to publish events.';
    end if;

    -- §7.3. Asked at every publish, not only the first: an account can be
    -- restricted between one publish and the next, and the point of the gate
    -- is that a ticket is never sold that cannot be charged for.
    select exists (
      select 1 from public.ticket_types t
       where t.event_id = new.id and t.is_active and t.price_cents > 0
    ) into v_has_paid_tickets;

    if v_has_paid_tickets and not public.may_sell_paid_events(new.payment_connector_id) then
      raise exception
        'Connect a Stripe account that can take payments before publishing an event with paid tickets.';
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
  'ORG-01C, ORG-09, EVT-01, §7.0/§7.2/§7.3. Fills the slug, routes the money from the creator, freezes routing once tickets are sold, gates publishing and stamps a cancellation.';

create trigger trg_enforce_event_lifecycle
  before insert or update on public.events
  for each row execute function public.enforce_event_lifecycle();

-- ---------------------------------------------------------------------------
-- 5. Row level security
--
-- events_select is replaced outright: the old rule was is_member(), and a
-- public event page has no member to ask. Drafts remain invisible to everyone
-- but their hosts and admins (ORG-02). A cancelled event stays readable — the
-- people who were coming need the page to still say what happened.
--
-- events_insert moves from can_host_events() to may_create_events() (ORG-01A).
--
-- events_update and events_delete are deliberately untouched. Read the header.
-- ---------------------------------------------------------------------------

-- One sentence, one definition. Ticket types, availability and the public
-- view all have to agree with this policy about what is visible, and three
-- copies of a boolean is three chances for one of them to drift open.
create or replace function public.event_visible(p_event uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.events e
     where e.id = p_event
       and (e.status in ('published', 'cancelled')
            or public.hosts_event(e.id)
            or public.is_admin())
  );
$$;

comment on function public.event_visible(uuid) is
  'EVT-01, ORG-02. Whether the caller may see that event at all. Published and cancelled events are public; a draft belongs to its hosts.';

drop policy events_select on public.events;
create policy events_select on public.events for select to anon, authenticated
using (
  status in ('published', 'cancelled')
  or public.hosts_event(id)
  or public.is_admin()
);

drop policy events_insert on public.events;
create policy events_insert on public.events for insert to authenticated
with check (public.may_create_events(auth.uid()) and host_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. event_public
--
-- The anon-readable face of an event: everything on the row, plus the names
-- of the people running it, and no email addresses anywhere.
--
-- security_invoker is off for the same reason member_directory turns it off —
-- the view runs as its owner so it can read the host names out of profiles
-- past profiles_select, and carries its own gate in the WHERE clause. That
-- gate is the same sentence as events_select, so the view can never show an
-- event the table would have hidden.
--
-- Capacity is not here; it is in event_availability in the next migration,
-- because it changes on every registration and this row does not.
-- ---------------------------------------------------------------------------

create view public.event_public
with (security_invoker = off) as
select
  e.id,
  e.host_id,
  e.title,
  e.description,
  e.location,
  e.starts_at,
  e.ends_at,
  e.cover_path,
  e.created_at,
  e.status,
  e.slug,
  e.timezone,
  e.venue_name,
  e.address,
  e.attendee_instructions,
  e.refund_terms,
  e.capacity,
  e.registration_closed,
  e.currency,
  e.payment_connector_id,
  e.payment_recipient_id,
  e.payment_locked_at,
  e.published_at,
  e.cancelled_at,
  e.cancelled_by,
  e.feedback_opens_after_minutes,
  (
    select coalesce(array_agg(p.full_name order by p.full_name), '{}'::text[])
    from public.event_host_ids(e.id) h
    join public.profiles p on p.id = h.profile_id
  ) as host_names
from public.events e
where public.event_visible(e.id);

comment on view public.event_public is
  'EVT-01. An event as an anonymous visitor sees it: the row plus host names. No email address is reachable through it.';

-- ---------------------------------------------------------------------------
-- 7. Grants
--
-- anon gets select on events itself as well as the view, because the public
-- page reads ticket types and availability by event_id and PostgREST resolves
-- those against the table. The policy above is what makes that safe.
--
-- DO NOT TIDY THE GRANTS BELOW. is_admin(), hosts_event() and
-- event_host_ids() being executable by anon reads like an over-grant and is
-- not one. events_select is evaluated for every caller including an anonymous
-- one, and its predicate calls all three. A role that may not execute a
-- function in a policy it is subject to gets an error from the whole query —
-- not false, not an empty result, a permission failure.
--
-- So revoking any of these does not narrow anything. It breaks every public
-- event page for logged-out visitors only, which is the hardest kind of
-- breakage to notice: signed in, everything still works.
--
-- Executing them leaks nothing either. is_admin() and hosts_event() both
-- answer about auth.uid(), which is null for anon, so both return false;
-- event_host_ids() returns the host ids of an event whose host names
-- event_public already shows the world.
-- ---------------------------------------------------------------------------

grant select on public.events       to anon;
grant select on public.event_public to anon, authenticated;

-- Called by events_select. See the note above before touching these three.
grant execute on function public.is_admin()                to anon;
grant execute on function public.hosts_event(uuid)         to anon;
grant execute on function public.event_host_ids(uuid)      to anon;
grant execute on function public.event_visible(uuid)       to anon, authenticated;
grant execute on function public.generate_event_slug(text) to authenticated;
