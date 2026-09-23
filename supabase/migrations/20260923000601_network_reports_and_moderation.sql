-- ============================================================================
-- Reports reach every administrator; a circle's connector moderates its room
--
-- 1. NET-8. A raised report told only the subject's connector, and nobody at
--    all when the subject had none (an admin, or a connector). Every admin now
--    hears too, with the same 'report_raised' kind, since an admin reads and
--    resolves every report already. Never the reporter themselves, and never
--    twice to one person. The resolution branch is unchanged.
--
-- 2. NET-11. circle_messages_delete let the connector delete in their own
--    room and authors their own words. Admins can now delete in any circle,
--    the way a platform moderator can on any comparable community.
--
-- 3. NET-13. A connector's new note is private unless they choose otherwise.
--    The form now starts unticked; the column default agrees, so a note
--    written without saying is private rather than shared.
-- ============================================================================

-- 1. ------------------------------------------------------------------------

create or replace function public.notify_report()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.notifications (profile_id, kind, actor_id, report_id)
    select distinct r.profile_id, 'report_raised'::notification_kind, new.reporter_id, new.id
    from (
      -- The connector who brought the subject in.
      select c.profile_id
      from public.connector_user_links l
      join public.connectors c on c.id = l.connector_id
      where l.user_profile_id = new.subject_id
      union
      -- And every administrator.
      select p.id from public.profiles p where p.role = 'admin'
    ) r
    -- Not the person who raised it, and never the person it is about.
    where r.profile_id <> new.reporter_id
      and r.profile_id <> new.subject_id;

  elsif old.status = 'open' and new.status <> 'open' then
    insert into public.notifications (profile_id, kind, actor_id, report_id)
    values (new.reporter_id, 'report_resolved', new.resolved_by, new.id);
  end if;

  return null;
end;
$$;

-- 2. ------------------------------------------------------------------------

drop policy if exists circle_messages_delete on public.circle_messages;

create policy circle_messages_delete on public.circle_messages for delete to authenticated
using (
  author_id = auth.uid()
  or connector_id = public.my_connector_id()
  or public.is_admin()
);

-- 3. ------------------------------------------------------------------------

alter table public.connector_notes alter column is_searchable_by_admin set default false;
