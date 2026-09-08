-- ============================================================================
-- Somebody applied at the door
--
-- The waitlist was the one arrival nobody was told about: an admin found out
-- by opening the tab and noticing the count had moved. Every other thing worth
-- knowing goes through the bell, so this does too.
--
-- The applicant has no account, so there is no actor to name. The row points
-- at the waitlist entry instead, which is admin-readable already, and dies
-- with it if the entry is ever removed.
-- ============================================================================

alter type notification_kind add value 'waitlist_joined';

alter table public.notifications
  add column waitlist_entry_id uuid references public.waitlist_entries (id) on delete cascade;

create or replace function public.notify_waitlist_joined()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Every admin, which is how is_admin() decides who may read the entry.
  insert into public.notifications (profile_id, kind, waitlist_entry_id)
  select id, 'waitlist_joined', new.id
  from public.profiles
  where role = 'admin';

  return null;
end;
$$;

create trigger notify_waitlist_entries
  after insert on public.waitlist_entries
  for each row execute function public.notify_waitlist_joined();

-- The new column is pinned like every other field: marking a notification as
-- read must not be able to repoint it at a different applicant.
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
  new.waitlist_entry_id := old.waitlist_entry_id;
  new.created_at        := old.created_at;
  return new;
end;
$$;
