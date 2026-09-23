-- ACC-9, ADM-16. The admin allowlist is the only door to the admin role.
--
-- 1. Role is pinned on every update through the table API, admins included.
--    It used to be pinned for everyone except an admin, so any admin could
--    PATCH anybody (themselves included) to any role, and the allowlist was
--    only the first way in. Nothing legitimate updates role: every role is
--    set once, by the insert that provisions the profile (handle_new_user,
--    redeem_code, create_event_account, and the trigger below).
--
-- 2. An account created at /admin-setup before its email was allowlisted is
--    left with no profile. Adding the email to the allowlist afterwards now
--    provisions it there and then, so the next sign-in lands in /admin
--    instead of "account not provisioned" — the same thing handle_new_user
--    would have done had the row been there first.
--
--    Only a confirmed email, and only an account with no profile yet. The
--    same function runs again when an account confirms its email (or its
--    confirmed email changes), so the order of "allowlisted" and "confirmed"
--    does not matter: whichever comes second provisions. With
--    "Confirm email" off, Supabase confirms on signup, so the first person to
--    register an address holds it; that is true of handle_new_user already,
--    and is why production keeps confirmation on. A profile that already
--    exists (a member, an event account) is never converted: that would be a
--    role change, which (1) forbids.

create or replace function public.protect_profile_fields()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.role := old.role;
  if public.is_admin() then
    return new;
  end if;
  new.id             := old.id;
  new.profile_status := old.profile_status;
  new.created_at     := old.created_at;
  if coalesce(current_setting('amazing.redeeming_code', true), '') <> 'on' then
    new.network_member := old.network_member;
  end if;
  return new;
end;
$$;

create or replace function public.provision_allowlisted_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, email, profile_status)
  select u.id,
         'admin',
         coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), 'Administrator'),
         u.email,
         'active'
  from auth.users u
  where lower(u.email) = lower(new.email)
    and u.email_confirmed_at is not null
    and exists (select 1 from public.admin_allowlist a where lower(a.email) = lower(u.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.provision_allowlisted_admin() from public, anon, authenticated;

drop trigger if exists trg_provision_allowlisted_admin on public.admin_allowlist;
create trigger trg_provision_allowlisted_admin
  after insert on public.admin_allowlist
  for each row execute function public.provision_allowlisted_admin();

drop trigger if exists trg_provision_admin_on_confirm on auth.users;
create trigger trg_provision_admin_on_confirm
  after update of email_confirmed_at, email on auth.users
  for each row
  when (new.email_confirmed_at is not null
        and (old.email_confirmed_at is null or old.email is distinct from new.email))
  execute function public.provision_allowlisted_admin();
