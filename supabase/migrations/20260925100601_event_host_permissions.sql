-- ORG-05: being named on an event is separate from managing it.
-- Existing cohosts retain their current access; newly named hosts start without it.
alter table public.event_hosts add column can_manage boolean not null default true;
alter table public.event_hosts alter column can_manage set default false;
comment on column public.event_hosts.can_manage is
  'Explicit event-only management assignment. Includes editing, guests, invitations, check-in, communications and refunds; never feedback-reading or unrelated network access.';

create or replace function public.hosts_event(p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.events e where e.id = p_event and e.host_id = auth.uid())
      or exists (select 1 from public.event_hosts h
                 where h.event_id = p_event and h.profile_id = auth.uid() and h.can_manage);
$$;

create or replace function public.set_event_host_management(
  p_event uuid, p_profile uuid, p_can_manage boolean
) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not (public.is_admin() or public.hosts_event(p_event)) then
    raise exception 'Only an administrator or event manager can change event permissions.' using errcode = '42501';
  end if;
  if p_can_manage is null then raise exception 'Choose whether this host may manage the event.'; end if;
  update public.event_hosts set can_manage = p_can_manage
   where event_id = p_event and profile_id = p_profile;
  if not found then raise exception 'That person is not a named cohost of this event.'; end if;
  -- event_hosts already has an audit trigger recording the actor and changed row.
end;
$$;
revoke all on function public.set_event_host_management(uuid,uuid,boolean) from public, anon;
grant execute on function public.set_event_host_management(uuid,uuid,boolean) to authenticated;

-- ORG-14/15: an admin's access must not depend on the original creator's role.
-- Non-admin ownership/payment reassignment remains blocked by enforce_event_lifecycle.
drop policy events_update on public.events;
create policy events_update on public.events for update to authenticated
using (public.hosts_event(id) or public.is_admin())
with check (public.is_admin() or (public.hosts_event(id) and public.may_host_events(host_id)));
