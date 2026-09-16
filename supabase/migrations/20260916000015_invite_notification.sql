-- ============================================================================
-- An invitation reaches the bell as well as the inbox
--
-- ORG-08B and EML-05A both say the same thing in the same words: each selected
-- person gets an in-app notification *and* an email. event_invites was written
-- with the email path in mind and got no notification at all, so an invited
-- person heard once instead of twice.
--
-- The reason it could not be fixed from the application is the reason it is
-- correct that it could not: nothing holds an insert grant on notifications,
-- because a notification a browser could write is a notification anybody could
-- forge, and "X invited you" is exactly the sort of thing worth forging. The
-- only writers are SECURITY DEFINER triggers. So this is a trigger.
--
-- notification_kind already has 'event_invited' from 20260907000012. No enum
-- change, and therefore no need for this to be alone in its own migration.
--
-- The old notify_event_invitation() on event_invitations stays exactly where
-- it is. That table is deprecated and nothing writes to it any more, so its
-- trigger never fires; removing it would be a change with no effect and some
-- risk, which is the worst trade available.
--
-- Nothing is backfilled. 20260916000009 carried the legacy 'invited' rows
-- across before this trigger existed, which is the right outcome: those people
-- were invited months ago and told at the time, and a bell full of invitations
-- to events that have already happened is not a fix.
-- ============================================================================

create or replace function public.notify_event_invite()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_creator uuid;
begin
  -- A host does not need inviting to their own event. The old RSVP trigger
  -- filtered on exactly this and the mailer has had to restore the same filter
  -- on the email side: without it a cohost on the invite list is told both
  -- "you are hosting this" and "you are invited to this", which contradict
  -- each other and neither of which they can act on.
  if exists (
    select 1 from public.event_host_ids(new.event_id) h
     where h.profile_id = new.profile_id
  ) then
    return null;
  end if;

  -- EML-05A, the resend case.
  --
  -- A deliberate resend should reach somebody again — that is what resending
  -- is for — but not through a second bell entry that says what the first one
  -- already says. If their notification for this event is still unread, the
  -- bell is already telling them they are invited, and stacking an identical
  -- row on top of it adds no information and no urgency. The email goes either
  -- way, and the email is what actually re-nudges.
  --
  -- This is also the only thing standing between repeated clicks on "resend"
  -- and a pile of identical notices: the partial unique index on event_invites
  -- covers first asks only (`where resend_of is null`), deliberately, so that
  -- resends are possible at all — which means nothing else stops three clicks
  -- becoming three rows. EML-05A asks for both halves of that.
  --
  -- Once they have read it, a resend raises it again, which is the behaviour
  -- an organiser is asking for when they press the button.
  if exists (
    select 1 from public.notifications n
     where n.profile_id = new.profile_id
       and n.kind       = 'event_invited'
       and n.event_id   = new.event_id
       and n.read_at is null
  ) then
    return null;
  end if;

  -- ORG-08B. The invitation reads as coming from whoever created the event, so
  -- a guest sees one name rather than whichever cohost happened to click.
  select host_id into v_creator from public.events where id = new.event_id;

  insert into public.notifications (profile_id, kind, actor_id, event_id)
  values (new.profile_id, 'event_invited', v_creator, new.event_id);

  return null;
end;
$$;

comment on function public.notify_event_invite() is
  'ORG-08B, EML-05A. Puts an invitation in the recipient''s bell as well as their inbox. Skips hosts, and skips a resend while the first notice is still unread.';

create trigger trg_notify_event_invite
  after insert on public.event_invites
  for each row execute function public.notify_event_invite();
