-- The questionnaire's rules, held by the database as well as the form.
--
-- QuestionnaireForm says its rules are "applied identically here and in the
-- database", and they were not: answers_limits counted only selected_tag_ids,
-- so a direct API call could store 5 picks plus 20 custom tags, a 500
-- character custom tag, or completed_at on an empty row, which lifts the
-- signup gate with no project, phone, city or travel answer.
--
-- These mirror src/lib/questionnaire.ts: tagCount() is selected + custom and
-- max applies to it; normaliseCustomTag() gives 2-50 characters; problem()
-- requires Q0, Q3 and Q5 picks plus project, phone, city and travel before
-- the first stage is done.
--
-- NOT VALID: rows written before this are left alone rather than failing the
-- migration. Every new insert and update is checked.
--
-- The same tag rules go on waitlist_entries, because claim_waitlist_answers
-- copies an entry into profile_answers: an applicant allowed more than a
-- member would make that copy fail. Completion is not mirrored there; the
-- claim never sets completed_at.

-- One tag answer: selected + custom within max, each custom tag a 2-50
-- character string. A function because a check may not contain a subquery.
create or replace function public.tag_answer_ok(p jsonb, p_max int)
returns boolean
language sql immutable
as $fn$
  select jsonb_array_length(p -> 'selected_tag_ids')
       + jsonb_array_length(coalesce(p -> 'custom_tags', '[]')) <= p_max
     and not exists (
       select 1 from jsonb_array_elements(coalesce(p -> 'custom_tags', '[]')) t
       where jsonb_typeof(t) <> 'string'
          or char_length(btrim(t #>> '{}')) not between 2 and 50
     );
$fn$;

create or replace function public.tag_answer_count(p jsonb)
returns int
language sql immutable
as $fn$
  select jsonb_array_length(p -> 'selected_tag_ids')
       + jsonb_array_length(coalesce(p -> 'custom_tags', '[]'));
$fn$;

alter table public.profile_answers
  drop constraint if exists answers_tag_rules,
  drop constraint if exists answers_completion;

alter table public.profile_answers
  add constraint answers_tag_rules check (
    public.tag_answer_ok(current_focus, 3) and
    public.tag_answer_ok(desired_outcomes, 3) and
    public.tag_answer_ok(conversation_topics, 5) and
    public.tag_answer_ok(outside_work_interests, 5) and
    public.tag_answer_ok(strongest_skills, 3)
  ) not valid,
  add constraint answers_completion check (
    completed_at is null or (
      public.tag_answer_count(current_focus) >= 1 and
      public.tag_answer_count(desired_outcomes) >= 1 and
      public.tag_answer_count(conversation_topics) >= 1 and
      btrim(coalesce(current_project, '')) <> '' and
      btrim(coalesce(phone, '')) <> '' and
      btrim(coalesce(home_city, '')) <> '' and
      travel_preference is not null
    )
  ) not valid;

alter table public.waitlist_entries
  drop constraint if exists waitlist_tag_rules;

alter table public.waitlist_entries
  add constraint waitlist_tag_rules check (
    public.tag_answer_ok(current_focus, 3) and
    public.tag_answer_ok(desired_outcomes, 3) and
    public.tag_answer_ok(conversation_topics, 5) and
    public.tag_answer_ok(outside_work_interests, 5) and
    public.tag_answer_ok(strongest_skills, 3)
  ) not valid;
