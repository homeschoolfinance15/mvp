-- ============================================================================
-- The feed
--
--   posts          text and media, network-wide
--   post_likes     one row per person per post
--   post_comments  flat, no threading
--
-- Visibility is is_member(): everyone on the platform reads everything.
-- That is a deliberate widening of a network that was, until now, a set of
-- private connector circles — and it is why member_directory exists rather
-- than an open profiles_select. A member can read another member's name and
-- profession here; they still cannot read their email.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- posts
--
-- media is a jsonb array of {path, mime, kind}, not a table. There is no
-- per-asset metadata to query on yet, and one column keeps a post's contents
-- in one row.
--
-- There is deliberately no update policy: a post cannot be edited, only
-- deleted and written again. Edit history on a network where members correct
-- each other is a bigger question than an MVP should answer quietly.
-- ---------------------------------------------------------------------------

create table public.posts (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null references public.profiles (id) on delete cascade,
  body       text not null default '',
  media      jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),

  constraint posts_body_length   check (length(body) <= 5000),
  constraint posts_media_array   check (jsonb_typeof(media) = 'array'),
  constraint posts_media_bounded check (jsonb_array_length(media) <= 10),
  -- A post is text, or media, or both — never neither.
  constraint posts_not_empty
    check (length(btrim(body)) > 0 or jsonb_array_length(media) > 0)
);

create index posts_created_idx on public.posts (created_at desc);
create index posts_author_idx  on public.posts (author_id);

-- ---------------------------------------------------------------------------
-- post_likes
--
-- The composite primary key is the whole dedupe story: liking twice is a
-- primary key violation rather than something the application has to check.
-- ---------------------------------------------------------------------------

create table public.post_likes (
  post_id    uuid not null references public.posts (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, profile_id)
);

create index post_likes_profile_idx on public.post_likes (profile_id);

-- ---------------------------------------------------------------------------
-- post_comments
--
-- ponytail: flat. No parent_id, no depth. Nest them when somebody actually
-- asks for a reply to a reply.
-- ---------------------------------------------------------------------------

create table public.post_comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  author_id  uuid not null references public.profiles (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),

  constraint post_comments_body
    check (length(btrim(body)) > 0 and length(body) <= 2000)
);

create index post_comments_post_idx on public.post_comments (post_id, created_at);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.posts         enable row level security;
alter table public.post_likes    enable row level security;
alter table public.post_comments enable row level security;

create policy posts_select on public.posts for select to authenticated
using (public.is_member());

create policy posts_insert on public.posts for insert to authenticated
with check (public.can_post() and author_id = auth.uid());

-- The author, or an admin moderating. Deleting the post takes its likes and
-- comments with it through the foreign keys.
create policy posts_delete on public.posts for delete to authenticated
using (author_id = auth.uid() or public.is_admin());

create policy post_likes_select on public.post_likes for select to authenticated
using (public.is_member());

create policy post_likes_insert on public.post_likes for insert to authenticated
with check (public.can_post() and profile_id = auth.uid());

create policy post_likes_delete on public.post_likes for delete to authenticated
using (profile_id = auth.uid());

create policy post_comments_select on public.post_comments for select to authenticated
using (public.is_member());

create policy post_comments_insert on public.post_comments for insert to authenticated
with check (public.can_post() and author_id = auth.uid());

-- The comment's author, the author of the post it sits under, or an admin.
-- Letting someone clear a comment from their own post is what keeps a feed
-- habitable without routing every complaint through an administrator.
create policy post_comments_delete on public.post_comments for delete to authenticated
using (
  author_id = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from public.posts p
    where p.id = public.post_comments.post_id and p.author_id = auth.uid()
  )
);

-- ---------------------------------------------------------------------------
-- Audit
--
-- post_likes is deliberately unlogged: high volume, and a like carries no
-- forensic weight. The row itself is the record, and it is already readable.
-- ---------------------------------------------------------------------------

create trigger log_posts
  after insert or update or delete on public.posts
  for each row execute function public.log_activity('body', 'media');

create trigger log_post_comments
  after insert or update or delete on public.post_comments
  for each row execute function public.log_activity('body');

-- ---------------------------------------------------------------------------
-- Grants — narrow, matching the policies above. No update anywhere.
-- ---------------------------------------------------------------------------

grant select, insert, delete on public.posts         to authenticated;
grant select, insert, delete on public.post_likes    to authenticated;
grant select, insert, delete on public.post_comments to authenticated;
