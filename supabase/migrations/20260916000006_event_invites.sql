-- ============================================================================
-- Event invites
--
-- The old event_invitations table carried two ideas in one row: the host's
-- invitation and the guest's answer, keyed on (event, person) so the second
-- overwrote the first. That was right when an invitation was a nudge and an
-- RSVP was free. It is wrong now that a place is a registration, sometimes
-- paid, and an invitation is an email that either went out or did not.
--
-- So the two ideas separate. event_registrations holds the answer;
-- event_invites holds the asking. The old table is kept and deprecated rather
-- than dropped: it has live rows, and 20260916000009 carries them forward.
--
-- ORG-08A. via_connector_id records which community made this person
-- reachable, because "why did I get this" is the first thing anybody asks of
-- an invitation from a name they half recognise.
--
-- ORG-08B. A resend is a new row pointing at the first, never an edit of it.
-- The partial unique index therefore covers only original invitations: one
-- first ask per person, and as many deliberate follow-ups as the host is
-- willing to send, each with its own send status and its own timestamp.
-- ============================================================================

create table public.event_invites (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references public.events (id)     on delete cascade,
  profile_id       uuid not null references public.profiles (id)   on delete cascade,
  invited_by       uuid not null references public.profiles (id)   on delete cascade,
  via_connector_id uuid references public.connectors (id)          on delete set null,
  message          text,
  send_status      text not null default 'queued',
  resend_of        uuid references public.event_invites (id)       on delete set null,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),

  constraint event_invites_status_known check (send_status in ('queued', 'sent', 'failed')),
  constraint event_invites_message_length check (message is null or length(message) <= 2000)
);

create unique index event_invites_first_ask_key
  on public.event_invites (event_id, profile_id)
  where resend_of is null;

create index event_invites_event_idx   on public.event_invites (event_id, created_at desc);
create index event_invites_profile_idx on public.event_invites (profile_id, created_at desc);

comment on table public.event_invites is
  'ORG-08A/B. A host asking somebody to come. One first ask per person per event; a resend is a new row pointing at the original.';
comment on column public.event_invites.via_connector_id is
  'ORG-08A. Which community made this person reachable — the answer to "why did I get this".';
comment on column public.event_invites.resend_of is
  'ORG-08B. Set when this row is a deliberate follow-up to an earlier invitation, so a resend is a fact rather than an overwrite.';

-- ---------------------------------------------------------------------------
-- Who a host may invite — ORG-08A
--
-- "The organizer cannot invite people from another connector's community
-- merely because they can create an event." Hosting an event and being able
-- to reach a particular person are two separate permissions, and the second
-- one does not follow from the first.
--
-- An admin may invite anybody: they manage every community. A connector may
-- invite the people who joined on their code — connector_user_links is
-- exactly that relationship, already maintained by redeem_code — and nobody
-- else. A connector-host looking at a member of somebody else's circle is
-- refused here rather than in the browser, because a guest list is a list of
-- people and the request to add one is a single HTTP call.
--
-- ponytail: one community per connector, which is what connector_user_links
-- models today. If a connector ever manages several, this is the one function
-- that has to learn about it.
-- ---------------------------------------------------------------------------

create or replace function public.may_invite_to_event(p_event uuid, p_profile uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select (public.hosts_event(p_event) or public.is_admin())
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
  'ORG-08A. Whether the caller may invite that person to that event: a host of the event, and either an admin or the connector whose community they belong to.';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- An invitation is readable by the person invited — it is about them — and by
-- the hosts, who need the list. Only a host writes one, and invited_by is
-- pinned to the caller so an invitation cannot be sent in somebody else's
-- name.
--
-- send_status is moved by the mailer on the service role, which is outside RLS
-- entirely. The update policy exists so a host can retry a failed invitation
-- from the dashboard.
-- ---------------------------------------------------------------------------

alter table public.event_invites enable row level security;

create policy event_invites_select on public.event_invites for select to authenticated
using (profile_id = auth.uid() or public.hosts_event(event_id) or public.is_admin());

create policy event_invites_insert on public.event_invites for insert to authenticated
with check (
  public.can_post()
  and public.may_invite_to_event(event_id, profile_id)
  and invited_by = auth.uid()
);

create policy event_invites_update on public.event_invites for update to authenticated
using (public.hosts_event(event_id) or public.is_admin())
with check (public.hosts_event(event_id) or public.is_admin());

create policy event_invites_delete on public.event_invites for delete to authenticated
using (public.hosts_event(event_id) or public.is_admin());

-- ---------------------------------------------------------------------------
-- Audit and grants
--
-- The personal message is skipped: it is free text written to one person, and
-- copying it into the audit trail gives it a second, longer-lived home nobody
-- asked for.
-- ---------------------------------------------------------------------------

create trigger log_event_invites
  after insert or update or delete on public.event_invites
  for each row execute function public.log_activity('message');

grant select, insert, update, delete on public.event_invites to authenticated;

grant execute on function public.may_invite_to_event(uuid, uuid) to authenticated;
