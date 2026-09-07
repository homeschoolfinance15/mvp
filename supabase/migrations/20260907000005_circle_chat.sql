-- ============================================================================
-- Circle chat
--
-- Members talk to the people they actually share something with: everyone a
-- given connector brought in, plus that connector.
--
-- A circle needs no table of its own. connector_user_links already says who
-- invited whom, and a member has exactly one such row — so "their connector
-- group" is a set the database can already name. Adding a memberships table
-- would be a second copy of a fact that is already true somewhere else.
--
-- On admins: they are deliberately NOT given read access here. An admin was
-- never invited by a connector, so they belong to no circle, and this repo
-- already leans that way — an admin sees only the connector notes a
-- connector chose to share. A group conversation is at least that private.
-- If the network decides an operator should be able to read these, it is one
-- `or public.is_admin()` in the select policy, and it should be a decision
-- somebody makes on purpose rather than a default nobody noticed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Which circle am I in?
--
-- A connector is in their own. Everybody else is in the one belonging to the
-- connector who invited them. An admin is in none, and gets null.
-- ---------------------------------------------------------------------------

create or replace function public.my_circle_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select coalesce(
    public.my_connector_id(),
    (select l.connector_id
       from public.connector_user_links l
      where l.user_profile_id = auth.uid()
      limit 1)
  );
$$;

comment on function public.my_circle_id() is
  'The connector whose circle the caller belongs to: their own if they are a connector, otherwise whoever invited them. Null for admins.';

-- ---------------------------------------------------------------------------
-- circle_messages
-- ---------------------------------------------------------------------------

create table public.circle_messages (
  id           uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.connectors (id) on delete cascade,
  author_id    uuid not null references public.profiles (id) on delete cascade,
  body         text not null,
  created_at   timestamptz not null default now(),

  constraint circle_messages_body
    check (length(btrim(body)) > 0 and length(body) <= 2000)
);

create index circle_messages_circle_idx on public.circle_messages (connector_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.circle_messages enable row level security;

create policy circle_messages_select on public.circle_messages for select to authenticated
using (connector_id = public.my_circle_id());

-- Writing into your own circle, as yourself. Both halves matter: without the
-- connector_id check an active member could speak into somebody else's room.
create policy circle_messages_insert on public.circle_messages for insert to authenticated
with check (
  public.can_post()
  and author_id = auth.uid()
  and connector_id = public.my_circle_id()
);

-- Your own words, or the connector tidying their own room.
create policy circle_messages_delete on public.circle_messages for delete to authenticated
using (
  author_id = auth.uid()
  or connector_id = public.my_connector_id()
);

-- ---------------------------------------------------------------------------
-- Live updates
--
-- Supabase Realtime is already in the stack, so a chat that arrives without
-- a refresh costs one publication line rather than a polling loop. Guarded
-- because the publication exists on Supabase and not on a plain Postgres.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.circle_messages;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Audit
--
-- Metadata only. Who spoke, in which circle, when — never what was said.
-- Logging the body would hand an admin, through the log, exactly the
-- conversation the select policy above deliberately withholds.
-- ---------------------------------------------------------------------------

create trigger log_circle_messages
  after insert or update or delete on public.circle_messages
  for each row execute function public.log_activity('body');

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select, insert, delete on public.circle_messages to authenticated;

grant execute on function public.my_circle_id() to authenticated;
