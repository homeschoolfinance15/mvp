-- ============================================================================
-- Profile pictures
--
-- A path into the existing private `media` bucket, not a new bucket and not a
-- new table. The storage policies written in the foundation migration already
-- say what is needed: anybody active may upload under their own uid, any
-- member may read, and the owner or an admin may delete. An avatar is just
-- another object under that same convention.
--
-- protect_profile_fields pins id, role, profile_status and created_at for
-- anyone who is not an admin; avatar_path is deliberately not pinned, so a
-- person changes their own picture the same way they change their profession.
-- ============================================================================

alter table public.profiles add column avatar_path text;

comment on column public.profiles.avatar_path is
  'Object path in the private media bucket, {uid}/{uuid}.{ext}. Null means fall back to initials.';

-- The directory is what the feed, the circle and every member card read a
-- person by, so the picture has to travel with the name. Appended at the end:
-- create or replace view can add columns but not reorder them.
create or replace view public.member_directory
with (security_invoker = off) as
select
  p.id,
  p.full_name,
  p.current_profession,
  p.role,
  p.interests,
  p.created_at,
  p.avatar_path
from public.profiles p
where public.is_member()
  and p.profile_status not in ('suspended', 'removed');
