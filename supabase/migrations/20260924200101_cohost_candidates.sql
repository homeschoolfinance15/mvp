-- ============================================================================
-- ORG F6. The people an organiser can add as a cohost, told apart by email.
--
-- member_directory has no email, so two connectors with the same name (and the
-- same or no profession) were indistinguishable in the cohost picker. Email is
-- the one thing that is unique per person. It is shown only to connectors and
-- admins — the people who host — and only for other connectors and admins,
-- never for members. Suspended and removed accounts are left out, as in
-- member_directory.
-- ============================================================================

create or replace function public.cohost_candidates()
returns table (id uuid, full_name text, role app_role, current_profession text, email text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_admin() or public.my_connector_id() is not null) then
    raise exception 'Only connectors and administrators can choose cohosts.'
      using errcode = '42501';
  end if;

  return query
    select p.id, p.full_name::text, p.role, p.current_profession::text, p.email::text
      from public.profiles p
     where p.role in ('connector', 'admin')
       and p.profile_status <> all (array['suspended', 'removed']::profile_status[])
     order by p.full_name, p.email;
end;
$$;

revoke execute on function public.cohost_candidates() from public, anon;
grant  execute on function public.cohost_candidates() to authenticated;
