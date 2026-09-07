-- ============================================================================
-- Tagging people in posts and comments
--
-- The ids are stored, not inferred. Parsing "@Elena Vasquez" out of the body
-- at render time would break the moment two people share a first name, or
-- somebody changes theirs, and it would make the text the source of truth for
-- something the database should know outright.
--
-- So the body keeps the readable text and this column keeps who was meant.
-- Rendering matches one against the other, which means a mention survives a
-- rename and never guesses.
--
-- A plain uuid[] rather than a join table: there is nothing to store about a
-- mention beyond who, nothing to query it by on its own, and the array
-- travels with the row that contains it. A post_mentions table would be a
-- second thing to keep in step for no gain. Revisit if mentions ever need to
-- be notified, read-receipted or counted independently.
-- ============================================================================

alter table public.posts
  add column mentions uuid[] not null default '{}';

alter table public.post_comments
  add column mentions uuid[] not null default '{}';

-- A ceiling, so a single post cannot name the entire network.
alter table public.posts
  add constraint posts_mentions_bounded check (array_length(mentions, 1) is null or array_length(mentions, 1) <= 20);

alter table public.post_comments
  add constraint post_comments_mentions_bounded check (array_length(mentions, 1) is null or array_length(mentions, 1) <= 20);

-- Being mentioned is worth finding later, and GIN is what answers
-- "where mentions @> array[me]" without reading every row.
create index posts_mentions_idx         on public.posts         using gin (mentions);
create index post_comments_mentions_idx on public.post_comments using gin (mentions);

comment on column public.posts.mentions is
  'Profile ids tagged in the body. The text stays readable; this says who was meant.';

-- No foreign key is possible on an array element, so a mentioned person who
-- later leaves becomes an id that resolves to nobody. Rendering already falls
-- back to plain text for an id it cannot find, which is the right outcome:
-- the sentence still reads, and the link quietly stops being one.
