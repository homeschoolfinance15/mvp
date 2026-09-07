-- ============================================================================
-- Platform foundation
--
-- Everything the feed, the events, the circle chat and the trust layer stand
-- on:
--   1. membership gates          who may read, who may write
--   2. profiles.interests        what someone wants to be found for
--   3. member_directory          a narrow, network-wide view of people
--   4. activity_log              an append-only record of what happened
--   5. the media bucket          private storage for images and video
--
-- Waitlist entries have no auth account, so they are excluded by
-- construction: there is nothing for them to sign in with. The gates below
-- exist for the other case — an auth user who signed up but never redeemed a
-- code, and so holds no profile row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Membership gates
--
-- Two levels, because reading and writing deserve different answers.
-- 'under_review' and 'restricted' may still look but must not speak;
-- 'suspended' and 'removed' lose both. Only 'active' writes.
-- ---------------------------------------------------------------------------

create or replace function public.is_member()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and profile_status not in ('suspended', 'removed')
  );
$$;

comment on function public.is_member() is
  'True for anyone holding a profile that has not been suspended or removed. The read gate for every shared surface.';

create or replace function public.can_post()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and profile_status = 'active'
  );
$$;

comment on function public.can_post() is
  'True only for an active profile. The write gate: posting, commenting, liking, hosting, uploading, raising a report.';

-- ---------------------------------------------------------------------------
-- 2. profiles.interests — what someone wants to be found for
--
-- protect_profile_fields pins id, role, profile_status and created_at on
-- update for anyone who is not an admin. interests is deliberately not
-- pinned, so a member edits their own.
-- ---------------------------------------------------------------------------

alter table public.profiles add column interests text[] not null default '{}';

-- ---------------------------------------------------------------------------
-- 3. member_directory
--
-- The feed needs to put a name to an author, and today profiles_select shows
-- a member only themselves and the connector who invited them. Rather than
-- tear that policy open — profiles also holds email, semantic_summary and
-- profile_status — this view exposes the columns a directory needs and
-- nothing else.
--
-- security_invoker is off deliberately: the view runs as its owner so it can
-- see past profiles_select, and carries its own gate in the WHERE clause.
-- The base-table guarantee survives untouched, which is what keeps a
-- member's email out of another member's hands.
-- ---------------------------------------------------------------------------

create view public.member_directory
with (security_invoker = off) as
select
  p.id,
  p.full_name,
  p.current_profession,
  p.role,
  p.interests,
  p.created_at
from public.profiles p
where public.is_member()
  and p.profile_status not in ('suspended', 'removed');

comment on view public.member_directory is
  'Network-wide roster: name, profession, role, interests. Email and sanction status stay behind profiles_select.';

revoke all on public.member_directory from anon, authenticated;
grant select on public.member_directory to authenticated;

-- ---------------------------------------------------------------------------
-- 4. activity_log
--
-- One append-only record of what happened, written by a trigger rather than
-- by application code, so it cannot be forgotten at a call site and still
-- catches a change made straight against the database.
--
-- Nothing may insert into it directly: there is no insert policy, and the
-- only writer is the SECURITY DEFINER trigger below.
--
-- ponytail: no retention policy. Rows are small and the network is small;
-- add a monthly partition or a sweep when the table is worth the trouble.
-- ---------------------------------------------------------------------------

create table public.activity_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid references public.profiles (id) on delete set null,
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index activity_log_created_idx on public.activity_log (created_at desc);
create index activity_log_entity_idx  on public.activity_log (entity, entity_id);
create index activity_log_actor_idx   on public.activity_log (actor_id);

comment on table public.activity_log is
  'Append-only audit trail. Written only by log_activity(); readable only by an admin.';

-- Generic row logger. Attach with the columns to leave out as trigger
-- arguments — long free text, which belongs in its own table rather than
-- duplicated into every log row:
--
--   create trigger log_x after insert or update or delete on public.x
--     for each row execute function public.log_activity('body');
--
create or replace function public.log_activity()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_skip   text[] := coalesce(tg_argv, '{}'::text[]);
  v_row    jsonb;
  v_detail jsonb;
begin
  -- NEW is null on DELETE, OLD is null on INSERT. Branching beats
  -- coalesce() here: the two are record variables, not plain values.
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  if tg_op = 'UPDATE' then
    -- Only what actually changed, as {column: {from, to}}.
    select jsonb_object_agg(o.key, jsonb_build_object('from', o.value, 'to', n.value))
      into v_detail
    from jsonb_each(to_jsonb(old)) o
    join jsonb_each(to_jsonb(new)) n using (key)
    where o.value is distinct from n.value
      and not (o.key = any (v_skip));

    -- An update that touched nothing worth recording is not an event.
    if v_detail is null then
      return null;
    end if;
  else
    select jsonb_object_agg(key, value) into v_detail
    from jsonb_each(v_row)
    where not (key = any (v_skip));
  end if;

  insert into public.activity_log (actor_id, action, entity, entity_id, detail)
  values (
    auth.uid(),
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    nullif(v_row ->> 'id', '')::uuid,
    v_detail
  );

  return null;
end;
$$;

comment on function public.log_activity() is
  'Row trigger writing one activity_log entry. Trigger arguments name columns to omit from detail.';

-- Attach to everything that already exists. The later migrations attach the
-- same trigger to what they add.
create trigger log_profiles
  after insert or update or delete on public.profiles
  for each row execute function public.log_activity('semantic_summary');

create trigger log_connectors
  after insert or update or delete on public.connectors
  for each row execute function public.log_activity();

create trigger log_invite_codes
  after insert or update or delete on public.invite_codes
  for each row execute function public.log_activity();

create trigger log_connector_invitations
  after insert or update or delete on public.connector_invitations
  for each row execute function public.log_activity();

create trigger log_connector_user_links
  after insert or update or delete on public.connector_user_links
  for each row execute function public.log_activity();

create trigger log_connector_notes
  after insert or update or delete on public.connector_notes
  for each row execute function public.log_activity('note');

create trigger log_waitlist_entries
  after insert or update or delete on public.waitlist_entries
  for each row execute function public.log_activity();

alter table public.activity_log enable row level security;

-- Readable by admins. Deliberately no insert, update or delete policy: the
-- log is append-only and written only by the definer trigger above.
create policy activity_log_select on public.activity_log for select to authenticated
using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 5. Media bucket
--
-- Private. The size and type ceilings live on the bucket, server side,
-- because the accept attribute on a file input is a convenience and not a
-- boundary.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', false, 26214400,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/quicktime'
  ]
)
on conflict (id) do update
set file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    public             = excluded.public;

-- Path convention: {auth.uid()}/{uuid}.{ext}. The first folder segment is the
-- owner, which makes ownership provable from the path and saves a table.
create policy media_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'media'
  and public.can_post()
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy media_select on storage.objects for select to authenticated
using (bucket_id = 'media' and public.is_member());

create policy media_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'media'
  and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- Narrow, per table, matching what the policies already allow. The log is
-- readable and nothing more: no insert, update or delete grant exists for it
-- anywhere, which is the other half of keeping it append-only.
grant select on public.activity_log to authenticated;

grant execute on function public.is_member() to authenticated;
grant execute on function public.can_post()  to authenticated;
