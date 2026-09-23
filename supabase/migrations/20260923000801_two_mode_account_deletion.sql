-- ============================================================================
-- Closing an account: the account, or everything
--
-- Deleting an account has meant one thing: the auth user goes, the foreign
-- keys cascade, and the triggers from 20260916000011/22/34 guard money in
-- flight, keep orders and attendance under a pseudonym, and refuse while the
-- person hosts an event somebody else is attached to. That stays, and is now
-- called 'account'.
--
-- People asked for a second answer: take everything I put here, not just the
-- login. That is 'everything', and it is 'account' plus the rows 'account'
-- deliberately keeps under a pseudonym because they are about an event rather
-- than a person:
--
--   event_attendance   their own arrivals
--   event_feedback     answers they wrote about an event
--   peer_feedback      notes they wrote about other people (DATA-PROTECTION.md
--                      §5 asked whether these should go; in this mode they do)
--   notifications      ones their actions sent to other people
--
-- plus their registrations and tickets explicitly, before the profile goes, so
-- a host who registered for their own empty event is not refused by their own
-- place. Everything else they authored — circle messages, posts, comments,
-- likes, reports they raised, notes they wrote as a connector,
-- recommendations, profile answers, notifications to them, and events they
-- host that nobody else is attached to — already cascades in both modes.
-- Storage objects cannot be deleted from SQL (storage.protect_delete); the
-- browser removes them through the Storage API *before* calling this, and
-- 'everything' refuses while any are left, so the promise is the database's
-- and not the screen's. A connector may now remove the files of a member they
-- invited, since they may already delete that member outright.
--
-- Hosted events. Deleting a host cascades through events.host_id, and
-- 20260916000034 refused only when somebody had registered, paid or attended.
-- An event where somebody else had only been invited, was a co-host, posted
-- about it or left feedback went with its host and took those people's rows
-- with it. The guard now refuses whenever anybody but the host has anything on
-- the event, in both modes. Same for event_invites.invited_by, which cascaded:
-- an invitation the person sent somebody for an event they do not host is
-- that somebody's, so the invite now stays and forgets its sender (AdminEvent
-- already shows 'a removed account').
--
-- Never in either mode: another person's registration, ticket or order, or
-- the orders and refunds themselves. Those stay pseudonymised for seven years
-- (erasure_retention_years(), Companies Act s.388), which is what Eventbrite
-- and Stripe do too.
--
-- Decision 7: both modes also erase the person's own waitlist application,
-- matched on their confirmed auth email. Confirmed only, as in
-- claim_waitlist_answers (20260922000003): an unconfirmed address is a claim,
-- not proof, and would let somebody erase a stranger's application.
--
-- Decision 6: a connector whose circle still holds messages written by other
-- people is not deletable — the cascade from connectors would take those
-- people's words with it. Same for a connector with members, which was
-- already refused for an admin and is now refused for the connector closing
-- their own account too, since that cascade is the same one.
--
-- The functions gain a trailing defaulted parameter, so the old signatures
-- are dropped first: keeping both would make a no-argument call ambiguous.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Internal helpers. Not callable by a client.
-- ---------------------------------------------------------------------------

create or replace function public.check_deletion_scope(p_scope text)
returns void
language plpgsql immutable
as $$
begin
  if p_scope is null or p_scope not in ('account', 'everything') then
    raise exception 'Choose what to delete: just the account, or the account and everything in it.';
  end if;
end;
$$;

-- Decision 6 and the members rule, for every route that deletes a connector.
create or replace function public.guard_connector_circle(p_profile_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_connector_id uuid;
  v_count        int;
begin
  select id into v_connector_id
  from public.connectors
  where profile_id = p_profile_id
  for update;

  if v_connector_id is null then
    return;
  end if;

  select count(*) into v_count
  from public.connector_user_links
  where connector_id = v_connector_id;

  if v_count > 0 then
    raise exception
      'This connector still has % member(s). An administrator has to move them to another connector first.',
      v_count;
  end if;

  select count(*) into v_count
  from public.circle_messages
  where connector_id = v_connector_id
    and author_id <> p_profile_id;

  if v_count > 0 then
    raise exception
      'This connector''s circle still holds % message(s) written by other people, and deleting '
      'the connector would delete them too. Move the members to another connector first, then '
      'an administrator decides what happens to those messages before this account can go.',
      v_count;
  end if;
end;
$$;

-- Runs inside the caller's transaction, so a guard refusing the profile
-- delete afterwards rolls all of this back with it.
create or replace function public.erase_subject_data(p_profile_id uuid, p_scope text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.check_deletion_scope(p_scope);

  -- Decision 7, both modes.
  delete from public.waitlist_entries w
  using auth.users u
  where u.id = p_profile_id
    and u.email_confirmed_at is not null
    and lower(w.email) = lower(u.email);

  if p_scope = 'everything' then
    delete from public.event_tickets       where profile_id = p_profile_id;
    delete from public.event_registrations where profile_id = p_profile_id;
    delete from public.event_attendance    where profile_id = p_profile_id;
    delete from public.event_feedback      where author_id  = p_profile_id;
    delete from public.peer_feedback       where author_id  = p_profile_id;
    delete from public.notifications       where actor_id   = p_profile_id;

    -- The browser removed these first (removeMediaOf). If it could not, say
    -- so rather than call it everything with files still stored.
    if exists (
      select 1 from storage.objects
      where bucket_id = 'media' and (storage.foldername(name))[1] = p_profile_id::text
    ) then
      raise exception 'Uploaded photos and videos could not be removed, so nothing was deleted. Try again, or ask an administrator.';
    end if;
  end if;
end;
$$;

-- Whether anybody but p_host has something on the event. Orders count even
-- when they are p_host's own: a paid order is kept seven years whoever made
-- it, and deleting the event would delete it. A null person (somebody already
-- erased, kept under a pseudonym) is somebody else.
create or replace function public.event_involves_others(p_event_id uuid, p_host uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.event_orders        where event_id = p_event_id)
      or exists (select 1 from public.event_registrations where event_id = p_event_id and profile_id <> p_host)
      or exists (select 1 from public.event_tickets       where event_id = p_event_id and profile_id <> p_host)
      or exists (select 1 from public.event_attendance    where event_id = p_event_id and profile_id is distinct from p_host)
      or exists (select 1 from public.event_invites       where event_id = p_event_id and profile_id <> p_host)
      or exists (select 1 from public.event_invitations   where event_id = p_event_id and profile_id <> p_host)
      or exists (select 1 from public.event_hosts         where event_id = p_event_id and profile_id <> p_host)
      or exists (select 1 from public.event_feedback      where event_id = p_event_id and author_id is distinct from p_host)
      or exists (select 1 from public.peer_feedback       where event_id = p_event_id and author_id is distinct from p_host)
      or exists (select 1 from public.posts               where event_id = p_event_id and author_id <> p_host);
$$;

revoke execute on function public.check_deletion_scope(text)          from public, anon, authenticated;
revoke execute on function public.event_involves_others(uuid, uuid)   from public, anon, authenticated;
revoke execute on function public.guard_connector_circle(uuid)        from public, anon, authenticated;
revoke execute on function public.erase_subject_data(uuid, text)      from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. A notification's actor can be erased
--
-- notifications.actor_id is `on delete set null`, but protect_notification_
-- fields put old.actor_id straight back, so the foreign key's own update
-- failed and anybody who had ever liked, mentioned or messaged somebody could
-- not close their account in either mode. Nulling is the only change allowed;
-- a recipient still cannot re-point who a notification is from.
-- ---------------------------------------------------------------------------

create or replace function public.protect_notification_fields()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.id                := old.id;
  new.profile_id        := old.profile_id;
  new.kind              := old.kind;
  new.actor_id          := case when new.actor_id is null then null else old.actor_id end;
  new.post_id           := old.post_id;
  new.comment_id        := old.comment_id;
  new.event_id          := old.event_id;
  new.circle_message_id := old.circle_message_id;
  new.report_id         := old.report_id;
  new.waitlist_entry_id := old.waitlist_entry_id;
  new.created_at        := old.created_at;
  return new;
end;
$$;

-- Same shape on peer_feedback: author_id is `on delete set null`, and the
-- update trigger that marks a subject 'submitted' then tried to write a
-- feedback_subjects row with a null author, which refused the whole deletion.
-- An erased author has nothing left to mark.
create or replace function public.mark_feedback_submitted()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.author_id is null then
    return null;
  end if;

  insert into public.feedback_subjects (event_id, author_id, subject_id, outcome)
  values (new.event_id, new.author_id, new.subject_id, 'submitted')
  on conflict (event_id, author_id, subject_id)
  do update set outcome = 'submitted', updated_at = now();
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Nobody else's rows go with a host, an inviter or a member's files
-- ---------------------------------------------------------------------------

-- 20260916000034's guard, with its event test widened to event_involves_others.
create or replace function public.guard_account_closure()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_events int;
begin
  if exists (
    select 1
    from public.event_refunds r
    join public.event_orders o on o.id = r.order_id
    where o.profile_id = old.id
      and r.status in ('requested', 'processing')
  ) then
    raise exception
      'This account has a refund still in progress. It can be closed once the refund settles.';
  end if;

  select count(*) into v_events
  from public.events e
  where e.host_id = old.id
    and public.event_involves_others(e.id, old.id);

  if v_events > 0 then
    raise exception
      'This account hosts % event(s) other people are part of: they registered, paid, attended, '
      'were invited, co-host, posted about it or left feedback. Deleting the account would delete '
      'those events and their records. Reassign those events to another host first. Cancelling '
      'them does not release this: a cancelled event keeps its history.',
      v_events;
  end if;

  return old;
end;
$$;

comment on function public.guard_account_closure() is
  '§9, ORG-15. Refuses to delete a profile while a refund is in flight, or while it hosts an event anybody else is part of (event_involves_others): events.host_id cascades, so the deletion would take their records with it.';

alter table public.event_invites alter column invited_by drop not null;
alter table public.event_invites drop constraint event_invites_invited_by_fkey;
alter table public.event_invites
  add constraint event_invites_invited_by_fkey
  foreign key (invited_by) references public.profiles (id) on delete set null;

-- The same reach delete_managed_profile gives a connector: members they invited.
drop policy if exists media_delete_connector_member on storage.objects;
create policy media_delete_connector_member on storage.objects for delete to authenticated
using (
  bucket_id = 'media'
  and exists (
    select 1
    from public.connector_user_links l
    where l.connector_id = public.my_connector_id()
      and l.user_profile_id::text = (storage.foldername(name))[1]
  )
);

-- ---------------------------------------------------------------------------
-- 4. delete_my_account(p_scope)
-- ---------------------------------------------------------------------------

drop function if exists public.delete_my_account();

create function public.delete_my_account(p_scope text default 'account')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;
  perform public.check_deletion_scope(p_scope);
  perform public.guard_connector_circle(v_me);

  -- Recorded before the row disappears, since the trigger's own entry will
  -- have its actor nulled by the cascade.
  insert into public.activity_log (actor_id, action, entity, entity_id, detail)
  values (v_me, 'profiles.self_delete', 'profiles', v_me,
          jsonb_build_object('requested_at', now(), 'scope', p_scope));

  perform public.erase_subject_data(v_me, p_scope);

  delete from auth.users where id = v_me;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. delete_managed_profile(p_profile_id, p_scope)
--
-- Unchanged apart from the scope, the erasure call and the connector guard,
-- which replaces the inline member count it grew out of.
-- ---------------------------------------------------------------------------

drop function if exists public.delete_managed_profile(uuid);

create function public.delete_managed_profile(p_profile_id uuid, p_scope text default 'account')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_actor_id            uuid := auth.uid();
  v_actor_role          public.app_role;
  v_actor_connector_id  uuid;
  v_target_role         public.app_role;
begin
  if v_actor_id is null then
    raise exception 'You must be signed in to delete a profile.';
  end if;
  if p_profile_id is null then
    raise exception 'A profile is required.';
  end if;
  if p_profile_id = v_actor_id then
    raise exception 'You cannot delete your own profile.';
  end if;
  perform public.check_deletion_scope(p_scope);

  select role into v_actor_role
  from public.profiles
  where id = v_actor_id;

  if not found then
    raise exception 'Your signed-in account has no profile.';
  end if;

  select role into v_target_role
  from public.profiles
  where id = p_profile_id
  for update;

  if not found then
    raise exception 'That profile no longer exists.';
  end if;

  if v_actor_role = 'admin' then
    if v_target_role = 'admin' then
      raise exception 'Administrators cannot delete other administrator profiles.';
    end if;

    if v_target_role = 'connector' then
      perform public.guard_connector_circle(p_profile_id);
    end if;
  elsif v_actor_role = 'connector' then
    v_actor_connector_id := public.my_connector_id();

    if v_target_role <> 'user'
       or v_actor_connector_id is null
       or not exists (
         select 1
         from public.connector_user_links
         where connector_id = v_actor_connector_id
           and user_profile_id = p_profile_id
       ) then
      raise exception 'You can only delete members you invited.';
    end if;
  else
    raise exception 'You do not have permission to delete profiles.';
  end if;

  perform public.erase_subject_data(p_profile_id, p_scope);

  delete from auth.users where id = p_profile_id;

  if not found then
    raise exception 'That account no longer exists.';
  end if;

  return jsonb_build_object(
    'profile_id', p_profile_id,
    'deleted_profiles', 1,
    'scope', p_scope
  );
end;
$$;

revoke execute on function public.delete_my_account(text)            from public, anon;
revoke execute on function public.delete_managed_profile(uuid, text) from public, anon;
grant  execute on function public.delete_my_account(text)            to authenticated;
grant  execute on function public.delete_managed_profile(uuid, text) to authenticated;

comment on function public.delete_my_account(text) is
  '§9. Closes the caller''s account. ''account'' (default) erases the person and keeps orders and attendance pseudonymised; ''everything'' also deletes their attendance, feedback they wrote and notifications they caused. Both erase their own waitlist application and never touch another person''s ticket, registration or order.';
comment on function public.delete_managed_profile(uuid, text) is
  '§9. An admin deletes a non-admin, or a connector deletes a member they invited, with the same two scopes as delete_my_account(). A connector with members or with other people''s circle messages is refused.';
