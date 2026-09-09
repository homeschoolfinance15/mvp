-- ============================================================================
-- Co-hosts
--
-- An event was run by one person, because host_id is one column. Several
-- people run an event together, so "who hosts this" becomes a set.
--
-- events.host_id stays exactly as it is: the person who created it. It is not
-- null, every existing row already has one, and it is what takes the event
-- with it when that account closes. event_hosts holds everybody else.
--
-- The point of the shape below is that nothing else learns there are now two
-- places to look. hosts_event() is asked instead of reading host_id, and
-- every policy, trigger and screen goes through it.
--
-- Co-hosting is not a smaller privilege than hosting — a co-host edits,
-- invites and cancels — so the same people qualify: connectors and admins.
-- Letting a host name any member a co-host would be a way of handing out
-- hosting rights around can_host_events().
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Who may host, asked of somebody other than the caller
--
-- can_host_events() could only ever answer for auth.uid(), and adding a
-- co-host needs the same question asked about the person being added. One
-- definition, and can_host_events() now calls it, so the two cannot drift.
-- ---------------------------------------------------------------------------

create or replace function public.may_host_events(p_profile uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
      from public.profiles p
      left join public.connectors c on c.profile_id = p.id
     where p.id = p_profile
       and p.profile_status = 'active'
       and (p.role = 'admin' or c.id is not null)
  );
$$;

comment on function public.may_host_events(uuid) is
  'True if that profile is an active connector or admin. The one answer to "may this person host an event".';

create or replace function public.can_host_events()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.may_host_events(auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- 2. event_hosts
--
-- No update policy and no columns worth updating: you are a host of an event
-- or you are not, so the row is added or removed. Who added it is already in
-- the activity log.
-- ---------------------------------------------------------------------------

create table public.event_hosts (
  event_id   uuid not null references public.events (id)   on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, profile_id)
);

create index event_hosts_profile_idx on public.event_hosts (profile_id);

comment on table public.event_hosts is
  'Co-hosts. The creating host is events.host_id and is deliberately not repeated here.';

-- ---------------------------------------------------------------------------
-- 3. The two questions everything else asks
-- ---------------------------------------------------------------------------

create or replace function public.hosts_event(p_event uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.events e
     where e.id = p_event and e.host_id = auth.uid()
  ) or exists (
    select 1 from public.event_hosts h
     where h.event_id = p_event and h.profile_id = auth.uid()
  );
$$;

comment on function public.hosts_event(uuid) is
  'True if the caller runs that event, as its creator or as a co-host. Every host check goes through this.';

create or replace function public.event_host_ids(p_event uuid)
returns table (profile_id uuid)
language sql stable security definer set search_path = public
as $$
  select e.host_id from public.events e where e.id = p_event
  union
  select h.profile_id from public.event_hosts h where h.event_id = p_event;
$$;

comment on function public.event_host_ids(uuid) is
  'Every host of an event, creator first. Used where all of them must hear about something.';

-- ---------------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------------

alter table public.event_hosts enable row level security;

create policy event_hosts_select on public.event_hosts for select to authenticated
using (public.is_member());

-- Only a host adds a host, and only somebody who could host anyway.
-- can_post() is the caller's own gate: hosts_event() answers "do you run
-- this", never "are you still in good standing".
create policy event_hosts_insert on public.event_hosts for insert to authenticated
with check (
  public.can_post()
  and (public.hosts_event(event_id) or public.is_admin())
  and public.may_host_events(profile_id)
);

-- A host removes a co-host; anyone may step down from an event they host.
create policy event_hosts_delete on public.event_hosts for delete to authenticated
using (
  public.hosts_event(event_id)
  or public.is_admin()
  or profile_id = auth.uid()
);

-- ---------------------------------------------------------------------------
-- 5. The existing policies, rerouted through hosts_event()
--
-- Same rules as before, asked of the whole set rather than one column. The
-- extra may_host_events(host_id) on update is what stops a host handing
-- ownership to somebody who was never allowed to host.
-- ---------------------------------------------------------------------------

drop policy events_update on public.events;
create policy events_update on public.events for update to authenticated
using (public.hosts_event(id) or public.is_admin())
with check ((public.hosts_event(id) or public.is_admin()) and public.may_host_events(host_id));

drop policy events_delete on public.events;
create policy events_delete on public.events for delete to authenticated
using (public.hosts_event(id) or public.is_admin());

drop policy event_invitations_insert on public.event_invitations;
create policy event_invitations_insert on public.event_invitations for insert to authenticated
with check (
  public.can_post()
  and (
    profile_id = auth.uid()
    or public.is_admin()
    or public.hosts_event(public.event_invitations.event_id)
  )
);

drop policy event_invitations_delete on public.event_invitations;
create policy event_invitations_delete on public.event_invitations for delete to authenticated
using (
  profile_id = auth.uid()
  or public.is_admin()
  or public.hosts_event(public.event_invitations.event_id)
);

-- ---------------------------------------------------------------------------
-- 6. Notifications — every host hears, not just the creator
--
-- The invitation still reads as coming from whoever created the event, so a
-- guest sees one name rather than whichever co-host happened to click. The
-- RSVP goes to all of them, and to none of them if the person coming is
-- themselves a host.
-- ---------------------------------------------------------------------------

create or replace function public.notify_event_invitation()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_creator uuid;
  v_host    uuid;
begin
  select host_id into v_creator from public.events where id = new.event_id;

  if new.status = 'invited'
     and not exists (
       select 1 from public.event_host_ids(new.event_id) h
        where h.profile_id = new.profile_id
     )
  then
    insert into public.notifications (profile_id, kind, actor_id, event_id)
    values (new.profile_id, 'event_invited', v_creator, new.event_id);
  end if;

  if new.status = 'going'
     and (tg_op = 'INSERT' or old.status is distinct from 'going')
  then
    for v_host in select h.profile_id from public.event_host_ids(new.event_id) h loop
      if v_host <> new.profile_id then
        insert into public.notifications (profile_id, kind, actor_id, event_id)
        values (v_host, 'event_rsvp', new.profile_id, new.event_id);
      end if;
    end loop;
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Subject access — an event you co-host is still an event you host
-- ---------------------------------------------------------------------------

create or replace function public.export_my_data()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;

  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = v_me),
    'posts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.posts x where x.author_id = v_me),
    'comments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                   from public.post_comments x where x.author_id = v_me),
    'likes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.post_likes x where x.profile_id = v_me),
    'circle_messages', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                          from public.circle_messages x where x.author_id = v_me),
    'events_hosted', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                        from public.events x
                       where x.host_id = v_me
                          or exists (select 1 from public.event_hosts h
                                      where h.event_id = x.id and h.profile_id = v_me)),
    'rsvps', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.event_invitations x where x.profile_id = v_me),
    'reports_i_raised', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                           from public.profile_reports x where x.reporter_id = v_me),
    'recommendations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                          from public.recommendations x where x.profile_id = v_me),
    'my_activity', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                      from public.activity_log x where x.actor_id = v_me)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Audit and grants
-- ---------------------------------------------------------------------------

create trigger log_event_hosts
  after insert or update or delete on public.event_hosts
  for each row execute function public.log_activity();

grant select, insert, delete on public.event_hosts to authenticated;

grant execute on function public.may_host_events(uuid) to authenticated;
grant execute on function public.hosts_event(uuid)     to authenticated;
grant execute on function public.event_host_ids(uuid)  to authenticated;
