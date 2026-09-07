-- ============================================================================
-- In-platform notifications
--
-- Everything worth telling somebody about, in one place: tags, replies,
-- likes, invitations, RSVPs, new people in your circle, and the trust layer
-- moving. The same set any other network shows in a bell.
--
-- All of it written by triggers, never by the client. A notification a
-- browser could insert is a notification anybody could forge, and
-- "X mentioned you" is exactly the kind of thing worth forging.
--
-- Email is a separate decision and a later one. Everything lands here first,
-- so somebody can eventually choose what also reaches their inbox without
-- losing the signal.
-- ============================================================================

create type notification_kind as enum (
  'mention',          -- tagged in a post or a comment
  'comment',          -- somebody replied to your post
  'like',             -- somebody liked your post
  'event_invited',    -- a host put you on the list
  'event_rsvp',       -- somebody is coming to your event
  'circle_message',   -- your circle is talking
  'member_joined',    -- somebody joined on your code
  'report_raised',    -- a correction about one of your members
  'report_resolved',  -- what you raised was dealt with
  'recommendations'   -- new picks are waiting
);

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  -- Who is being told.
  profile_id uuid not null references public.profiles (id) on delete cascade,
  kind       notification_kind not null,
  -- Who caused it. Null once they leave; the notification still reads.
  actor_id   uuid references public.profiles (id) on delete set null,

  -- Real foreign keys rather than a polymorphic pair, so deleting the thing
  -- deletes the notice of it. A row can carry none of these: "your picks are
  -- ready" points at a screen, not at one object.
  post_id            uuid references public.posts (id)            on delete cascade,
  comment_id         uuid references public.post_comments (id)    on delete cascade,
  event_id           uuid references public.events (id)           on delete cascade,
  circle_message_id  uuid references public.circle_messages (id)  on delete cascade,
  report_id          uuid references public.profile_reports (id)  on delete cascade,

  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_unread_idx
  on public.notifications (profile_id, created_at desc)
  where read_at is null;

create index notifications_profile_idx on public.notifications (profile_id, created_at desc);

comment on table public.notifications is
  'What to tell somebody inside the platform. Written only by triggers; readable and dismissable only by its recipient.';

-- ---------------------------------------------------------------------------
-- Being tagged
--
-- One trigger serves posts and comments, which have different shapes, so the
-- row is read through jsonb. A bare new.post_id is resolved even inside a
-- branch that never runs for posts, and fails with: record "new" has no
-- field "post_id".
--
-- The enum literal is cast explicitly. Inside a SELECT DISTINCT an unknown
-- literal resolves to text before the insert sees it, and the insert then
-- refuses it.
-- ---------------------------------------------------------------------------

create or replace function public.notify_mentions()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_row     jsonb := to_jsonb(new);
  v_author  uuid  := (v_row ->> 'author_id')::uuid;
  v_post    uuid;
  v_comment uuid;
begin
  if new.mentions is null or array_length(new.mentions, 1) is null then
    return null;
  end if;

  if tg_table_name = 'posts' then
    v_post := (v_row ->> 'id')::uuid;
  else
    v_post    := (v_row ->> 'post_id')::uuid;
    v_comment := (v_row ->> 'id')::uuid;
  end if;

  insert into public.notifications (profile_id, kind, actor_id, post_id, comment_id)
  select distinct mentioned, 'mention'::notification_kind, v_author, v_post, v_comment
  from unnest(new.mentions) as mentioned
  -- Real, current people, and never yourself.
  where mentioned <> v_author
    and exists (select 1 from public.profiles p where p.id = mentioned);

  return null;
end;
$$;

create trigger notify_post_mentions
  after insert on public.posts
  for each row execute function public.notify_mentions();

create trigger notify_comment_mentions
  after insert on public.post_comments
  for each row execute function public.notify_mentions();

-- ---------------------------------------------------------------------------
-- Somebody replied to your post, or liked it
--
-- Not sent when you comment on or like your own, and a mention in the same
-- comment wins: being told twice about one comment is worse than being told
-- once.
-- ---------------------------------------------------------------------------

create or replace function public.notify_comment_on_post()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_owner uuid;
begin
  select author_id into v_owner from public.posts where id = new.post_id;
  if v_owner is null or v_owner = new.author_id then
    return null;
  end if;
  if new.mentions is not null and v_owner = any (new.mentions) then
    return null;
  end if;

  insert into public.notifications (profile_id, kind, actor_id, post_id, comment_id)
  values (v_owner, 'comment', new.author_id, new.post_id, new.id);

  return null;
end;
$$;

create trigger notify_post_replies
  after insert on public.post_comments
  for each row execute function public.notify_comment_on_post();

create or replace function public.notify_like()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_owner uuid;
begin
  select author_id into v_owner from public.posts where id = new.post_id;
  if v_owner is null or v_owner = new.profile_id then
    return null;
  end if;

  insert into public.notifications (profile_id, kind, actor_id, post_id)
  values (v_owner, 'like', new.profile_id, new.post_id);

  return null;
end;
$$;

create trigger notify_post_likes
  after insert on public.post_likes
  for each row execute function public.notify_like();

-- ---------------------------------------------------------------------------
-- Events, in both directions
--
-- The guest hears that they were invited. The host hears who is coming.
-- ---------------------------------------------------------------------------

create or replace function public.notify_event_invitation()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_host uuid;
begin
  select host_id into v_host from public.events where id = new.event_id;

  -- Somebody was put on the list by the host.
  if new.status = 'invited' and new.profile_id <> coalesce(v_host, new.profile_id) then
    insert into public.notifications (profile_id, kind, actor_id, event_id)
    values (new.profile_id, 'event_invited', v_host, new.event_id);
  end if;

  -- Somebody said they are coming, and it is news.
  if new.status = 'going'
     and v_host is not null
     and v_host <> new.profile_id
     and (tg_op = 'INSERT' or old.status is distinct from 'going') then
    insert into public.notifications (profile_id, kind, actor_id, event_id)
    values (v_host, 'event_rsvp', new.profile_id, new.event_id);
  end if;

  return null;
end;
$$;

create trigger notify_event_invitations
  after insert or update on public.event_invitations
  for each row execute function public.notify_event_invitation();

-- ---------------------------------------------------------------------------
-- Your circle is talking
--
-- Everybody in the room except the person who spoke. This is the noisiest
-- kind by design: an unread count on a conversation is what makes it a
-- conversation rather than a page you remember to visit.
-- ---------------------------------------------------------------------------

create or replace function public.notify_circle_message()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.notifications (profile_id, kind, actor_id, circle_message_id)
  select p.id, 'circle_message'::notification_kind, new.author_id, new.id
  from public.profiles p
  where p.id <> new.author_id
    and p.profile_status not in ('suspended', 'removed')
    and (
      -- The connector whose room this is.
      exists (select 1 from public.connectors c
               where c.id = new.connector_id and c.profile_id = p.id)
      -- Or anybody they invited.
      or exists (select 1 from public.connector_user_links l
                  where l.connector_id = new.connector_id and l.user_profile_id = p.id)
    );

  return null;
end;
$$;

create trigger notify_circle_messages
  after insert on public.circle_messages
  for each row execute function public.notify_circle_message();

-- ---------------------------------------------------------------------------
-- Somebody joined on your code
-- ---------------------------------------------------------------------------

create or replace function public.notify_member_joined()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_connector_profile uuid;
begin
  select profile_id into v_connector_profile
  from public.connectors where id = new.connector_id;

  if v_connector_profile is null or v_connector_profile = new.user_profile_id then
    return null;
  end if;

  insert into public.notifications (profile_id, kind, actor_id)
  values (v_connector_profile, 'member_joined', new.user_profile_id);

  return null;
end;
$$;

create trigger notify_members_joining
  after insert on public.connector_user_links
  for each row execute function public.notify_member_joined();

-- ---------------------------------------------------------------------------
-- The trust layer moving
--
-- The subject's connector hears that something was raised. The person who
-- raised it hears when it was dealt with. The subject hears nothing, which is
-- the rule the whole trust layer rests on.
-- ---------------------------------------------------------------------------

create or replace function public.notify_report()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_connector_profile uuid;
begin
  if tg_op = 'INSERT' then
    select c.profile_id into v_connector_profile
    from public.connector_user_links l
    join public.connectors c on c.id = l.connector_id
    where l.user_profile_id = new.subject_id
    limit 1;

    if v_connector_profile is not null and v_connector_profile <> new.reporter_id then
      insert into public.notifications (profile_id, kind, actor_id, report_id)
      values (v_connector_profile, 'report_raised', new.reporter_id, new.id);
    end if;

  elsif old.status = 'open' and new.status <> 'open' then
    insert into public.notifications (profile_id, kind, actor_id, report_id)
    values (new.reporter_id, 'report_resolved', new.resolved_by, new.id);
  end if;

  return null;
end;
$$;

create trigger notify_reports
  after insert or update on public.profile_reports
  for each row execute function public.notify_report();

-- ---------------------------------------------------------------------------
-- New picks are waiting
--
-- A batch writes several rows at once and is one piece of news, so this only
-- fires when there is not already an unread one waiting.
-- ---------------------------------------------------------------------------

create or replace function public.notify_recommendations()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (
    select 1 from public.notifications n
    where n.profile_id = new.profile_id
      and n.kind = 'recommendations'
      and n.read_at is null
  ) then
    return null;
  end if;

  insert into public.notifications (profile_id, kind)
  values (new.profile_id, 'recommendations');

  return null;
end;
$$;

create trigger notify_new_recommendations
  after insert on public.recommendations
  for each row execute function public.notify_recommendations();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Yours alone. No insert policy and no insert grant: the definer triggers
-- above are the only writers, so nobody can tell somebody something happened
-- when it did not.
-- ---------------------------------------------------------------------------

alter table public.notifications enable row level security;

create policy notifications_select on public.notifications for select to authenticated
using (profile_id = auth.uid());

create policy notifications_update on public.notifications for update to authenticated
using (profile_id = auth.uid())
with check (profile_id = auth.uid());

create policy notifications_delete on public.notifications for delete to authenticated
using (profile_id = auth.uid());

-- Everything except read_at is pinned, so marking one as read cannot be used
-- to rewrite who did what.
create or replace function public.protect_notification_fields()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.id                := old.id;
  new.profile_id        := old.profile_id;
  new.kind              := old.kind;
  new.actor_id          := old.actor_id;
  new.post_id           := old.post_id;
  new.comment_id        := old.comment_id;
  new.event_id          := old.event_id;
  new.circle_message_id := old.circle_message_id;
  new.report_id         := old.report_id;
  new.created_at        := old.created_at;
  return new;
end;
$$;

create trigger trg_protect_notification_fields
  before update on public.notifications
  for each row execute function public.protect_notification_fields();

-- Clearing the lot in one go.
create or replace function public.mark_notifications_read()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_count int;
begin
  update public.notifications
  set read_at = now()
  where profile_id = auth.uid() and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit
--
-- Not logged. A notification is a derived fact: whatever caused it is already
-- recorded, and logging every one would bury the trail in noise.
-- ---------------------------------------------------------------------------

grant select, update, delete on public.notifications to authenticated;
grant execute on function public.mark_notifications_read() to authenticated;
