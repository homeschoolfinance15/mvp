-- ============================================================================
-- Waitlist applicants answer the same questions
--
-- From the handoff: "waitlist applicants use the same questionnaire without
-- inventing a connector assignment."
--
-- They have no auth account, so their answers cannot live in profile_answers,
-- which is keyed on a profile. The columns are mirrored onto the waitlist
-- entry instead, and carried across when an admin assigns them.
--
-- Note what this changes about the public form: it now collects personal
-- context from people who are not members and may never become members. Two
-- consequences worth stating:
--
--   Everything past name and email is optional. A stranger asked thirty
--   questions at the door leaves.
--
--   The insert policy still allows anonymous writes and the select policy
--   still admits only admins, so nothing here is readable by the public that
--   was not already.
-- ============================================================================

alter table public.waitlist_entries
  add column phone                  text,
  add column home_city              text,
  add column travel_preference      text,
  add column age_range              text,
  add column gathering_preference   gathering_kind[] not null default '{}',
  add column travels_often          boolean,
  add column travel_destinations    text,
  add column current_focus          jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',
  add column desired_outcomes       jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',
  add column conversation_topics    jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',
  add column outside_work_interests jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',
  add column strongest_skills       jsonb not null default '{"selected_tag_ids":[],"custom_tags":[]}',
  add column current_focus_details    text,
  add column desired_outcomes_details text,
  add column current_project           text,
  add column background                text,
  add column room_contribution         text,
  add column current_conversation_need text,
  add column curation_notes            text,
  add column taxonomy_version int not null default 1;

-- The same ceilings the member questionnaire enforces, so an applicant and a
-- member cannot end up with differently shaped answers.
alter table public.waitlist_entries
  add constraint waitlist_answer_limits check (
    jsonb_array_length(current_focus          -> 'selected_tag_ids') <= 3 and
    jsonb_array_length(desired_outcomes       -> 'selected_tag_ids') <= 3 and
    jsonb_array_length(conversation_topics    -> 'selected_tag_ids') <= 5 and
    jsonb_array_length(outside_work_interests -> 'selected_tag_ids') <= 5 and
    jsonb_array_length(strongest_skills       -> 'selected_tag_ids') <= 3
  ),
  add constraint waitlist_text_limits check (
    length(coalesce(current_project, ''))           <= 300 and
    length(coalesce(background, ''))                <= 600 and
    length(coalesce(room_contribution, ''))         <= 300 and
    length(coalesce(current_conversation_need, '')) <= 300 and
    length(coalesce(curation_notes, ''))            <= 500 and
    length(coalesce(current_focus_details, ''))     <= 300 and
    length(coalesce(desired_outcomes_details, ''))  <= 300
  ),
  add constraint waitlist_travel_known check (
    travel_preference is null or travel_preference in
      ('up_to_30_min', 'up_to_60_min', 'up_to_90_min', 'open_to_longer_trips')
  ),
  add constraint waitlist_gathering_distinct
    check (public.ranked_distinct(gathering_preference));

-- ---------------------------------------------------------------------------
-- Carry the answers across on assignment
--
-- Somebody who answered at the door should not be asked again once they are
-- let in. assign_waitlist_entry already mints the code; this stores what they
-- said so it can be copied onto their profile when they redeem it.
-- ---------------------------------------------------------------------------

create or replace function public.claim_waitlist_answers(p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_entry public.waitlist_entries%rowtype;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_entry
  from public.waitlist_entries
  where lower(email) = lower(btrim(p_email))
  limit 1;

  if not found then
    return;
  end if;

  insert into public.profile_answers (
    profile_id, current_focus, desired_outcomes, conversation_topics,
    outside_work_interests, strongest_skills, current_focus_details,
    desired_outcomes_details, current_project, background, room_contribution,
    current_conversation_need, curation_notes, home_city, travel_preference,
    phone, age_range, gathering_preference, travels_often, travel_destinations
  )
  values (
    auth.uid(), v_entry.current_focus, v_entry.desired_outcomes,
    v_entry.conversation_topics, v_entry.outside_work_interests,
    v_entry.strongest_skills, v_entry.current_focus_details,
    v_entry.desired_outcomes_details, v_entry.current_project,
    v_entry.background, v_entry.room_contribution,
    v_entry.current_conversation_need, v_entry.curation_notes,
    v_entry.home_city, v_entry.travel_preference, v_entry.phone,
    v_entry.age_range, v_entry.gathering_preference, v_entry.travels_often,
    v_entry.travel_destinations
  )
  on conflict (profile_id) do nothing;
end;
$$;

comment on function public.claim_waitlist_answers(text) is
  'Copies a waitlist applicant''s questionnaire onto their profile once they redeem a code, so nobody answers twice.';

grant execute on function public.claim_waitlist_answers(text) to authenticated;
