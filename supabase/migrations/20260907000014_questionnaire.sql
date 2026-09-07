-- ============================================================================
-- The signup questionnaire
--
-- Implements Amaizing-Signup-Developer-Handoff.docx v1.0 (7 Sep 2026), plus
-- the four fields Zalmy's raw notes ask for that the handoff dropped: phone,
-- age range, ranked gathering preference, and where somebody travels often.
--
-- Where the two documents disagree, the handoff wins: it is later, it is
-- explicitly "recommended implementation defaults", and it is the one written
-- for a developer. The raw notes wanted a 1-10 slider for willingness to
-- travel; the handoff replaced that with four labelled options, which is a
-- better question because "7 out of 10" does not mean anything to a curator.
--
-- VISIBILITY, and how it resolves a conflict in this project.
--
-- The handoff says answers are visible to the member, admins, and their
-- assigned connector, and NOT to other members. This repo has already opened
-- profiles into a network-wide directory so the feed can name an author.
-- Both hold, because they are about different things:
--
--   profiles / member_directory   name, profession, role, avatar, interests
--                                 -> every member. The feed needs it.
--   profile_answers               everything in this migration
--                                 -> the member, their connector, admins.
--
-- Nothing here is readable by another member, in the API or by the
-- recommender, which is what the handoff's "exports, search, and AI
-- retrieval" clause requires.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The tag catalogs
--
-- Seeded once with stable ids, per the handoff: <field_key>.<slug>, where the
-- slug lowercases the label, collapses each run of non-alphanumeric characters
-- to one underscore, and trims. Generated rather than hand-typed, because 134
-- hand-written slugs is 134 chances to get one wrong.
--
-- "Freeze IDs after seeding; later label edits must not change stored IDs."
-- That is why label and id are separate columns, and why the id is the
-- primary key rather than the label.
-- ---------------------------------------------------------------------------

create table public.profile_tags (
  id       text primary key,
  field    text not null,
  label    text not null,
  position int  not null,

  constraint profile_tags_field_known check (field in (
    'current_focus', 'desired_outcomes', 'conversation_topics',
    'outside_work_interests', 'strongest_skills'
  )),
  unique (field, label)
);

create index profile_tags_field_idx on public.profile_tags (field, position);

comment on table public.profile_tags is
  'Seeded tag catalogs from the signup handoff. Ids are frozen; labels may be edited without changing them.';

-- The documented slug rule, applied once here so every id is consistent.
create or replace function public.tag_slug(p_label text)
returns text
language sql immutable
as $$
  select btrim(regexp_replace(lower(p_label), '[^a-z0-9]+', '_', 'g'), '_');
$$;

do $$
declare
  v_field  text;
  v_labels text[];
  v_label  text;
  v_pos    int;
begin
  foreach v_field in array array[
    'current_focus', 'desired_outcomes', 'conversation_topics',
    'outside_work_interests', 'strongest_skills'
  ] loop
    v_labels := case v_field

      when 'current_focus' then array[
        'Starting a business', 'Growing a business', 'Exploring a new idea',
        'Advancing my career', 'Changing careers', 'Finding a new role',
        'Building a project or product', 'Learning a new skill',
        'Finding collaborators', 'Raising funding',
        'Expanding my professional circle', 'Exploring my next move',
        'Something else']

      when 'desired_outcomes' then array[
        'Fresh perspectives', 'People who understand my challenges',
        'Potential collaborators', 'Learning from others',
        'An ongoing professional circle', 'Interesting conversations',
        'Meeting people outside my industry', 'A sense of community',
        'Sharing what I know', 'Discovering new opportunities',
        'Something else']

      when 'conversation_topics' then array[
        'Entrepreneurship', 'Small business', 'Startups',
        'Business operations', 'Leadership', 'Hiring and team building',
        'Sales', 'Marketing', 'Branding', 'Product development',
        'Technology', 'Artificial intelligence', 'Software development',
        'Data and analytics', 'Science', 'Engineering', 'Real estate',
        'Architecture and cities', 'Finance', 'Investing', 'Economics',
        'Education', 'Healthcare', 'Law and public policy', 'Social impact',
        'Sustainability', 'Retail and e-commerce', 'Hospitality',
        'Food and restaurants', 'Media and entertainment',
        'Writing and storytelling', 'Art and design', 'History',
        'Philosophy', 'Psychology', 'Culture and society',
        'Books and literature', 'Music', 'Sports', 'Travel',
        'Faith and spirituality', 'Personal growth']

      when 'outside_work_interests' then array[
        'Cooking', 'Baking', 'Dining out', 'Coffee', 'Hiking', 'Walking',
        'Running', 'Cycling', 'Gym and strength training', 'Yoga',
        'Team sports', 'Racket sports', 'Swimming', 'Outdoor adventures',
        'Travel', 'Reading', 'Writing', 'Live music', 'Playing music',
        'Film and TV', 'Theater and comedy', 'Art and museums',
        'Photography', 'Making and DIY', 'Gaming', 'Board games',
        'Volunteering', 'Family time', 'Gardening', 'Fashion and style',
        'Learning languages', 'Faith and community']

      else array[
        'Sales', 'Business development', 'Negotiation', 'Marketing',
        'Brand strategy', 'Content creation', 'Writing and editing',
        'Public speaking', 'Community building', 'Event planning',
        'Networking and introductions', 'Customer service', 'Partnerships',
        'Fundraising', 'Financial analysis', 'Accounting', 'Investing',
        'Business strategy', 'Operations', 'Project management',
        'Product management', 'People management', 'Hiring',
        'Coaching and mentoring', 'Teaching', 'Research', 'Data analysis',
        'Software development', 'AI and automation', 'UX and product design',
        'Graphic design', 'Engineering', 'Logistics', 'Legal expertise',
        'Problem solving', 'Creative thinking']
    end;

    v_pos := 0;
    foreach v_label in array v_labels loop
      v_pos := v_pos + 1;
      insert into public.profile_tags (id, field, label, position)
      values (v_field || '.' || public.tag_slug(v_label), v_field, v_label, v_pos)
      on conflict (id) do nothing;
    end loop;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The answers
--
-- One row per member rather than a row per answer. Every question is answered
-- by the same person at the same time and read together; a tall table would
-- turn one read into a pivot for no gain.
--
-- Each tag field holds the handoff's storage contract verbatim:
--   {"selected_tag_ids": [], "custom_tags": []}
-- ---------------------------------------------------------------------------

create type gathering_kind as enum ('big_events', 'intimate_dinners', 'one_on_ones');

-- A ranked list must not name the same thing twice.
create or replace function public.ranked_distinct(p gathering_kind[])
returns boolean
language sql immutable
as $fn$
  select p is null
      or cardinality(p) = (select count(distinct x) from unnest(p) x);
$fn$;

create table public.profile_answers (
  profile_id uuid primary key references public.profiles (id) on delete cascade,

  -- Tag questions. Q0 and Q3 never carry custom tags; the picker enforces it
  -- and the check below makes it true regardless of the picker.
  current_focus          jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',
  desired_outcomes       jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',
  conversation_topics    jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',
  outside_work_interests jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',
  strongest_skills       jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',

  -- "Something else" follow-ups, per the handoff.
  current_focus_details    text,
  desired_outcomes_details text,

  -- Free text. Limits are the handoff's.
  current_project           text,  -- Q1, required to finish
  background                text,  -- Q2
  room_contribution         text,  -- Q4
  current_conversation_need text,  -- Q6
  curation_notes            text,  -- Q9

  -- Location, for curating something in person.
  home_city         text,
  travel_preference text,

  -- From the raw notes, absent from the handoff.
  phone                 text,
  age_range             text,
  gathering_preference  gathering_kind[] not null default '{}',  -- ranked, best first
  travels_often         boolean,
  travel_destinations   text,

  taxonomy_version int not null default 1,
  completed_at     timestamptz,
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  constraint answers_shape check (
    jsonb_typeof(current_focus          -> 'selected_tag_ids') = 'array' and
    jsonb_typeof(desired_outcomes       -> 'selected_tag_ids') = 'array' and
    jsonb_typeof(conversation_topics    -> 'selected_tag_ids') = 'array' and
    jsonb_typeof(outside_work_interests -> 'selected_tag_ids') = 'array' and
    jsonb_typeof(strongest_skills       -> 'selected_tag_ids') = 'array'
  ),
  -- Custom tags are enabled only for Q5, Q7 and Q10.
  constraint answers_no_custom_on_q0_q3 check (
    jsonb_array_length(coalesce(current_focus    -> 'custom_tags', '[]')) = 0 and
    jsonb_array_length(coalesce(desired_outcomes -> 'custom_tags', '[]')) = 0
  ),
  constraint answers_limits check (
    jsonb_array_length(current_focus          -> 'selected_tag_ids') <= 3  and
    jsonb_array_length(desired_outcomes       -> 'selected_tag_ids') <= 3  and
    jsonb_array_length(conversation_topics    -> 'selected_tag_ids') <= 5  and
    jsonb_array_length(outside_work_interests -> 'selected_tag_ids') <= 5  and
    jsonb_array_length(strongest_skills       -> 'selected_tag_ids') <= 3
  ),
  constraint answers_text_limits check (
    length(coalesce(current_project, ''))           <= 300 and
    length(coalesce(background, ''))                <= 600 and
    length(coalesce(room_contribution, ''))         <= 300 and
    length(coalesce(current_conversation_need, '')) <= 300 and
    length(coalesce(curation_notes, ''))            <= 500 and
    length(coalesce(current_focus_details, ''))     <= 300 and
    length(coalesce(desired_outcomes_details, ''))  <= 300
  ),
  constraint answers_travel_known check (
    travel_preference is null or travel_preference in
      ('up_to_30_min', 'up_to_60_min', 'up_to_90_min', 'open_to_longer_trips')
  ),
  -- A ranking, so no repeats. Via a function because a check constraint
  -- may not contain a subquery.
  constraint answers_gathering_distinct check (public.ranked_distinct(gathering_preference))
);

comment on table public.profile_answers is
  'Signup questionnaire answers. Readable by the member, their connector and admins. Never by other members.';

create or replace function public.touch_profile_answers()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_touch_profile_answers
  before update on public.profile_answers
  for each row execute function public.touch_profile_answers();

-- ---------------------------------------------------------------------------
-- 3. Row level security
--
-- The handoff's rule, exactly: the member, their assigned connector, and
-- admins. Another member gets nothing, and so does a connector from a
-- different circle.
-- ---------------------------------------------------------------------------

alter table public.profile_answers enable row level security;
alter table public.profile_tags    enable row level security;

-- The catalogs are not personal data; anybody signed in needs them to render
-- the form.
create policy profile_tags_select on public.profile_tags for select to authenticated
using (true);

create policy profile_answers_select on public.profile_answers for select to authenticated
using (
  profile_id = auth.uid()
  or public.is_admin()
  or public.connects_to(public.profile_answers.profile_id)
);

create policy profile_answers_insert on public.profile_answers for insert to authenticated
with check (profile_id = auth.uid());

create policy profile_answers_update on public.profile_answers for update to authenticated
using (profile_id = auth.uid())
with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Audit
--
-- Metadata only. The answers are long free text about somebody's life, and
-- copying them into the log would put the most personal data in this system
-- into the one table an admin can read wholesale.
-- ---------------------------------------------------------------------------

create trigger log_profile_answers
  after insert or update or delete on public.profile_answers
  for each row execute function public.log_activity(
    'current_project', 'background', 'room_contribution',
    'current_conversation_need', 'curation_notes',
    'current_focus_details', 'desired_outcomes_details',
    'phone', 'travel_destinations', 'home_city', 'age_range'
  );

grant select                        on public.profile_tags    to authenticated;
grant select, insert, update        on public.profile_answers to authenticated;
grant execute on function public.tag_slug(text)               to authenticated;
