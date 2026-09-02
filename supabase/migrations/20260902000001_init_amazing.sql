-- ============================================================================
-- AMAZING — Core Network Hub
-- Initial schema: enums, tables, RLS, and the RPCs that drive invite redemption.
--
-- Tables 1-6 are the ERD exactly as designed. Tables 7-9 are additions the MVP
-- needs and are documented where they are defined.
-- ============================================================================

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type app_role as enum ('user', 'connector', 'admin');

create type profile_status as enum (
  'pending', 'active', 'under_review', 'restricted', 'suspended', 'removed'
);

create type connector_status as enum ('active', 'limited', 'paused', 'removed');

create type invite_status as enum ('active', 'disabled', 'exhausted', 'expired');

-- ---------------------------------------------------------------------------
-- 1. profiles — one row per authenticated person, any role
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  role                app_role not null default 'user',
  full_name           varchar not null,
  email               varchar,
  current_profession  varchar,
  semantic_summary    text,
  profile_status      profile_status not null default 'active',
  created_at          timestamptz not null default now()
);

create index profiles_role_idx on public.profiles (role);
create index profiles_status_idx on public.profiles (profile_status);

-- ---------------------------------------------------------------------------
-- 2. connectors — the invite-granting layer, one row per connector profile
-- ---------------------------------------------------------------------------
create table public.connectors (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null unique references public.profiles (id) on delete cascade,
  invite_status   connector_status not null default 'active',
  invite_capacity int not null default 10,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. invite_codes — codes a connector hands out to prospective members
-- ---------------------------------------------------------------------------
create table public.invite_codes (
  id           uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.connectors (id) on delete cascade,
  code         varchar not null unique,
  status       invite_status not null default 'active',
  max_uses     int not null default 1,
  use_count    int not null default 0,
  created_at   timestamptz not null default now(),
  constraint invite_codes_uses_sane check (use_count >= 0 and max_uses >= 1)
);

create index invite_codes_connector_idx on public.invite_codes (connector_id);

-- ---------------------------------------------------------------------------
-- 4. connector_user_links — provenance: which connector brought which member
-- ---------------------------------------------------------------------------
create table public.connector_user_links (
  id              uuid primary key default gen_random_uuid(),
  connector_id    uuid not null references public.connectors (id) on delete cascade,
  user_profile_id uuid not null references public.profiles (id) on delete cascade,
  invite_code_id  uuid references public.invite_codes (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (connector_id, user_profile_id)
);

create index connector_user_links_user_idx on public.connector_user_links (user_profile_id);
create index connector_user_links_connector_idx on public.connector_user_links (connector_id);

-- ---------------------------------------------------------------------------
-- 5. connector_notes — a connector's private context on someone they invited
-- ---------------------------------------------------------------------------
create table public.connector_notes (
  id                     uuid primary key default gen_random_uuid(),
  connector_id           uuid not null references public.connectors (id) on delete cascade,
  user_profile_id        uuid not null references public.profiles (id) on delete cascade,
  note_text              text not null,
  is_searchable_by_admin boolean not null default true,
  created_at             timestamptz not null default now()
);

create index connector_notes_connector_idx on public.connector_notes (connector_id);
create index connector_notes_user_idx on public.connector_notes (user_profile_id);

-- ---------------------------------------------------------------------------
-- 6. search_documents — semantic search substrate.
--    Structure is created now; the MVP writes no embeddings.
-- ---------------------------------------------------------------------------
create table public.search_documents (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  source_type varchar not null,
  content     text not null,
  embedding   extensions.vector(1536),
  updated_at  timestamptz not null default now()
);

create index search_documents_profile_idx on public.search_documents (profile_id);

-- ---------------------------------------------------------------------------
-- 7. waitlist_entries (ADDITION)
--    The public landing page collects name/email/LinkedIn from people who have
--    no auth account, so this cannot live in profiles.
-- ---------------------------------------------------------------------------
create table public.waitlist_entries (
  id           uuid primary key default gen_random_uuid(),
  full_name    varchar not null,
  email        varchar not null,
  linkedin_url varchar,
  created_at   timestamptz not null default now()
);

create unique index waitlist_entries_email_key on public.waitlist_entries (lower(email));

-- ---------------------------------------------------------------------------
-- 8. connector_invitations (ADDITION)
--    connectors.profile_id is NOT NULL, but an admin creates a connector before
--    that person has an account. This is the staging row that holds the claim
--    code until it is redeemed into a real profile + connector pair.
-- ---------------------------------------------------------------------------
create table public.connector_invitations (
  id              uuid primary key default gen_random_uuid(),
  full_name       varchar not null,
  email           varchar not null,
  invite_capacity int not null default 10,
  claim_code      varchar not null unique,
  claimed_at      timestamptz,
  claimed_by      uuid references public.profiles (id) on delete set null,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9. admin_allowlist (ADDITION)
--    Admins have no invite code. An email listed here is promoted to an admin
--    profile automatically on first signup.
-- ---------------------------------------------------------------------------
create table public.admin_allowlist (
  email      varchar primary key,
  created_at timestamptz not null default now()
);

insert into public.admin_allowlist (email) values ('moshe@valued.ventures');

-- ============================================================================
-- Helper functions.
-- These are SECURITY DEFINER so that RLS policies can call them without
-- recursing back through the policies on profiles.
-- ============================================================================

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.my_connector_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select c.id from public.connectors c where c.profile_id = auth.uid();
$$;

-- Human-friendly code: AMZ-K4T9-2XPL. Alphabet omits I/O/0/1 to avoid
-- transcription errors when a code is read aloud or written down.
create or replace function public.generate_code(p_prefix text default 'AMZ')
returns varchar
language plpgsql volatile
as $$
declare
  chars  text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  block1 text := '';
  block2 text := '';
  i      int;
begin
  for i in 1..4 loop
    block1 := block1 || substr(chars, floor(random() * length(chars))::int + 1, 1);
  end loop;
  for i in 1..4 loop
    block2 := block2 || substr(chars, floor(random() * length(chars))::int + 1, 1);
  end loop;
  return p_prefix || '-' || block1 || '-' || block2;
end;
$$;

-- Remaining invites a connector may still allocate:
-- capacity, minus people already brought in, minus uses outstanding on live codes.
create or replace function public.connector_available_capacity(p_connector_id uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select greatest(
    0,
    (select invite_capacity from public.connectors where id = p_connector_id)
    - (select count(*)::int from public.connector_user_links
       where connector_id = p_connector_id)
    - (select coalesce(sum(max_uses - use_count), 0)::int from public.invite_codes
       where connector_id = p_connector_id and status = 'active')
  );
$$;

-- ============================================================================
-- Signup triggers
-- ============================================================================

-- Allowlisted emails become admins on signup. Everyone else gets no profile
-- here; they must redeem a code (see public.redeem_code).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (
    select 1 from public.admin_allowlist
    where lower(email) = lower(new.email)
  ) then
    insert into public.profiles (id, role, full_name, email, profile_status)
    values (
      new.id,
      'admin',
      coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'Administrator'),
      new.email,
      'active'
    )
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A member must not be able to promote themselves or clear their own sanction.
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;
  new.id             := old.id;
  new.role           := old.role;
  new.profile_status := old.profile_status;
  new.created_at     := old.created_at;
  return new;
end;
$$;

create trigger trg_protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- ============================================================================
-- RPCs
-- ============================================================================

-- Called by an anonymous visitor on /join to describe a code before they
-- commit to signing up. Deliberately returns only what the join screen needs.
create or replace function public.lookup_code(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_invitation     public.connector_invitations%rowtype;
  v_code           public.invite_codes%rowtype;
  v_connector      public.connectors%rowtype;
  v_connector_name text;
begin
  if p_code is null or trim(p_code) = '' then
    return jsonb_build_object('valid', false, 'kind', 'invalid',
                              'reason', 'Enter your invitation code.');
  end if;

  select * into v_invitation
  from public.connector_invitations
  where upper(claim_code) = upper(trim(p_code));

  if found then
    if v_invitation.claimed_at is not null then
      return jsonb_build_object('valid', false, 'kind', 'connector_claim',
                                'reason', 'This claim code has already been used.');
    end if;
    return jsonb_build_object(
      'valid', true,
      'kind', 'connector_claim',
      'full_name', v_invitation.full_name,
      'email', v_invitation.email,
      'invite_capacity', v_invitation.invite_capacity
    );
  end if;

  select * into v_code
  from public.invite_codes
  where upper(code) = upper(trim(p_code));

  if found then
    select * into v_connector from public.connectors where id = v_code.connector_id;

    if v_code.status <> 'active' then
      return jsonb_build_object('valid', false, 'kind', 'user_invite',
                                'reason', 'This invitation code is no longer active.');
    end if;
    if v_code.use_count >= v_code.max_uses then
      return jsonb_build_object('valid', false, 'kind', 'user_invite',
                                'reason', 'This invitation code has been fully used.');
    end if;
    if v_connector.invite_status <> 'active' then
      return jsonb_build_object('valid', false, 'kind', 'user_invite',
                                'reason', 'This connector is not currently inviting.');
    end if;

    select p.full_name into v_connector_name
    from public.profiles p where p.id = v_connector.profile_id;

    return jsonb_build_object(
      'valid', true,
      'kind', 'user_invite',
      'connector_name', v_connector_name,
      'remaining', v_code.max_uses - v_code.use_count
    );
  end if;

  return jsonb_build_object('valid', false, 'kind', 'invalid',
                            'reason', 'We don''t recognise that code.');
end;
$$;

-- Called immediately after auth.signUp, as the freshly created user. Turns a
-- bare auth account into a real member atomically: profile, connector row or
-- provenance link, and the invite-code bookkeeping.
create or replace function public.redeem_code(p_code text, p_full_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_email        text;
  v_invitation   public.connector_invitations%rowtype;
  v_code         public.invite_codes%rowtype;
  v_connector    public.connectors%rowtype;
  v_connector_id uuid;
  v_new_code     varchar;
begin
  if v_uid is null then
    raise exception 'You must be signed in to redeem a code.';
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'This account is already set up.';
  end if;

  select email into v_email from auth.users where id = v_uid;

  -- Path A: a connector claiming the account an admin created for them.
  select * into v_invitation
  from public.connector_invitations
  where upper(claim_code) = upper(trim(p_code))
  for update;

  if found then
    if v_invitation.claimed_at is not null then
      raise exception 'This claim code has already been used.';
    end if;

    insert into public.profiles (id, role, full_name, email, profile_status)
    values (
      v_uid, 'connector',
      coalesce(nullif(trim(p_full_name), ''), v_invitation.full_name),
      v_email, 'active'
    );

    insert into public.connectors (profile_id, invite_status, invite_capacity)
    values (v_uid, 'active', v_invitation.invite_capacity)
    returning id into v_connector_id;

    loop
      v_new_code := public.generate_code('AMZ');
      exit when not exists (select 1 from public.invite_codes where code = v_new_code);
    end loop;

    insert into public.invite_codes (connector_id, code, status, max_uses, use_count)
    values (v_connector_id, v_new_code, 'active',
            greatest(v_invitation.invite_capacity, 1), 0);

    update public.connector_invitations
    set claimed_at = now(), claimed_by = v_uid
    where id = v_invitation.id;

    return jsonb_build_object('role', 'connector',
                              'connector_id', v_connector_id,
                              'invite_code', v_new_code);
  end if;

  -- Path B: a member joining on a connector's invite code.
  select * into v_code
  from public.invite_codes
  where upper(code) = upper(trim(p_code))
  for update;

  if not found then
    raise exception 'We don''t recognise that code.';
  end if;

  select * into v_connector from public.connectors where id = v_code.connector_id;

  if v_code.status <> 'active' then
    raise exception 'This invitation code is no longer active.';
  end if;
  if v_code.use_count >= v_code.max_uses then
    raise exception 'This invitation code has been fully used.';
  end if;
  if v_connector.invite_status <> 'active' then
    raise exception 'This connector is not currently inviting.';
  end if;

  insert into public.profiles (id, role, full_name, email, profile_status)
  values (v_uid, 'user', trim(p_full_name), v_email, 'active');

  insert into public.connector_user_links (connector_id, user_profile_id, invite_code_id)
  values (v_code.connector_id, v_uid, v_code.id);

  update public.invite_codes
  set use_count = use_count + 1,
      status = case
                 when use_count + 1 >= max_uses then 'exhausted'::invite_status
                 else status
               end
  where id = v_code.id;

  return jsonb_build_object('role', 'user', 'connector_id', v_code.connector_id);
end;
$$;

-- Admin creates a connector. Returns the claim code to hand over.
create or replace function public.create_connector_invitation(
  p_full_name text,
  p_email     text,
  p_capacity  int default 10
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_code varchar;
  v_id   uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can create a connector.';
  end if;
  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'A name is required.';
  end if;
  if coalesce(trim(p_email), '') = '' then
    raise exception 'An email is required.';
  end if;

  loop
    v_code := public.generate_code('AMZ');
    exit when not exists (
      select 1 from public.connector_invitations where claim_code = v_code
      union all
      select 1 from public.invite_codes where code = v_code
    );
  end loop;

  insert into public.connector_invitations
    (full_name, email, invite_capacity, claim_code, created_by)
  values
    (trim(p_full_name), lower(trim(p_email)),
     greatest(coalesce(p_capacity, 10), 1), v_code, auth.uid())
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'claim_code', v_code);
end;
$$;

-- Connector mints an additional invite code out of remaining capacity.
create or replace function public.create_invite_code(p_max_uses int default 1)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_connector_id uuid := public.my_connector_id();
  v_status       connector_status;
  v_available    int;
  v_uses         int := greatest(coalesce(p_max_uses, 1), 1);
  v_code         varchar;
  v_id           uuid;
begin
  if v_connector_id is null then
    raise exception 'Only a connector can create invitation codes.';
  end if;

  select invite_status into v_status from public.connectors where id = v_connector_id;
  if v_status <> 'active' then
    raise exception 'Your inviting privileges are currently %.', v_status;
  end if;

  v_available := public.connector_available_capacity(v_connector_id);
  if v_available <= 0 then
    raise exception 'You have no invitations left to allocate.';
  end if;
  if v_uses > v_available then
    raise exception 'You have only % invitation(s) left to allocate.', v_available;
  end if;

  loop
    v_code := public.generate_code('AMZ');
    exit when not exists (
      select 1 from public.invite_codes where code = v_code
      union all
      select 1 from public.connector_invitations where claim_code = v_code
    );
  end loop;

  insert into public.invite_codes (connector_id, code, status, max_uses, use_count)
  values (v_connector_id, v_code, 'active', v_uses, 0)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'code', v_code, 'max_uses', v_uses);
end;
$$;

-- Connector disables or re-activates one of their own codes. Disabling returns
-- its unused allocation to available capacity.
create or replace function public.set_invite_code_status(p_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_connector_id uuid := public.my_connector_id();
  v_code         public.invite_codes%rowtype;
  v_target       invite_status := p_status::invite_status;
begin
  if v_connector_id is null then
    raise exception 'Only a connector can change an invitation code.';
  end if;
  if v_target not in ('active', 'disabled') then
    raise exception 'A code can only be set to active or disabled.';
  end if;

  select * into v_code from public.invite_codes
  where id = p_id and connector_id = v_connector_id
  for update;

  if not found then
    raise exception 'That invitation code is not yours.';
  end if;
  if v_code.use_count >= v_code.max_uses then
    raise exception 'That invitation code has already been fully used.';
  end if;

  if v_target = 'active'
     and (v_code.max_uses - v_code.use_count)
         > public.connector_available_capacity(v_connector_id) then
    raise exception 'Re-activating that code would exceed your invitation capacity.';
  end if;

  update public.invite_codes set status = v_target where id = p_id;
  return jsonb_build_object('id', p_id, 'status', v_target);
end;
$$;

-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.profiles              enable row level security;
alter table public.connectors            enable row level security;
alter table public.invite_codes          enable row level security;
alter table public.connector_user_links  enable row level security;
alter table public.connector_notes       enable row level security;
alter table public.search_documents      enable row level security;
alter table public.waitlist_entries      enable row level security;
alter table public.connector_invitations enable row level security;
alter table public.admin_allowlist       enable row level security;

-- profiles: yourself, anyone you invited, whoever invited you, or everything if admin.
create policy profiles_select on public.profiles for select to authenticated
using (
  id = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from public.connector_user_links l
    where l.connector_id = public.my_connector_id()
      and l.user_profile_id = public.profiles.id
  )
  or exists (
    select 1
    from public.connector_user_links l
    join public.connectors c on c.id = l.connector_id
    where l.user_profile_id = auth.uid()
      and c.profile_id = public.profiles.id
  )
);

-- Role and status changes are stripped by trg_protect_profile_fields for non-admins.
create policy profiles_update on public.profiles for update to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

-- connectors: your own row, the connector who invited you, or everything if admin.
create policy connectors_select on public.connectors for select to authenticated
using (
  profile_id = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from public.connector_user_links l
    where l.connector_id = public.connectors.id
      and l.user_profile_id = auth.uid()
  )
);

create policy connectors_update on public.connectors for update to authenticated
using (public.is_admin()) with check (public.is_admin());

-- invite_codes: your own codes, the code you joined with, or everything if admin.
create policy invite_codes_select on public.invite_codes for select to authenticated
using (
  connector_id = public.my_connector_id()
  or public.is_admin()
  or exists (
    select 1 from public.connector_user_links l
    where l.invite_code_id = public.invite_codes.id
      and l.user_profile_id = auth.uid()
  )
);

-- connector_user_links: your own membership, your invitees, or everything if admin.
create policy connector_user_links_select on public.connector_user_links for select to authenticated
using (
  user_profile_id = auth.uid()
  or connector_id = public.my_connector_id()
  or public.is_admin()
);

-- connector_notes are a connector's private working context. The member they
-- describe cannot read them; an admin sees only those flagged as searchable.
create policy connector_notes_select on public.connector_notes for select to authenticated
using (
  connector_id = public.my_connector_id()
  or (public.is_admin() and is_searchable_by_admin)
);

create policy connector_notes_insert on public.connector_notes for insert to authenticated
with check (
  connector_id = public.my_connector_id()
  and exists (
    select 1 from public.connector_user_links l
    where l.connector_id = public.connector_notes.connector_id
      and l.user_profile_id = public.connector_notes.user_profile_id
  )
);

create policy connector_notes_update on public.connector_notes for update to authenticated
using (connector_id = public.my_connector_id())
with check (connector_id = public.my_connector_id());

create policy connector_notes_delete on public.connector_notes for delete to authenticated
using (connector_id = public.my_connector_id());

create policy search_documents_select on public.search_documents for select to authenticated
using (profile_id = auth.uid() or public.is_admin());

-- Anyone may join the waitlist; only an admin may read it.
create policy waitlist_insert on public.waitlist_entries for insert to anon, authenticated
with check (true);

create policy waitlist_select on public.waitlist_entries for select to authenticated
using (public.is_admin());

create policy connector_invitations_select on public.connector_invitations for select to authenticated
using (public.is_admin());

create policy admin_allowlist_select on public.admin_allowlist for select to authenticated
using (public.is_admin());

-- ============================================================================
-- Grants. Writes to the invite graph happen only through the RPCs above.
-- ============================================================================

grant usage on schema public to anon, authenticated;

grant select          on public.profiles              to authenticated;
grant update          on public.profiles              to authenticated;
grant select          on public.connectors            to authenticated;
grant update          on public.connectors            to authenticated;
grant select          on public.invite_codes          to authenticated;
grant select          on public.connector_user_links  to authenticated;
grant select, insert, update, delete
                      on public.connector_notes       to authenticated;
grant select          on public.search_documents      to authenticated;
grant select          on public.connector_invitations to authenticated;
grant select          on public.admin_allowlist       to authenticated;
grant insert          on public.waitlist_entries      to anon, authenticated;
grant select          on public.waitlist_entries      to authenticated;

grant execute on function public.lookup_code(text)                              to anon, authenticated;
grant execute on function public.redeem_code(text, text)                        to authenticated;
grant execute on function public.create_connector_invitation(text, text, int)   to authenticated;
grant execute on function public.create_invite_code(int)                        to authenticated;
grant execute on function public.set_invite_code_status(uuid, text)             to authenticated;
grant execute on function public.connector_available_capacity(uuid)             to authenticated;
grant execute on function public.is_admin()                                     to authenticated;
grant execute on function public.my_connector_id()                              to authenticated;
