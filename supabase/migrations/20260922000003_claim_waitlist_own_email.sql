-- ============================================================================
-- Only your own waitlist answers (ADM-1, SEC-1)
--
-- claim_waitlist_answers matched on whatever email the caller passed, so any
-- signed-in account, a self-serve event account included, could copy a
-- stranger's phone, city, curation notes and LinkedIn onto its own profile.
--
-- It now ignores p_email. An entry is the caller's when either:
--   * its email is the caller's own confirmed auth email, or
--   * its assigned code (single-use, minted by assign_waitlist_entry) is the
--     one this account redeemed, which covers an applicant who signed up with
--     a different address from the one they gave at the door.
-- Local config.toml has enable_confirmations = false; GoTrue then stamps
-- email_confirmed_at at signup, so the confirmed check holds in both setups.
--
-- The parameter stays so AuthProvider's call keeps working unchanged.
--
-- Nothing is deleted here. Copies already made from someone else's entry are
-- for an operator to review, with:
--
--   select pa.profile_id, u.email as owner_email, w.id as entry_id,
--          w.email as entry_email, p.linkedin_url
--   from public.profile_answers pa
--   join auth.users u on u.id = pa.profile_id
--   join public.profiles p on p.id = pa.profile_id
--   join public.waitlist_entries w
--     on w.phone is not distinct from pa.phone
--    and w.background is not distinct from pa.background
--    and w.home_city is not distinct from pa.home_city
--   where lower(w.email) <> lower(u.email)
--     and not exists (
--       select 1 from public.connector_user_links l
--       where l.user_profile_id = pa.profile_id
--         and l.invite_code_id = w.assigned_code_id
--     );
--
-- The same shape with w.linkedin_url = p.linkedin_url finds LinkedIn copies.
-- ============================================================================

create or replace function public.claim_waitlist_answers(p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_entry public.waitlist_entries%rowtype;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select lower(email) into v_email
  from auth.users
  where id = auth.uid() and email_confirmed_at is not null;

  -- The redeemed code first: it names exactly one entry.
  select w.* into v_entry
  from public.waitlist_entries w
  join public.connector_user_links l on l.invite_code_id = w.assigned_code_id
  where l.user_profile_id = auth.uid()
  limit 1;

  if not found and v_email is not null then
    select * into v_entry
    from public.waitlist_entries
    where lower(email) = v_email
    order by created_at desc
    limit 1;
  end if;

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

comment on function public.claim_waitlist_answers(text) is
  'Copies the caller''s own waitlist questionnaire onto their profile: the entry under their confirmed auth email, or the one whose code they redeemed. p_email is ignored.';

revoke execute on function public.claim_waitlist_answers(text) from public, anon;
grant execute on function public.claim_waitlist_answers(text) to authenticated;
