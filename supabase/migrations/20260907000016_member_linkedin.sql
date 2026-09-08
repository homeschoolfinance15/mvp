-- ============================================================================
-- LinkedIn on a member's profile
--
-- The raw signup notes list it among the account fields, alongside name,
-- email, phone and photograph, and the handoff says to keep "the existing
-- name, email, LinkedIn ... flows". Waitlist entries have carried a LinkedIn
-- URL since the first migration; a member who joins by invitation code never
-- had anywhere to put one.
--
-- On profiles rather than profile_answers because it is identity, not
-- curation context: it belongs with the name and the photograph, and it is
-- the one link a connector reaches for when deciding whether to invite
-- somebody.
--
-- Not added to member_directory. Another member seeing your LinkedIn is a
-- separate decision from another member seeing your name, and the handoff's
-- default is that anything beyond the basics stays with the member, their
-- connector and admins.
-- ============================================================================

alter table public.profiles add column linkedin_url varchar;

comment on column public.profiles.linkedin_url is
  'Optional. Visible to the member, their connector and admins, in the same way as email.';

-- Carried across when a waitlist applicant redeems their code, alongside the
-- questionnaire answers.
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

  -- The link they gave at the door, if they have not since added one.
  update public.profiles
  set linkedin_url = coalesce(linkedin_url, v_entry.linkedin_url)
  where id = auth.uid();
end;
$$;
