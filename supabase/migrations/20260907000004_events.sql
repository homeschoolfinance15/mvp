-- ============================================================================
-- Events
--
-- Luma semantics inside a private network: an event is visible to everyone
-- on the platform and anyone on the platform may RSVP. An invitation is a
-- nudge from the host, not a gate.
--
-- That is one fewer policy than invite-gated RSVP, and it is what the network
-- actually needs — discovery has to be open or nothing gets discovered. The
-- gate is the front door, not the event page: waitlist entries hold no auth
-- account and members are the only people past is_member().
--
-- Hosting is narrower: connectors and admins, as asked.
-- ============================================================================

create type rsvp_status as enum ('invited', 'going', 'declined');

-- ---------------------------------------------------------------------------
-- Who may put an event on the calendar
-- ---------------------------------------------------------------------------

create or replace function public.can_host_events()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.can_post()
     and (public.is_admin() or public.my_connector_id() is not null);
$$;

comment on function public.can_host_events() is
  'Connectors and admins, provided their profile is active.';

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------

create table public.events (
  id          uuid primary key default gen_random_uuid(),
  host_id     uuid not null references public.profiles (id) on delete cascade,
  title       varchar not null,
  description text,
  location    varchar,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  cover_path  text,
  created_at  timestamptz not null default now(),

  constraint events_title_length check (length(btrim(title)) between 1 and 200),
  constraint events_description_length check (description is null or length(description) <= 5000),
  constraint events_time_sane check (ends_at is null or ends_at >= starts_at)
);

create index events_starts_idx on public.events (starts_at);
create index events_host_idx   on public.events (host_id);

-- ---------------------------------------------------------------------------
-- event_invitations
--
-- One row per person per event, carrying both directions: a host's
-- invitation starts at 'invited', and somebody RSVPing for themselves writes
-- 'going' or 'declined' straight in. The composite primary key means a
-- second RSVP updates rather than duplicates.
-- ---------------------------------------------------------------------------

create table public.event_invitations (
  event_id     uuid not null references public.events (id) on delete cascade,
  profile_id   uuid not null references public.profiles (id) on delete cascade,
  status       rsvp_status not null default 'invited',
  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  primary key (event_id, profile_id)
);

create index event_invitations_profile_idx on public.event_invitations (profile_id);

-- ---------------------------------------------------------------------------
-- posts.event_id — the same row is a feed post and a note on the event page
--
-- Added here rather than in the social migration because events did not
-- exist yet. One nullable column is the whole of "posts about the events".
-- ---------------------------------------------------------------------------

alter table public.posts
  add column event_id uuid references public.events (id) on delete cascade;

create index posts_event_idx on public.posts (event_id) where event_id is not null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.events             enable row level security;
alter table public.event_invitations  enable row level security;

create policy events_select on public.events for select to authenticated
using (public.is_member());

create policy events_insert on public.events for insert to authenticated
with check (public.can_host_events() and host_id = auth.uid());

create policy events_update on public.events for update to authenticated
using (host_id = auth.uid() or public.is_admin())
with check (host_id = auth.uid() or public.is_admin());

create policy events_delete on public.events for delete to authenticated
using (host_id = auth.uid() or public.is_admin());

create policy event_invitations_select on public.event_invitations for select to authenticated
using (public.is_member());

-- Either you are answering for yourself, or you are the host adding somebody
-- to the list.
create policy event_invitations_insert on public.event_invitations for insert to authenticated
with check (
  public.can_post()
  and (
    profile_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.events e
      where e.id = public.event_invitations.event_id and e.host_id = auth.uid()
    )
  )
);

-- Changing your own answer. The row is keyed on (event_id, profile_id), so
-- the worst this permits is moving your own RSVP between events — which is
-- something anyone may do anyway by RSVPing directly.
create policy event_invitations_update on public.event_invitations for update to authenticated
using (profile_id = auth.uid())
with check (profile_id = auth.uid());

create policy event_invitations_delete on public.event_invitations for delete to authenticated
using (
  profile_id = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from public.events e
    where e.id = public.event_invitations.event_id and e.host_id = auth.uid()
  )
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create trigger log_events
  after insert or update or delete on public.events
  for each row execute function public.log_activity('description');

create trigger log_event_invitations
  after insert or update or delete on public.event_invitations
  for each row execute function public.log_activity();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on public.events            to authenticated;
grant select, insert, update, delete on public.event_invitations to authenticated;

grant execute on function public.can_host_events() to authenticated;
