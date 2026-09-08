-- The waitlist form on the landing page asks the questionnaire's first five
-- questions, and whoever fills it in has no account yet. The catalogs were
-- readable by `authenticated` only, so an anonymous visitor got a picker with
-- a selection count and no chips underneath it.
--
-- The catalogs are labels and sort positions, seeded by this project. They are
-- not personal data, and nothing about a member is inferable from them.

grant select on public.profile_tags to anon;

create policy profile_tags_select_anon on public.profile_tags
  for select to anon
  using (true);
